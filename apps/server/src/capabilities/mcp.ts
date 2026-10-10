import type {
  InvocationPrincipal,
  SliceACapabilityCatalog,
} from "@ji/application/registry";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  createMcpHandler as createSdkMcpHandler,
  INVALID_PARAMS,
  isJSONRPCRequest,
  isJsonContentType,
  parseJSONRPCMessage,
  ProtocolError,
  Server,
} from "@modelcontextprotocol/server";
import type {
  AuthInfo,
  CallToolResult,
  JSONRPCRequest,
  Tool,
} from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { z } from "zod";

import { createRequestId, hasAllowedCookieOrigin } from "./auth";
import type { CookieAuthOriginPolicy, PrincipalResolver } from "./auth";
import {
  CAPABILITY_UNAVAILABLE_CODE,
  unavailableCapabilityReason,
} from "./capability-availability";
import type { CapabilityAvailabilityPolicy } from "./capability-availability";
import {
  MCP_CATALOG_CACHE_HINTS,
  sortMcpCatalogTools,
} from "./mcp-catalog-cache";
import {
  boundedMcpMetricRoute,
  boundedMcpProtocolVersion,
  measureMcpRequest,
} from "./mcp-metrics";
import type { McpMetricRecorder } from "./mcp-metrics";
import type { SliceARegistry } from "./registry-types";
import {
  invokeMcpToolCanary,
  mcpToolsFromRegistry,
  serializeRegistryJson,
} from "./rest";
import { jsonValueSchema, restJsonBodySchema } from "./transport-boundary";
import type { JsonValue } from "./transport-boundary";

const SERVER_INFO = {
  name: "catapulze-job-intelligence",
  version: "1.0.0",
} as const;

interface McpHandlerOptions extends CookieAuthOriginPolicy {
  readonly allowedHost: string;
  readonly entries: SliceACapabilityCatalog;
  readonly recordMetric?: McpMetricRecorder;
  readonly unavailableCapabilities?: CapabilityAvailabilityPolicy;
}

const principalSchema = z.object({
  kind: z.enum(["agent", "service", "user"]),
  permissions: z.instanceof(Set<string>),
  subjectId: z.string(),
});
const requestIdSchema = z.string();
const metricRequestSchema = z.object({
  method: z.string(),
  params: z
    .object({
      _meta: z.object({
        "io.modelcontextprotocol/clientCapabilities": z
          .object({})
          .passthrough(),
        "io.modelcontextprotocol/protocolVersion": z.string(),
      }),
      name: z.string().optional(),
    })
    .passthrough(),
});
const measuredResponseSchema = z
  .object({
    error: z.json().optional(),
    result: z.object({ isError: z.boolean().optional() }).optional(),
  })
  .passthrough();

interface McpHeaderErrorData {
  readonly header: "MCP-Protocol-Version";
}

const errorResponse = (
  status: number,
  code: number,
  message: string,
  data?: McpHeaderErrorData,
  responseId: string | number | null = null
): Response => {
  const error =
    data === undefined ? { code, message } : { code, data, message };
  return Response.json({ error, id: responseId, jsonrpc: "2.0" }, { status });
};

const principalFromAuthInfo = (
  authInfo: AuthInfo | undefined
): InvocationPrincipal | null => {
  const parsed = principalSchema.safeParse(authInfo?.extra?.principal);
  return parsed.success ? parsed.data : null;
};

const requestIdFromAuthInfo = (authInfo: AuthInfo | undefined): string => {
  const parsed = requestIdSchema.safeParse(authInfo?.extra?.requestId);
  return parsed.success ? parsed.data : createRequestId();
};

type RegistryInputJsonSchema =
  SliceARegistry["catalog"][number]["inputJsonSchema"];
type RegistryOutputJsonSchema =
  SliceARegistry["catalog"][number]["outputJsonSchema"];

const toMcpInputSchema = (
  schema: RegistryInputJsonSchema
): Tool["inputSchema"] => {
  if (schema.type !== "object") {
    throw new Error("MCP capability input schema must describe an object");
  }
  // The registry validates the full JSON Schema when it registers an MCP binding.
  // SAFETY: The checked object discriminator and registry validation satisfy the SDK contract.
  return schema as Tool["inputSchema"];
};

const toMcpOutputSchema = (
  schema: RegistryOutputJsonSchema
): Tool["outputSchema"] =>
  // The registry validates the full JSON Schema before exposing the MCP binding.
  // SAFETY: MCP 2026 accepts any JSON Schema root for tool output.
  schema as Tool["outputSchema"];

