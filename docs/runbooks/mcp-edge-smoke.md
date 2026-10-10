# MCP stateless edge smoke

`bun run docker:mcp-edge-smoke` builds the production server image and runs two
instances behind a pinned Nginx round-robin proxy. The disposable Compose
project publishes no host ports, loads only committed synthetic values, owns
its volumes, and is always removed with its volumes.

The smoke uses the pinned `@modelcontextprotocol/client` 2.0.0 transport to
make the first two MCP wire requests as direct calls, one per upstream, before
any discovery. It then uses the client with MCP `2026-07-28` to discover the
server, bypass the private catalog cache, search a synthetic request, mark it
through one instance, and read the persisted mark through the other. Raw
protocol probes also cover matching
catalog digests, strict request alternation, and exact errors for missing or
conflicting routing headers, Origin, authentication, and Content-Type.
Each raw probe also requires its edge request ID to survive the round trip
unchanged.

The server is configured for request-scoped JSON responses. The smoke therefore
requires JSON for ordinary negotiation, an omitted Accept header,
`Accept: text/plain`, and `Accept: text/event-stream`; it records that SSE is not
offered rather than assuming a session stream exists. Nginx has no affinity
directive and disables retrying another upstream, so an unavailable instance
cannot be hidden as a successful failover.

CI uploads only bounded evidence: tested checkout SHA, PR head SHA, production
server and proxy image IDs, the sanitized proxy route config and its runtime
digest, selected upstream addresses, request IDs, response classes, content
types, and timings. It excludes credentials, cookies, query text, arguments,
actors, and synthetic vacancy fixture identifiers. Synthetic RPC correlation
IDs remain included as bounded routing evidence. Raw application and proxy
logs are not uploaded.

This proves stateless routing through the disposable edge at the tested commit.
It does not prove production deployment, production data, OAuth, TLS, DNS,
external load-balancer behavior, or required-check enforcement.
