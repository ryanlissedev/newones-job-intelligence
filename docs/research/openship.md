# oblien/openship — wat we liften

Datum 2026-08-27. Bronnen: github.com/oblien/openship, api.github.com/repos/oblien/openship, raw `package.json`, raw `apps/api/src/modules/mcp/mcp-tools.ts`, raw `apps/api/test/modules/mcp/pending-actions-tools.test.ts`, openship.io/docs/api/mcp, deepwiki oblien/openship.

## Wat het is

Self-hosted **deploy-platform** (Vercel/Coolify-klasse) — níet commerce. Apache-2.0 TypeScript-monorepo (Turborepo + Bun workspaces, `bun@1.3.10`, Node ≥ 22), v0.6.8, 11.744 sterren, 1.040 forks, 206 open issues, gemaakt 2026-03-05, laatste push 2026-08-25. Achter: Oblien (verkoopt "Openship Cloud"). Abstracties: Project → Deployment (build → deploy → route), Server, Domain, Organization, RuntimeAdapter (bare/docker/cloud), GitHub push-to-deploy, JobRunner, audit log, PAT/OAuth 2.1, MCP-endpoint gegenereerd uit de REST-route-registry.

## Architectuur

Hono + Drizzle + TypeBox + pino + vitest; Next.js-dashboard; pglite (bare) of Postgres + Redis (Compose). Eén `RuntimeAdapter`-interface met `capabilities: ReadonlySet` + `supports(cap)`. Routes dragen `PermissionSpec` (`root.leaf.action` read/write/admin). Idempotency: partial unique index `uq_deployment_one_active_per_project`. **Geen outbox, geen persisted proposals.** "Pending actions" (`pending-actions.service.ts`) zijn *derived state* met `resolveWith[]` = concrete `{method, path, body}`-calls die ze sluiten. Auth: better-auth, PATs, OAuth 2.1 voor MCP, rollen owner/admin/member/restricted. Jobs: BullMQ bij `REDIS_URL`, anders Postgres-polling; `job_run` append-only. Audit: before/after-JSON per mutatie.

**MCP** (`mcp-tools.ts`): tools gegenereerd uit de route-registry; `includeRoute()` eist `spec.mcp != null`, HARD_DENY voor tokens/auth/mcp-modules en public/localOnly routes; `toolName()` leidt `get_projects` af uit `GET /api/projects` (64-char cap); `inputSchema` uit path+query+body; `annotationsFor()` zet `readOnlyHint`/`destructiveHint` (o.a. keyword-sniffing `delete|teardown|destroy|remove|wipe|revoke`). `tools/list` gefilterd op `McpPrincipal`; **elke `tools/call` gaat als interne HTTP-subrequest door de volledige auth+permission-stack.**

## Relevantie

| Concern | openship | Verdict |
|---|---|---|
| Connector/adapter-model | RuntimeAdapter + capability-set + `supports()` | adapt (vorm), domein is executie niet ingest |
| Capability/tool-registry | tools uit permission-getagde route-registry, opt-in `mcp`-blok, hard-deny | **adopt**: één registry voor MCP + REST; onze `sideEffectClass` als gedeclareerde annotatie i.p.v. keyword-sniffing |
| Approval & idempotente effecten | partial unique index; pending actions computed-on-read met `resolveWith[]` | adapt: **`resolveWith[]` overnemen**; compute-on-read afwijzen — wij persisteren proposal→acceptance→commit voor audit |
| Agent-native pariteit | agents roepen dezelfde routes als de UI; per-call her-auth via subrequest | **adopt** |
| Event/outbox | geen | irrelevant — ons ontwerp is strenger |
| Observability | pino, job_run, before/after audit | adapt (audit-vorm) |
| Deployment | bare/Docker/Cloud, OpenResty | irrelevant |

Gotchas: sterk gekoppeld aan deploy-domein; generator leest hun `PermissionSpec` — idee liften, niet het bestand; 5 maanden oud, 0.6.x; `cloud.ts` = vendor-tie-in.

## Overgenomen in `../AGENT_NATIVE_ARCHITECTURE.md` §3

MCP-catalogus gegenereerd uit de capability-registry (opt-in, hard-deny, gedeclareerde annotaties) · per-call her-autorisatie via interne subrequest · `resolveWith[]` op proposal-rijen.
