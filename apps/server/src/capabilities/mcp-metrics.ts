import { timeCriticalPathPhase } from "@ji/performance";

export type McpMetricMethod =
  | "server/discover"
  | "tools/list"
  | "tools/call"
  | "unknown";

export type McpMetricProtocolVersion = "2026-07-28" | "legacy" | "unknown";
export type McpMetricResultClass = "success" | "client-error" | "server-error";

const BOUNDED_MCP_ROUTE = Symbol("bounded-mcp-route");

interface McpMetricRoute {
  readonly [BOUNDED_MCP_ROUTE]: true;
  readonly method: McpMetricMethod;
  readonly tool: string;
}

export interface McpRequestMetric {
  readonly code: "MCP_REQUEST_COMPLETED";
  readonly durationMs: number;
  readonly method: McpMetricMethod;
  readonly protocolVersion: McpMetricProtocolVersion;
  /** Correlation field only; never use this value as a metric label. */
  readonly requestId: string;
  readonly resultClass: McpMetricResultClass;
  readonly tool: string;
}

export type McpMetricRecorder = (metric: McpRequestMetric) => void;

const MCP_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "tools/call",
]);

const isMcpMetricMethod = (
  method: string
): method is Exclude<McpMetricMethod, "unknown"> => MCP_METHODS.has(method);

const LEGACY_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

export const boundedMcpProtocolVersion = (
  protocolVersion: string | undefined
): McpMetricProtocolVersion => {
  if (protocolVersion === "2026-07-28") {
    return protocolVersion;
  }
  if (
    protocolVersion !== undefined &&
    LEGACY_PROTOCOL_VERSIONS.has(protocolVersion)
  ) {
    return "legacy";
  }
  return "unknown";
};

/**
 * Call only after the JSON-RPC body has been validated. Unknown routes and
 * unregistered tool names collapse to fixed buckets to bound cardinality.
 */
export const boundedMcpMetricRoute = (
  method: string,
  toolName: string | undefined,
  knownToolNames: ReadonlySet<string>
): McpMetricRoute => {
  const boundedMethod = isMcpMetricMethod(method) ? method : "unknown";
  const tool =
    boundedMethod === "tools/call" &&
    toolName !== undefined &&
    knownToolNames.has(toolName)
      ? toolName
      : "other";
  return { [BOUNDED_MCP_ROUTE]: true, method: boundedMethod, tool };
};

interface MeasureMcpRequestOptions<Result> {
  readonly classifyResult: (result: Result) => McpMetricResultClass;
  readonly now?: () => number;
  readonly record?: McpMetricRecorder;
}

const recordBestEffort = (
  record: McpMetricRecorder | undefined,
  metric: McpRequestMetric
): void => {
  try {
    record?.(metric);
  } catch {
    // Operational instrumentation must never change or retry a tool effect.
  }
};

export const measureMcpRequest = <Result>(
  input: {
    readonly protocolVersion: McpMetricProtocolVersion;
    readonly requestId: string;
    readonly route: McpMetricRoute;
  },
  operation: () => Promise<Result>,
  options: MeasureMcpRequestOptions<Result>
): Promise<Result> => {
  const now = options.now ?? performance.now.bind(performance);
  const startedAt = now();
  const route =
    input.route[BOUNDED_MCP_ROUTE] === true
      ? input.route
      : boundedMcpMetricRoute("unknown", undefined, new Set());
  return timeCriticalPathPhase("api-handler", async () => {
    try {
      const result = await operation();
      try {
        recordBestEffort(options.record, {
          code: "MCP_REQUEST_COMPLETED",
          durationMs: Math.max(0, now() - startedAt),
          method: route.method,
          protocolVersion: boundedMcpProtocolVersion(input.protocolVersion),
          requestId: input.requestId,
          resultClass: options.classifyResult(result),
          tool: route.tool,
        });
      } catch {
        // A classifier is instrumentation too; it cannot change the result.
      }
      return result;
    } catch (error) {
      recordBestEffort(options.record, {
        code: "MCP_REQUEST_COMPLETED",
        durationMs: Math.max(0, now() - startedAt),
        method: route.method,
        protocolVersion: boundedMcpProtocolVersion(input.protocolVersion),
        requestId: input.requestId,
        resultClass: "server-error",
        tool: route.tool,
      });
      throw error;
    }
  });
};
