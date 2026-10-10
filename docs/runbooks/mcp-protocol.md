# MCP protocol

The `/mcp` endpoint uses the official TypeScript server and Hono SDK packages
at version 2.0.0. It serves MCP `2026-07-28` only. Existing clients did not
establish a need for a legacy compatibility route, so legacy initialization is
rejected rather than silently changing protocol eras.

Clients must configure version negotiation explicitly:

```ts
new Client(clientInfo, {
  versionNegotiation: { mode: { pin: "2026-07-28" } },
});
```

Every request is an independent JSON `POST`. The SDK requires the modern
`_meta` envelope and matching `MCP-Protocol-Version`, `Mcp-Method`, and, for
`tools/call`, `Mcp-Name` headers. Clients send `Content-Type:
application/json` and `Accept: application/json, text/event-stream`. The server
currently selects JSON responses, so the SDK also accepts a narrower `Accept`
value and does not reject requests based on `Accept`, including `text/plain`,
instead of requiring SSE support for a response it will not emit.
The SDK transport owns protocol validation and HTTP mappings. Two thin local
guards cover adapter gaps: malformed JSON is returned as JSON-RPC `-32700`,
and an absent `MCP-Protocol-Version` header is rejected with HTTP 400 and SDK
header error `-32020`. Protocol regression fixtures exercise both guards.

Authentication uses the first-party session policy documented in
[auth-access.md](./auth-access.md). Tool discovery is filtered for the current
principal, and every invocation still passes through registry authorization,
approval, idempotency, and audit behavior. Production composition does not
advertise or invoke `commit_export` until an export provider is connected.
It also disables the echo-only `complete_task` stub. The `start_run` and
`start_test_import` handlers currently record only volatile process-memory
state and do not dispatch work, so production disables them until a durable
dispatcher is connected. Protocol fixtures opt into this production policy
explicitly; generic handler fixtures can omit it when testing registry wiring.

The isolated protocol fixture covers discovery, schema listing, search,
marking, readback, and a direct tool call without discovery or initialization:

```sh
bun test --max-concurrency 2 apps/server/src/capabilities/mcp-protocol.spec.ts
```

This fixture uses synthetic in-memory data. It proves protocol and application
integration; it is not deployment or production-auth evidence.
