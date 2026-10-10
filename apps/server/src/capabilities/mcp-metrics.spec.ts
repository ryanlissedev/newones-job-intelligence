import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import type { TestSliceARegistryBundle } from "@ji/application/registry";
import {
  isJSONRPCResultResponse,
  parseJSONRPCMessage,
} from "@modelcontextprotocol/client";
import type { JSONObject } from "@modelcontextprotocol/client";
import { Hono } from "hono";

import type { PrincipalResolver } from "./auth";
import { createMcpHandler } from "./mcp";
import {
  boundedMcpMetricRoute,
  boundedMcpProtocolVersion,
  measureMcpRequest,
} from "./mcp-metrics";
import type { McpRequestMetric } from "./mcp-metrics";
import { jsonValueSchema } from "./transport-boundary";
import type { JsonValue } from "./transport-boundary";

const protocolVersion = "2026-07-28";
const allowedOrigin = "https://app.catapulze.test";
const metricBearer = "Bearer metric-secret-token";

const resolveMetricPrincipal: PrincipalResolver = (headers) =>
  Promise.resolve({
    ok: true,
    principal:
      headers.get("Authorization") === metricBearer
        ? {
            kind: "agent",
            permissions: permissionsForRole("recruiter"),
            subjectId: "metric-fixture-user",
          }
        : null,
  });

const sendMetricRequest = (
  handler: ReturnType<typeof createMcpHandler>,
  input: {
    readonly arguments: JSONObject;
    readonly bodyId: string;
    readonly headerName?: string;
    readonly name: string;
  }
): Promise<Response> => {
  const app = new Hono();
  app.post("/mcp", (context) => handler(context));
  return Promise.resolve(
    app.request("/mcp", {
      body: JSON.stringify({
        id: input.bodyId,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
          },
          arguments: input.arguments,
          name: input.name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: metricBearer,
        "Content-Type": "application/json",
        Host: "server.test",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": input.headerName ?? input.name,
      },
      method: "POST",
    })
  );
};

const readJsonRpcResult = async (response: Response): Promise<JsonValue> => {
  const message = parseJSONRPCMessage(await response.json());
  if (!isJSONRPCResultResponse(message)) {
    throw new Error("Expected a JSON-RPC result response");
  }
  return jsonValueSchema.parse(message.result);
};

const createMetricHandler = (
  bundle: TestSliceARegistryBundle,
  recordMetric: (metric: McpRequestMetric) => void
) =>
  createMcpHandler(bundle.registry, resolveMetricPrincipal, {
    allowedCookieOrigin: allowedOrigin,
    allowedHost: "server.test",
    entries: bundle.entries,
    recordMetric,
  });

