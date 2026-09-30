import type {
  InvocationPrincipal,
  SliceACapabilityCatalog,
} from "@ji/application/registry";
import type { Context } from "hono";
import { z } from "zod";

import { isEffectServerEnabled } from "../effect/flag";
import { createRequestId, hasAllowedCookieOrigin } from "./auth";
import type { CookieAuthOriginPolicy, PrincipalResolver } from "./auth";
import {
  CAPABILITY_UNAVAILABLE_CODE,
  capabilityAvailability,
  isCapabilityExecutable,
  unavailableCapabilityReason,
} from "./capability-availability";
import type { CapabilityAvailabilityPolicy } from "./capability-availability";
import type {
  RegistryInvocationResult,
  SliceARegistry,
} from "./registry-types";
import {
  jsonValueSchema,
  pathParamsSchema,
  restJsonBodySchema,
  restQuerySchema,
} from "./transport-boundary";
import type {
  JsonValue,
  PathParams,
  RestJsonBody,
  RestQuery,
} from "./transport-boundary";

/* oxlint-disable unicorn/prefer-structured-clone -- JSON round-trip strips undefined keys before JsonValue validation. */
export const serializeRegistryJson = (
  value: RegistryInvocationResult | JsonValue
): JsonValue => jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
/* oxlint-enable unicorn/prefer-structured-clone */

const jsonResponse = (status: number, body: JsonValue): Response =>
  Response.json(body, { status });

const invocationErrorStatus = (code: string): number => {
  switch (code) {
    case "UNAUTHENTICATED": {
      return 401;
    }
    case "FORBIDDEN":
    case "TRANSPORT_NOT_BOUND": {
      return 403;
    }
    case "INVALID_INPUT":
    case "INVALID_CONTEXT": {
      return 400;
    }
    case "NOT_FOUND": {
      return 404;
    }
    default: {
      return 500;
    }
  }
};

const domainErrorStatus = (code: string): number => {
  switch (code) {
    case "NOT_FOUND": {
      return 404;
    }
    case "FORBIDDEN_FULL": {
      return 403;
    }
    case "SYNTAX_ERROR":
    case "VALIDATION_ERROR":
    case "ALREADY_ACKED":
    case "ALREADY_APPROVED":
    case "APPROVAL_EXPIRED":
    case "APPROVAL_MISMATCH":
    case "APPROVAL_NOT_FOUND": {
      return 400;
    }
    default: {
      return 500;
    }
  }
};

export interface RestRouteSpec {
  readonly capabilityId: string;
  readonly method: string;
  readonly operation: string;
  readonly pathPattern: string;
}

interface RestHandlerOptions extends CookieAuthOriginPolicy {
  readonly unavailableCapabilities?: CapabilityAvailabilityPolicy;
}

const pathParamNames = (pattern: string): readonly string[] => {
  const names: string[] = [];
  for (const segment of pattern.split("/")) {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      names.push(segment.slice(1, -1));
    }
  }
  return names;
};