const metricRouteFromRequest = (
  request: JSONRPCRequest,
  headers: Headers,
  knownToolNames: ReadonlySet<string>
) => {
  const parsed = metricRequestSchema.safeParse(request);
  if (!parsed.success) {
    return boundedMcpMetricRoute("unknown", undefined, knownToolNames);
  }
  const toolName =
    parsed.data.method === "tools/call" ? parsed.data.params.name : undefined;
  const metadata = parsed.data.params._meta;
  const headersMatchBody =
    headers.get("Mcp-Method") === parsed.data.method &&
    headers.get("MCP-Protocol-Version") ===
      metadata["io.modelcontextprotocol/protocolVersion"] &&
    (parsed.data.method !== "tools/call" ||
      headers.get("Mcp-Name") === toolName);
  return headersMatchBody
    ? boundedMcpMetricRoute(parsed.data.method, toolName, knownToolNames)
    : boundedMcpMetricRoute("unknown", undefined, knownToolNames);
};

const classifyMeasuredResponse = (input: {
  readonly hasInBandError: boolean;
  readonly response: Response;
}) => {
  if (input.response.status >= 500) {
    return "server-error" as const;
  }
  if (input.response.status >= 400 || input.hasInBandError) {
    return "client-error" as const;
  }
  return "success" as const;
};

const inspectMcpResponse = async (response: Response) => {
  let hasInBandError = false;
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    try {
      const parsed = measuredResponseSchema.safeParse(
        await response.clone().json()
      );
      hasInBandError =
        parsed.success &&
        (parsed.data.error !== undefined ||
          parsed.data.result?.isError === true);
    } catch {
      // Metrics are best-effort and may never change request semantics.
    }
  }
  return { hasInBandError, response };
};

const createServer = (
  registry: SliceARegistry,
  entries: SliceACapabilityCatalog,
  unavailableCapabilities: CapabilityAvailabilityPolicy | undefined,
  authInfo?: AuthInfo
): Server => {
  const principal = principalFromAuthInfo(authInfo);
  const requestId = requestIdFromAuthInfo(authInfo);
  const server = new Server(SERVER_INFO, {
    cacheHints: MCP_CATALOG_CACHE_HINTS,
    capabilities: { tools: {} },
  });
  const authorizedTools = sortMcpCatalogTools(
    mcpToolsFromRegistry(registry, entries, unavailableCapabilities).filter(
      (tool) => principal?.permissions.has(tool.requiredPermission)
    )
  );
  // Keep authorized unavailable tools discoverable so agents can explain the
  // capability status. `tools/call` still applies the availability guard
  // below, so catalog visibility never grants execution.
  const tools = authorizedTools;

  server.setRequestHandler("tools/list", () => ({
    tools: tools.map((tool) => {
      const outputSchema = toMcpOutputSchema(tool.outputSchema);
      const annotations = tool.readOnly
        ? {
            destructiveHint: false,
            idempotentHint: true,
            readOnlyHint: true,
          }
        : { readOnlyHint: false };
      const listedTool = {
        _meta: {
          "catapulze/availability": tool.availability,
          "catapulze/effect": {
            class: tool.effect,
            grounded: tool.grounded,
          },
          "catapulze/outputSchema": tool.outputSchema,
          "catapulze/outputSchemaPolicy": "standard-json-schema",
          "catapulze/requiredPermission": tool.requiredPermission,
        },
        annotations,
        description: tool.description,
        inputSchema: toMcpInputSchema(tool.inputSchema),
        name: tool.name,
      };
      return { ...listedTool, outputSchema };
    }),
  }));
  server.setRequestHandler(
    "tools/call",
    async (request): Promise<CallToolResult> => {
      const tool = authorizedTools.find(
        (candidate) => candidate.name === request.params.name
      );
      if (!tool) {
        throw new ProtocolError(
          INVALID_PARAMS,
          `Unknown or unavailable tool: ${request.params.name}`
        );
      }
      const unavailableReason = unavailableCapabilityReason(
        unavailableCapabilities,
        request.params.name
      );
      if (unavailableReason !== undefined) {
        const result = {
          error: {
            code: CAPABILITY_UNAVAILABLE_CODE,
            message: unavailableReason,
            requestId,
          },
          ok: false,
        } as const;
        return {
          content: [{ text: JSON.stringify(result), type: "text" }],
          isError: true,
        };
      }
      const parsedArguments = restJsonBodySchema.safeParse(
        request.params.arguments ?? {}
      );
      if (!parsedArguments.success) {
        throw new ProtocolError(INVALID_PARAMS, "Invalid tool arguments");
      }
      const result = await invokeMcpToolCanary(
        registry,
        tool.name,
        parsedArguments.data,
        principal,
        requestId
      );
      if (!result.ok) {
        if (
          result.error.code === "INVALID_INPUT" ||
          result.error.code === "UNKNOWN_CAPABILITY" ||
          result.error.code === "TRANSPORT_NOT_BOUND"
        ) {
          throw new ProtocolError(INVALID_PARAMS, result.error.message);
        }
        return {
          content: [{ text: JSON.stringify(result), type: "text" }],
          isError: true,
        };
      }
      // SAFETY: The registry validated the successful value against the capability output schema.
      const serializedValue = serializeRegistryJson(result.value as JsonValue);
      const content = [
        { text: JSON.stringify(serializedValue), type: "text" as const },
      ];
      return {
        content,
        structuredContent: jsonValueSchema.parse(serializedValue),
      };
    }
  );
  return server;
};