describe("MCP request metrics", () => {
  it("records bounded validated routing fields and keeps request id out of labels", async () => {
    const metrics: McpRequestMetric[] = [];
    const ticks = [10, 17];
    const result = await measureMcpRequest(
      {
        protocolVersion: boundedMcpProtocolVersion("2026-07-28"),
        requestId: "request-correlation-only",
        route: boundedMcpMetricRoute(
          "tools/call",
          "search_aanvragen",
          new Set(["search_aanvragen"])
        ),
      },
      () => Promise.resolve({ status: 200 }),
      {
        classifyResult: () => "success",
        now: () => ticks.shift() ?? 17,
        record: (metric) => metrics.push(metric),
      }
    );

    expect(result.status).toBe(200);
    expect(metrics).toMatchObject([
      {
        code: "MCP_REQUEST_COMPLETED",
        durationMs: 7,
        method: "tools/call",
        protocolVersion: "2026-07-28",
        requestId: "request-correlation-only",
        resultClass: "success",
        tool: "search_aanvragen",
      },
    ]);
  });

  it("collapses unvalidated and unknown values to fixed low-cardinality buckets", () => {
    expect(
      boundedMcpMetricRoute(
        "tools/call",
        "attacker-controlled-name",
        new Set(["search_aanvragen"])
      )
    ).toMatchObject({ method: "tools/call", tool: "other" });
    expect(
      boundedMcpMetricRoute(
        "attacker-controlled-method",
        "search_aanvragen",
        new Set(["search_aanvragen"])
      )
    ).toMatchObject({ method: "unknown", tool: "other" });
    expect(boundedMcpProtocolVersion("attacker-controlled-version")).toBe(
      "unknown"
    );
  });

  it("records thrown operations as a bounded server error and rethrows", async () => {
    const metrics: McpRequestMetric[] = [];
    const error = new Error("fixture failure");
    const operation = measureMcpRequest(
      {
        protocolVersion: "legacy",
        requestId: "request-2",
        route: boundedMcpMetricRoute("tools/list", undefined, new Set()),
      },
      () => Promise.reject(error),
      {
        classifyResult: () => "success",
        now: () => 5,
        record: (metric) => metrics.push(metric),
      }
    );

    await expect(operation).rejects.toBe(error);
    expect(metrics[0]?.resultClass).toBe("server-error");
  });

  it("does not fail or retry a successful effect when the recorder throws", async () => {
    let effectCalls = 0;
    let recorderCalls = 0;
    const result = await measureMcpRequest(
      {
        protocolVersion: "2026-07-28",
        requestId: "request-effect",
        route: boundedMcpMetricRoute(
          "tools/call",
          "markeer_aanvraag",
          new Set(["markeer_aanvraag"])
        ),
      },
      () => {
        effectCalls += 1;
        return Promise.resolve("committed");
      },
      {
        classifyResult: () => "success",
        now: () => 1,
        record: () => {
          recorderCalls += 1;
          throw new Error("metrics sink unavailable");
        },
      }
    );

    expect(result).toBe("committed");
    expect(effectCalls).toBe(1);
    expect(recorderCalls).toBe(1);
  });

  it("bounds spoofed transport routes and excludes request secrets from metrics", async () => {
    const metrics: McpRequestMetric[] = [];
    const bundle = createTestSliceARegistry();
    const handler = createMetricHandler(bundle, (metric) => {
      metrics.push(metric);
    });
    const clientRpcId = "malicious-client-rpc-id";
    const privateQuery = "private-query-sentinel";
    const vacancyId = "00000000-0000-4000-8000-000000000077";

    const response = await sendMetricRequest(handler, {
      arguments: { id: vacancyId, query: privateQuery },
      bodyId: clientRpcId,
      headerName: "list_bronnen",
      name: "search_aanvragen",
    });

    expect(response.status).toBe(400);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      method: "unknown",
      protocolVersion,
      resultClass: "client-error",
      tool: "other",
    });
    expect(metrics[0]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    const serializedMetric = JSON.stringify(metrics[0]);
    for (const privateValue of [
      metricBearer,
      clientRpcId,
      privateQuery,
      vacancyId,
      "metric-fixture-user",
    ]) {
      expect(serializedMetric).not.toContain(privateValue);
    }
  });

  it("classifies domain failures and ignores recorder failure after one effect", async () => {
    const metrics: McpRequestMetric[] = [];
    const bundle = createTestSliceARegistry();
    let effectCalls = 0;
    let recorderCalls = 0;
    const originalCreate =
      bundle.deps.stores.savedSearches.createWithAudit.bind(
        bundle.deps.stores.savedSearches
      );
    Object.defineProperty(bundle.deps.stores.savedSearches, "createWithAudit", {
      value: (...args: Parameters<typeof originalCreate>) => {
        effectCalls += 1;
        return originalCreate(...args);
      },
    });
    const handler = createMetricHandler(bundle, (metric) => {
      recorderCalls += 1;
      metrics.push(metric);
      throw new Error("Synthetic metrics sink failure");
    });

    const domainFailure = await sendMetricRequest(handler, {
      arguments: { id: "00000000-0000-4000-8000-000000000099" },
      bodyId: "domain-failure-request",
      name: "get_aanvraag",
    });
    const domainFailureResult = await readJsonRpcResult(domainFailure);
    expect(domainFailure.status).toBe(200);
    expect(domainFailureResult).toMatchObject({ isError: true });
    expect(metrics[0]?.resultClass).toBe("client-error");

    const successfulEffect = await sendMetricRequest(handler, {
      arguments: { naam: "Metric fixture", query: "Azure" },
      bodyId: "successful-effect-request",
      name: "create_saved_search",
    });
    const successfulEffectResult = await readJsonRpcResult(successfulEffect);
    expect(successfulEffect.status).toBe(200);
    expect(successfulEffectResult).not.toMatchObject({ isError: true });
    expect(metrics[1]?.resultClass).toBe("success");
    expect(effectCalls).toBe(1);
    expect(recorderCalls).toBe(2);
  });
});