const matchPath = (pattern: string, pathname: string): PathParams | null => {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (!patternPart || !pathPart) {
      return null;
    }
    if (patternPart.startsWith("{") && patternPart.endsWith("}")) {
      params[patternPart.slice(1, -1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) {
      return null;
    }
  }
  const parsed = pathParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : null;
};

/**
 * Rank REST patterns so static segments beat `{param}` siblings.
 *
 * Catalog order alone is unsafe: `GET /v1/bronnen/{id}` is registered before
 * `GET /v1/bronnen/overlap`, and `routes.find` would otherwise swallow the
 * static path as `id=overlap` (CTP-417 prod 4xx/5xx on the overlap capability).
 */
const isPathParamSegment = (segment: string): boolean =>
  segment.startsWith("{") && segment.endsWith("}");

export const restRouteSpecificity = (pattern: string): number => {
  let score = 0;
  for (const segment of pattern.split("/").filter(Boolean)) {
    // Static segments dominate; longer static paths outrank shorter ones.
    score += isPathParamSegment(segment) ? 1 : 1000;
  }
  return score;
};

const compareRestRouteSpecificity = (
  left: RestRouteSpec,
  right: RestRouteSpec
): number => {
  const bySpecificity =
    restRouteSpecificity(right.pathPattern) -
    restRouteSpecificity(left.pathPattern);
  if (bySpecificity !== 0) {
    return bySpecificity;
  }
  // Stable tie-break for equal specificity (keeps catalog-adjacent order).
  return left.operation.localeCompare(right.operation);
};

export const restRoutesFromRegistry = (
  registry: SliceARegistry
): RestRouteSpec[] =>
  registry.catalog
    .flatMap((descriptor) =>
      descriptor.bindings
        .filter((binding) => binding.transport === "rest")
        .map((binding) => {
          const [method = "GET", ...pathParts] = binding.operation.split(" ");
          return {
            capabilityId: descriptor.id,
            method,
            operation: binding.operation,
            pathPattern: pathParts.join(" "),
          };
        })
    )
    .toSorted(compareRestRouteSpecificity);

const stringFieldSchema = z.string();
const booleanFieldSchema = z.boolean();
const getAanvraagFullQuerySchema = z.union([
  booleanFieldSchema,
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

const readString = (body: RestJsonBody, key: string): string | undefined => {
  const parsed = stringFieldSchema.safeParse(body[key]);
  return parsed.success ? parsed.data : undefined;
};

const readBoolean = (body: RestJsonBody, key: string): boolean | undefined => {
  const parsed = booleanFieldSchema.safeParse(body[key]);
  return parsed.success ? parsed.data : undefined;
};

const normalizeGetAanvraagFull = (
  body: RestJsonBody
): JsonValue | undefined => {
  const value = body.full;
  const parsed = getAanvraagFullQuerySchema.safeParse(value);
  return parsed.success ? parsed.data : value;
};

const toRestJsonBody = (
  entries: readonly (readonly [string, JsonValue | undefined])[]
): RestJsonBody => {
  const body: RestJsonBody = {};
  for (const [key, value] of entries) {
    if (value !== undefined) {
      body[key] = value;
    }
  }
  return body;
};

const readSnapshotId = (raw: RestJsonBody): string | undefined =>
  readString(raw, "id") ?? readString(raw, "snapshotId");

// oxlint-disable-next-line complexity -- This closed transport adapter enumerates capability-specific path/body aliases.
const normalizeRestInput = (
  capabilityId: string,
  raw: RestJsonBody
): RestJsonBody => {
  switch (capabilityId) {
    case "get_aanvraag": {
      return toRestJsonBody([
        ["full", normalizeGetAanvraagFull(raw)],
        ["id", readString(raw, "id")],
      ]);
    }
    case "list_versies": {
      return toRestJsonBody([
        ["aanvraagId", readString(raw, "id") ?? readString(raw, "aanvraagId")],
      ]);
    }
    case "markeer_aanvraag": {
      return toRestJsonBody([
        ["aanvraagId", readString(raw, "id") ?? readString(raw, "aanvraagId")],
        ["reden", raw.reden ?? null],
        ["status", raw.status],
      ]);
    }
    case "get_markering":
    case "clear_markering": {
      return toRestJsonBody([
        ["aanvraagId", readString(raw, "id") ?? readString(raw, "aanvraagId")],
      ]);
    }
    case "update_saved_search": {
      return toRestJsonBody([
        ["filters", raw.filters],
        ["id", readString(raw, "id")],
        ["naam", readString(raw, "naam")],
        ["query", readString(raw, "query")],
      ]);
    }
    case "get_bron":
    case "get_bron_health":
    case "start_run":
    case "start_test_import": {
      return toRestJsonBody([
        ["bronId", readString(raw, "id") ?? readString(raw, "bronId")],
      ]);
    }
    case "ack_alert": {
      return toRestJsonBody([
        ["alertId", readString(raw, "id") ?? readString(raw, "alertId")],
      ]);
    }
    case "approve_snapshot":
    case "get_snapshot_approval":
    case "validate_snapshot_approval": {
      return toRestJsonBody([
        ["id", readSnapshotId(raw)],
        ["expiresAt", readString(raw, "expiresAt")],
        ["motivatie", readString(raw, "motivatie")],
      ]);
    }
    case "commit_export": {
      return toRestJsonBody([["snapshotId", readSnapshotId(raw)]]);
    }
    case "list_snapshots": {
      const limit = readString(raw, "limit");
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      return toRestJsonBody([
        ["cursor", readString(raw, "cursor")],
        [
          "limit",
          parsedLimit !== undefined && Number.isInteger(parsedLimit)
            ? parsedLimit
            : limit,
        ],
      ]);
    }
    case "get_export_status": {
      return toRestJsonBody([["snapshotId", readSnapshotId(raw)]]);
    }
    case "read_raw": {
      return toRestJsonBody([
        ["full", readBoolean(raw, "full")],
        ["ref", readString(raw, "ref") ?? readString(raw, "id")],
      ]);
    }
    default: {
      return raw;
    }
  }
};

const parseRestQuery = (url: string): RestQuery => {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const parsed = restQuerySchema.safeParse(params);
  // Prefer parsed data, but never drop keys if validation somehow fails.
  return parsed.success ? parsed.data : params;
};

const invokeRest = async (
  registry: SliceARegistry,
  route: RestRouteSpec,
  input: RestJsonBody,
  principal: InvocationPrincipal | null,
  requestId: string
): Promise<RegistryInvocationResult> => {
  // CTP-479 canary: JI_EFFECT_SERVER=1 → Effect transport boundary; default native.
  if (isEffectServerEnabled()) {
    const { invokeRestEffect } = await import("../effect/invoke-effect");
    return invokeRestEffect(registry, route, input, principal, requestId);
  }
  return registry.createInvoker({
    capabilityId: route.capabilityId,
    operation: route.operation,
    transport: "rest",
  })(input, { principal, requestId });
};

const findRestRoute = (
  routes: readonly RestRouteSpec[],
  method: string,
  pathname: string
): { route: RestRouteSpec; params: PathParams } | null => {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const params = matchPath(route.pathPattern, pathname);
    if (params !== null) {
      return { params, route };
    }
  }
  return null;
};

export const createRestCapabilityHandler =
  (
    registry: SliceARegistry,
    routes: readonly RestRouteSpec[],
    resolvePrincipal: PrincipalResolver,
    options: RestHandlerOptions
  ) =>
  async (context: Context): Promise<Response> => {
    const requestId = createRequestId();
    const routeMatch = findRestRoute(
      routes,
      context.req.method,
      context.req.path
    );
    if (!routeMatch) {
      return jsonResponse(404, { error: "Route not found" });
    }
    const { route: matched, params } = routeMatch;
    const requestHeaders = context.req.raw.headers;
    if (
      !hasAllowedCookieOrigin(
        context.req.method,
        requestHeaders,
        options.allowedCookieOrigin
      )
    ) {
      return jsonResponse(403, {
        error: {
          code: "CSRF_REJECTED",
          message: "Cookie-authenticated writes require the allowed Origin",
        },
      });
    }
    const principalResolution = await resolvePrincipal(
      requestHeaders,
      requestId
    );
    if (!principalResolution.ok) {
      return jsonResponse(503, { error: principalResolution.error });
    }
    const { principal } = principalResolution;
    if (!principal) {
      return jsonResponse(401, {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
          requestId,
        },
        ok: false,
      });
    }
    const descriptor = registry.catalog.find(
      (candidate) => candidate.id === matched.capabilityId
    );
    if (
      descriptor === undefined ||
      !principal.permissions.has(descriptor.authorization.permission)
    ) {
      return jsonResponse(403, {
        error: {
          code: "FORBIDDEN",
          message: "The principal is not allowed to invoke this capability",
          requestId,
        },
        ok: false,
      });
    }
    const unavailableReason = unavailableCapabilityReason(
      options.unavailableCapabilities,
      matched.capabilityId
    );
    if (unavailableReason !== undefined) {
      return jsonResponse(503, {
        error: {
          code: CAPABILITY_UNAVAILABLE_CODE,
          message: unavailableReason,
          requestId,
        },
        ok: false,
      });
    }
    let body: RestJsonBody = {};
    if (context.req.method === "POST" || context.req.method === "PUT") {
      try {
        const rawBody = await context.req.json();
        const parsedBody = restJsonBodySchema.safeParse(rawBody);
        body = parsedBody.success ? parsedBody.data : {};
      } catch {
        body = {};
      }
    }
    const query = parseRestQuery(context.req.url);
    const input = normalizeRestInput(matched.capabilityId, {
      ...body,
      ...params,
      ...query,
    });
    const result = await invokeRest(
      registry,
      matched,
      input,
      principal,
      requestId
    );
    if (!result.ok) {
      const status =
        "requestId" in result.error
          ? invocationErrorStatus(result.error.code)
          : domainErrorStatus(result.error.code);
      return jsonResponse(status, serializeRegistryJson(result));
    }
    // SAFETY: The registry validated this value against the capability output schema.
    return jsonResponse(200, serializeRegistryJson(result.value as JsonValue));
  };

export const invokeMcpTool = (
  registry: SliceARegistry,
  toolName: string,
  args: RestJsonBody,
  principal: InvocationPrincipal | null,
  requestId: string
): Promise<RegistryInvocationResult> =>
  registry.createInvoker({
    capabilityId: toolName,
    operation: toolName,
    transport: "mcp",
  })(args, { principal, requestId });

export const mcpToolsFromRegistry = (
  registry: SliceARegistry,
  entries: SliceACapabilityCatalog,
  unavailableCapabilities?: CapabilityAvailabilityPolicy
) => {
  const metadataById = new Map<
    string,
    SliceACapabilityCatalog[number]["metadata"]
  >(entries.map((entry) => [entry.capability.id, entry.metadata]));
  return registry.catalog.flatMap((descriptor) => {
    const metadata = metadataById.get(descriptor.id);
    if (!metadata) {
      throw new Error(`Missing MCP metadata for ${descriptor.id}`);
    }
    return descriptor.bindings
      .filter((binding) => binding.transport === "mcp")
      .map((binding) => {
        const availability = capabilityAvailability(
          unavailableCapabilities,
          descriptor.id
        );
        return {
          availability: {
            ...availability,
            executable: isCapabilityExecutable(availability),
          },
          description: descriptor.outcome,
          effect: metadata.sideEffectClass,
          grounded: descriptor.grounding,
          inputSchema: descriptor.inputJsonSchema,
          name: binding.operation,
          outputSchema: descriptor.outputJsonSchema,
          readOnly: metadata.sideEffectClass === "read",
          requiredPermission: descriptor.authorization.permission,
        };
      });
  });
};

export { matchPath, pathParamNames };

/** CTP-479 canary wrapper — Effect MCP boundary when JI_EFFECT_SERVER=1. */
export const invokeMcpToolCanary = async (
  registry: SliceARegistry,
  toolName: string,
  args: RestJsonBody,
  principal: InvocationPrincipal | null,
  requestId: string
): Promise<RegistryInvocationResult> => {
  if (isEffectServerEnabled()) {
    const { invokeMcpToolEffect } = await import("../effect/invoke-effect");
    return invokeMcpToolEffect(registry, toolName, args, principal, requestId);
  }
  return invokeMcpTool(registry, toolName, args, principal, requestId);
};