export const createMcpHandler = (
  registry: SliceARegistry,
  resolvePrincipal: PrincipalResolver,
  options: McpHandlerOptions
) => {
  const sdkHandler = createSdkMcpHandler(
    ({ authInfo }) =>
      createServer(
        registry,
        options.entries,
        options.unavailableCapabilities,
        authInfo
      ),
    { legacy: "reject", responseMode: "json" }
  );
  const mcpApp = createMcpHonoApp({
    allowedHosts: [options.allowedHost],
    allowedOrigins: [new URL(options.allowedCookieOrigin).hostname],
    host: "0.0.0.0",
  });
  const requestIds = new WeakMap<Request, string>();

  mcpApp.all("*", async (context) => {
    const requestId = requestIds.get(context.req.raw) ?? createRequestId();
    const resolution = await resolvePrincipal(
      context.req.raw.headers,
      requestId
    );
    if (!resolution.ok) {
      return errorResponse(503, -32_603, resolution.error.message);
    }
    if (!resolution.principal) {
      return errorResponse(401, -32_003, "Authentication required");
    }
    const { principal } = resolution;
    const authInfo: AuthInfo = {
      clientId: principal.subjectId,
      extra: { principal, requestId },
      scopes: [...principal.permissions],
      token: "validated-session",
    };
    // SAFETY: The Hono adapter owns parsedBody and passes this request body to the SDK.
    const { parsedBody } = context.var as { readonly parsedBody?: unknown };
    return sdkHandler.fetch(context.req.raw, {
      authInfo,
      parsedBody,
    });
  });

  return async (context: Context): Promise<Response> => {
    const requestId = createRequestId();
    requestIds.set(context.req.raw, requestId);
    if (
      !hasAllowedCookieOrigin(
        context.req.method,
        context.req.raw.headers,
        options.allowedCookieOrigin
      )
    ) {
      return errorResponse(403, -32_003, "Request Origin is not allowed");
    }
    let parsedBody: unknown;
    if (isJsonContentType(context.req.header("Content-Type"))) {
      try {
        parsedBody = await context.req.raw.clone().json();
      } catch {
        return errorResponse(400, -32_700, "Parse error");
      }
    }

    let parsedMessage: ReturnType<typeof parseJSONRPCMessage> | undefined;
    try {
      parsedMessage = parseJSONRPCMessage(parsedBody);
    } catch {
      return mcpApp.fetch(context.req.raw);
    }
    if (!isJSONRPCRequest(parsedMessage)) {
      return mcpApp.fetch(context.req.raw);
    }
    if (context.req.header("MCP-Protocol-Version") === undefined) {
      return errorResponse(
        400,
        -32_020,
        "Required MCP routing header is missing",
        { header: "MCP-Protocol-Version" },
        parsedMessage.id
      );
    }
    const knownToolNames = new Set(
      mcpToolsFromRegistry(
        registry,
        options.entries,
        options.unavailableCapabilities
      ).map((tool) => tool.name)
    );
    const metricRoute = metricRouteFromRequest(
      parsedMessage,
      context.req.raw.headers,
      knownToolNames
    );
    const measured = await measureMcpRequest(
      {
        protocolVersion: boundedMcpProtocolVersion(
          context.req.header("MCP-Protocol-Version")
        ),
        requestId,
        route: metricRoute,
      },
      async () => {
        const response = await mcpApp.fetch(context.req.raw);
        return inspectMcpResponse(response);
      },
      {
        classifyResult: classifyMeasuredResponse,
        record: options.recordMetric,
      }
    );
    return measured.response;
  };
};
