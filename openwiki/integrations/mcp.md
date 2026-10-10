---
type: integration
title: MCP Integration
description: The Model Context Protocol (MCP) integration provides a standardized transport for agents to interact with the system's capability registry, sharing the same handlers and authorization logic as REST while offering MCP-specific features like tool discovery and structured error handling.
tags: [mcp, integration, capability-registry, transport, api]
verified:
  - by: openwiki/0.7.0
    at: 2026-10-10T14:05:56.822Z
sources:
  - id: openwiki-source-4ac306f6c4299bdd5fef9b36
    resource: repo://apps/server/src/capabilities/mcp.ts
  - id: openwiki-source-3191419c76ea18831b50ac9e
    resource: repo://apps/server/src/index.ts
generated: { by: "openwiki/0.7.0", at: "2026-10-10T14:05:56.822Z" }
---
The Model Context Protocol (MCP) integration in Catapulze Job Intelligence provides a standardized way for AI agents and external clients to interact with the system through a uniform tool-based interface. The MCP implementation shares the same capability handlers and authorization logic as the REST transport, ensuring behavioral parity while offering MCP-specific advantages like standardized tool discovery, structured error handling, and built-in support for capabilities annotations.

## Responsibilities

The MCP integration is responsible for:

- Exposing the system's capability catalog as MCP tools through the standard `tools/list` endpoint
- Handling tool invocations via the standard `tools/call` endpoint with proper JSON-RPC 2.0 formatting
- Enforcing the same authorization and input/output validation as REST transport
- Providing MCP-specific metadata in tool descriptions (annotations, output schema hints, permission requirements)
- Collecting metrics on MCP protocol usage and performance
- Validating MCP protocol version headers and routing headers (`Mcp-Method`, `Mcp-Name`)
- Maintaining capability availability information and returning appropriate errors for unavailable tools
- Sharing the exact same invocation logic as REST through the `invokeMcpToolCanary` function

## Entrypoints

The MCP integration has a single HTTP entrypoint:

- **POST `/mcp`** - Handles all MCP JSON-RPC requests (both `tools/list` and `tools/call`)  

This endpoint is mounted in the main Hono application (`apps/server/src/index.ts:156`) and shares middleware with other JSON endpoints (JSON body parsing, CORS, rate limiting where applicable).

## Mechanisms/Control Flow

When an MCP request arrives:

1. **Middleware processing** (`apps/server/src/index.ts:41`):
   - JSON body limit applied
   - CORS headers set
   - Request logging

2. **Authentication and principal resolution** (`apps/server/src/capabilities/mcp.ts:337-355`):
   - Session validation via Better Auth
   - Principal extraction (kind, permissions, subjectId)
   - Request ID generation or extraction from auth context
   - Construction of `AuthInfo` object for the MCP SDK

3. **MCP SDK handling** (`apps/server/src/capabilities/mcp.ts:357-362`):
   - Request passed to `@modelcontextprotocol/hono` adapter
   - Adapter delegates to custom `createServer` function

4. **Tool listing** (`apps/server/src/capabilities/mcp.ts:216-244`):
   - Filters registry capabilities based on principal permissions
   - Sorts tools alphabetically for consistent discovery
   - Adds MCP-specific metadata:
     - `_meta.catapulze/availability` - current availability state
     - `_meta.catapulze/effect` - effect class and groundedness
     - `_meta.catapulze/outputSchema` - original registry output schema
     - `_meta.catapulze/outputSchemaPolicy` - schema validation policy
     - `_meta.catapulze/requiredPermission` - required permission string
     - `annotations` - hints about destructiveness, idempotency, read-only nature

5. **Tool calling** (`apps/server/src/capabilities/mcp.ts:245-309`):
   - Validates tool exists and is authorized for principal
   - Checks capability availability policy (returns `CAPABILITY_UNAVAILABLE_CODE` if blocked)
   - Parses and validates JSON-RPC arguments against registry input schema
   - Invokes capability handler via `invokeMcpToolCanary` (same function used by REST)
   - Serializes successful result according to registry output schema
   - Returns proper JSON-RPC success or error response

6. **Metrics collection** (`apps/server/src/capabilities/mcp.ts:415-432`):
   - Measures request duration
   - Classifies outcomes (success, client-error, server-error)
   - Records metric data if recorder is configured
   - Tracks in-band errors from successful HTTP responses with error payloads

## Relationships

The MCP integration has these key relationships:

- **Capability Registry** (`@ji/application/registry`): Consumes `SliceARegistry` and `SliceACapabilityCatalog` to get capability definitions, schemas, and metadata. The MCP implementation adds no behavior—it purely exposes what the registry defines.
  
- **REST Transport** (`apps/server/src/capabilities/rest.ts`): Shares identical handler invocation logic through `invokeMcpToolCanary`. Both transports use the same registry entry point, ensuring identical business logic, validation, and error handling.

