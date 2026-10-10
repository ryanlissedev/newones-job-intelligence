# Slice B spike — Spott.io REST (RJC-336 / JI-020)

Status: spike landed behind `@ji/application/export/spott`. DEC-006 contract facts are recorded here; export orchestration (`commit_export`, approvals, receipts) is **not** in scope.

## Product and auth

| Item | Value |
| --- | --- |
| Product | **Spott.io** (not “Spot”) |
| REST base | `https://api.gospott.com` |
| Auth | Header `x-api-key` from env `SPOTT_API_KEY` (server only — see `apps/server/.env.example`) |
| Rate limit | 600 requests/minute; HTTP 429 when exceeded |
| Docs | [API overview](https://docs.spott.io/docs/developers/api-overview) · [OpenAPI](https://docs.spott.io/api-reference/openapi.json) |

## MCP vs REST

| Surface | URL | Auth | Export path? |
| --- | --- | --- | --- |
| REST | `https://api.gospott.com` | `x-api-key` (`SPOTT_API_KEY`) | **Yes** — programmatic export target |
| MCP | `https://mcp.spott.io/mcp` | OAuth per user | **No** — assistant-only; do not wire MCP OAuth in export |

Standing export uses the REST client. MCP remains a separate assistant integration.

## External identity and minimum write

- **Unique external ID:** Spott vacancy `id` (string returned on list/get and on create).
- **Minimum write:** `POST /vacancies` → `{ id }` (201). Required body fields include `companyId`, `name`, `description`, `stageId`, and additional fields per OpenAPI `CreateVacancyDto`.
- **This spike:** read path only (`GET /vacancies`, `GET /vacancies/{id}`). No live POST, no `commit_export`, no receipts.

## Local verification (reviewer)

1. Copy `apps/server/.env.example` → `apps/server/.env` and set `SPOTT_API_KEY` from the team secret store (never commit the key).
2. Enable live reads: `SPOTT_LIVE=1`.
3. From a Bun REPL or one-off script:

```ts
import { createSpottClient } from "@ji/application/export/spott";

const client = createSpottClient({ liveEnabled: true });
const page = await client.listVacancies({ limit: 5 });
console.log(page.items.map((v) => v.id));
```

CI and default tests use repo fixtures (`SPOTT_LIVE` unset) — no live key required in CI.

## Code map

| Path | Role |
| --- | --- |
| `packages/application/src/export/spott/client.ts` | Replaceable `SpottClient` adapter |
| `packages/application/src/export/spott/types.ts` | Typed DTO subset + constants |
| `fixtures/export/spott/` | Versioned `spott-fixture/v1` envelopes |

See also `docs/BUILD_BRIEF.md` §10 (Slice B) and `docs/IMPLEMENTATION_BACKLOG.md` JI-020.
