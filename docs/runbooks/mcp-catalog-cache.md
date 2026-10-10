# MCP capability catalog caching

Catapulze uses the response cache built into `@modelcontextprotocol/client` 2.0.0 and the cache hints emitted by `@modelcontextprotocol/server` 2.0.0. It does not maintain a server-side catalog, authentication, or authorization cache.

## Policy

`server/discover` and complete `tools/list` results use a 30,000 ms TTL and `private` scope. Thirty seconds is the maximum catalog staleness budget for role loss, token replacement, disabled capabilities, and registry configuration changes. The hint allows reuse; it does not start background polling and it does not promise that a cached tool remains callable.

Every request still resolves the current principal and applies current registry policy. Every `tools/call` authenticates and authorizes again. Tool calls, authentication failures, and multi-round-trip retries carrying `inputResponses` or `requestState` are never cached.

Clients that share a response store must give each bearer token its own opaque `cachePartition`, including two tokens for the same user. Do not use the user id as that partition. Do not log or persist the bearer token as the partition value; derive an opaque token fingerprint in the client process. A token change creates a different partition. On revocation, clients must clear the revoked token's partition; revocation alone does not change its cache key. The official client's private-scope partitioning prevents reuse across distinct authorization contexts.

The catalog is sorted by tool name before pagination. Every page retains the same private scope and TTL. Catapulze does not advertise `listChanged` or a subscription capability until it has a real implementation.

## Reproducible evidence

`mcp-catalog-cache.spec.ts` drives the official 2.0.0 client cache against the real Catapulze MCP handler and test registry, using only synthetic in-memory stores. It uses a shared `InMemoryResponseCacheStore`, token-specific private partitions, and a fake clock. It records a stable catalog digest plus request count, response bytes, observed in-process elapsed/server latency, and observed measurement overhead for the same catalog and authorization context.

The before case uses cache bypass for two catalog needs. The after case uses the default cache mode for the same two needs within 30 seconds, then advances the fake clock past the TTL and verifies a new fetch. The fixture also covers two users, two tokens for one user, role loss, a revoked credential, and a disabled capability. Resolver and handler-store counters prove that a previously cached tool definition never bypasses authentication or authorization on `tools/call`, and that denied calls execute no handler effect.

Multi-round-trip retry caching is not applicable to the current Catapulze fixture: its tools do not return `input_required`, `inputResponses`, or `requestState`. The cacheable-method allowlist excludes `tools/call`, so any future retry exchange remains outside the catalog cache.

Run the focused evidence remotely or in the allocated local test slot:

```sh
bun test --max-concurrency 2 apps/server/src/capabilities/mcp-catalog-cache.spec.ts apps/server/src/capabilities/mcp-metrics.spec.ts apps/server/src/capabilities/mcp-protocol.spec.ts apps/server/src/capabilities/auth.spec.ts
```

Report the emitted fixture record as an in-process comparison, not a production latency claim. Production benefit remains unproven until measured under representative client traffic.

## Metrics

The MCP adapter reuses the existing `api-handler` critical-path timer. Its structured completion event contains only the bounded protocol era, validated method, registered tool name or `other`, result class, duration, and request id. The request id is a correlation field, not a label. Tokens, arguments, query text, user ids, vacancy ids, and raw payloads are excluded.
