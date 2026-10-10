# Operator context bootstrap

`get_operator_context` is the read-only operator bootstrap and refresh contract.
The application registry generates both the MCP tool and
`POST /v1/agent/context`; both invoke the same application handler.

The supported client is the first-party signed-session MCP client from RJC-441,
using `@modelcontextprotocol/client` 2.0.0 pinned to protocol `2026-07-28`.
This capability adds no OAuth onboarding, model provider, or prompt engine.

## Read and refresh

Send `{}` for actor, deployment scope, permission-filtered capability status,
and safe recent activity. An operator or admin role is required. The server
validates the current session on every call, including calls from an already
connected MCP client.

Optionally send `savedSearchId` and/or `snapshotId` to select existing owned
resources. Their UUIDs are references, not authorization. Both actor ownership
and the server-owned deployment scope must match. Missing and foreign records
produce the same not-found error. There is no implicit current selection or
fallback to another session. A caller cannot supply actor, scope, request IDs,
or MCP metadata as domain arguments.

Call the same capability again after selecting another resource, changing an
owned resource, or changing permissions/capability availability. There is no
bootstrap response cache. `contract.version` is the schema version;
`contract.digest` is the SHA-256 content version of the safe projection. An
unchanged projection has the same digest; the read timestamp and transport
request ID do not invalidate it. Changes to fields deliberately omitted from
the projection are not promised to change its digest.

## Honest absence and freshness

`present` includes a known empty activity list. `not_applicable` means no
explicit selection was requested. `unknown` means this application boundary
cannot establish the value: preferences, a complete user-owned resource
inventory, or a capability policy when no trusted policy reader was supplied.
The resource inventory is not represented by the deployment's global source
register. Inventory CRUD remains separate work under RJC-444.

`freshness.readAt` reports the read time. Individual observation timestamps and
their states describe the available store evidence; they do not promise an
atomic multi-store snapshot or overall data freshness. Provenance identifies
the registry, owner/scope-filtered stores, and explicit selections.

Production composition supplies the existing unavailable-capability policy.
An omitted policy reader means unknown availability; an unexpected reader
failure returns the registry's sanitized internal error.
The bootstrap may describe an authorized but unavailable capability; the MCP
tool listing filters it out, and invocation remains subject to the current
transport policy. Neither a digest nor an earlier availability result grants
permission to execute a later call.

## Data boundary and evidence

Responses whitelist references, version metadata, counts, bounded activity
summaries, capability metadata, and actor/scope identity. They omit resource
names, query text, filters, result IDs, raw vacancy bodies, raw payload
references, credentials, and audit metadata. MCP metrics retain the existing
bounded method/tool/result fields and never record the context response or
domain arguments.

Activity reads fetch only the newest ten actor/scope audit rows, ordered by
timestamp and ID in the store. Unsupported actions are then omitted, so the
response may contain fewer than ten summaries. It is a bounded recent window,
not a complete activity history.

The application tests cover ownership/scope isolation, honest absence,
deterministic refresh, and minimization. The transport fixture uses the pinned
MCP client and actual Hono handlers to compare REST and MCP outputs and reject
a revoked session on its next call. It does not establish deployed or
production behavior.

This lane is stacked on RJC-439–441 / PR #161 at
`c019847d4dae43f2b45a0602be39b1a64d7c1494`. Its merge-base with the observed
`origin/main` (`4cafa5c4991379856c391925b546cf974617ddb1`) was
`2049008d1ecb998f5a6c3316cc1a162c59b31a70`. It retains the MCP-core stack base;
no rebase or root/RJC-410 checkout modification was performed. The four
RJC-410 dashboard/run capabilities will appear automatically when added to the
same registry, subject to permissions and availability. Their implementation
and eventual integration with this stack are not delivered by this lane.
