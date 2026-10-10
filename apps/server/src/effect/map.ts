import type { TransportFault } from "./faults";

/**
 * Map a TransportFault onto the HTTP status used by REST capability handlers.
 * Mirrors apps/server/src/capabilities/rest.ts invocation/domain status tables.
 */
export const transportFaultToHttpStatus = (fault: TransportFault): number => {
  switch (fault._tag) {
    case "unauthenticated": {
      return 401;
    }
    case "forbidden": {
      return 403;
    }
    case "validation": {
      return 400;
    }
    case "not_found": {
      return 404;
    }
    case "unavailable": {
      return 503;
    }
    case "cancel": {
      // Client closed request (non-standard but widely used for abort).
      return 499;
    }
    default: {
      return 500;
    }
  }
};

export interface McpJsonRpcError {
  readonly code: number;
  readonly message: string;
}

/**
 * Map a TransportFault onto MCP JSON-RPC error codes used by createMcpHandler.
 * Auth/origin rejection stays in the ADR-0012 auth path — this only maps Effect faults.
 */
export const transportFaultToMcpJsonRpc = (
  fault: TransportFault
): McpJsonRpcError => {
  switch (fault._tag) {
    case "unauthenticated":
    case "forbidden": {
      return { code: -32_003, message: fault.message };
    }
    case "validation": {
      // Align with MCP INVALID_PARAMS-style client errors.
      return { code: -32_602, message: fault.message };
    }
    case "not_found": {
      return { code: -32_601, message: fault.message };
    }
    case "unavailable": {
      return { code: -32_603, message: fault.message };
    }
    case "cancel": {
      return { code: -32_000, message: fault.message };
    }
    default: {
      return { code: -32_603, message: fault.message };
    }
  }
};

/**
 * Map a TransportFault onto @trpc/server TRPCError codes (string union).
 * packages/api uses the same mapping in its local Effect boundary.
 */
export const transportFaultToTrpcCode = (
  fault: TransportFault
):
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "INTERNAL_SERVER_ERROR"
  | "CLIENT_CLOSED_REQUEST" => {
  switch (fault._tag) {
    case "unauthenticated": {
      return "UNAUTHORIZED";
    }
    case "forbidden": {
      return "FORBIDDEN";
    }
    case "validation": {
      return "BAD_REQUEST";
    }
    case "not_found": {
      return "NOT_FOUND";
    }
    case "unavailable": {
      return "TIMEOUT";
    }
    case "cancel": {
      return "CLIENT_CLOSED_REQUEST";
    }
    default: {
      return "INTERNAL_SERVER_ERROR";
    }
  }
};