- **Authentication System** (`@ji/auth`): Relies on session validation to determine caller identity and permissions. The MCP integration uses the same principal resolver as REST (`createSessionPrincipalResolver`).

- **Metrics System** (`apps/server/src/capabilities/mcp-metrics.ts`): Sends measurement data to the MCP metrics recorder for observability.

- **Availability System** (`apps/server/src/capabilities/capability-availability.ts`): Checks whether specific capabilities should be temporarily unavailable based on policy.

## State/Lifecycle

The MCP integration is largely stateless per request:

- **Request-scoped state**:
  - Principal information from authenticated session
  - Request ID for tracing
  - Filtered tool list based on principal permissions
  - Metric classification data

- **Application-scoped state**:
  - MCP SDK Server instance (created per request with current registry and entries)
  - Authorization filter function (based on current unavailable capabilities policy)
  - Metrics recorder configuration

The integration does not maintain persistent connections or session state beyond what's required for a single MCP request. Each request gets a fresh Server instance with current capability data, ensuring that changes to the registry (through dynamic capability updates) are immediately reflected.

## Invariants/Failures

Key invariants and failure modes:

- **Handler Parity**: For any capability with both REST and MCP bindings, the behavioral outcome (excluding transport-specific formatting) must be identical. This is enforced by sharing the `invokeMcpToolCanary` function.

- **Authorization Consistency**: A principal permitted to call a capability via REST must be permitted via MCP, and vice versa. Both transports check `principal.permissions.has(tool.requiredPermission)`.

- **Input Validation**: MCP arguments undergo the same Zod-based validation as REST JSON bodies via `restJsonBodySchema`.

- **Error Formatting**:
  - Transport errors (parse errors, missing headers) return JSON-RPC error responses with standard MCP error codes
  - Application errors from capability handlers return JSON-RPC success responses with `isError: true` in the result
  - Unavailable capabilities return `CAPABILITY_UNAVAILABLE_CODE` (-32003) with descriptive message

- **Protocol Compliance**:
  - Requires `MCP-Protocol-Version` header (returns -32020 if missing)
  - Validates `Mcp-Method` and `Mcp-Name` headers match JSON-RPC body when present
  - Returns proper JSON-RPC 2.0 error responses for invalid requests (`-32603` for internal errors, `-32602` for invalid params, `-32700` for parse errors)

## Extension Points

The MCP integration supports these extension points:

- **Capability Availability Policy**: The `unavailableCapabilities` option allows dynamic disabling of specific tools without changing registry definitions (used for feature flags, maintenance, etc.)

- **Metrics Recording**: The `recordMetric` option enables custom observability integration beyond the default stderr logging

- **Cache Hints**: Through `MCP_CATALOG_CACHE_HINTS` constant, the server can provide cache-directives to compliant MCP clients

- **Principal Resolution**: The `resolvePrincipal` function is injected, allowing different authentication strategies while maintaining the same MCP handler logic

## Configuration/Operations

Operational aspects of the MCP integration:

- **Mount Point**: Fixed at `/mcp` in the HTTP server (configured in `apps/server/src/index.ts:156`)

- **Dependencies**:
  - `@modelcontextprotocol/hono`^1.0.0
  - `@modelcontextprotocol/server`^1.0.0
  - Same capability registry and auth dependencies as REST

- **Observability**:
  - JSON metrics logged to stderr when `recordMetric` is configured (default in production)
  - Standard HTTP access logs show `/mcp` endpoint usage
  - Application-level errors from capability handlers appear in normal error tracking

- **Security Considerations**:
  - Inherits all security properties of the authentication system (session validation, cookie origin checks)
  - Subject to same rate limiting and input size limits as JSON endpoints
  - No additional attack surface beyond what REST provides (same handlers, same validation)

## Focused Tests

The MCP integration is verified through these test approaches:

- **Unit Tests** (`apps/server/src/capabilities/mcp-*.spec.ts`):
  - `mcp-headers.spec.ts`: Validates required header handling and error responses
  - `mcp-metrics.spec.ts`: Tests metrics collection and classification logic
  - `mcp-protocol.spec.ts`: Tests core MCP protocol handling (list/call, error cases)
  - `mcp-catalog-cache.spec.ts`: Tests catalog sorting and cache hint generation

- **Integration Tests**:
  - Parity tests in `scripts/check-capability-coverage.ts` and `scripts/check-capability-registry.ts` verify that MCP and REST expose the same capabilities
  - Smoke tests in `/scripts/mcp-edge-*.ts` validate end-to-end MCP request handling

- **Contract Tests**:
  - The implementation is designed to pass compliance tests against the official MCP 2026-07-28 specification (work in progress tracked in RJC-439)

Note: While the current implementation provides full functional parity with REST and implements core MCP semantics, it does not yet claim full compliance with the MCP 2026-07-28 specification. Official compliance work is tracked in issue RJC-439, which will introduce the official TypeScript/Hono adapter and complete SDK integration.
