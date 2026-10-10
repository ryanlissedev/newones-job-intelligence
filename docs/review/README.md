# Slice A review pack (SC5 / JI-054)

Fill this template once per Wednesday review. Slice A evidence only — no Spott sandbox, no production-all-sources claim.

## Release identity

| Field | Value |
| --- | --- |
| Git SHA | `9ec09e777bc2accafb6e47c295def1eddaccaa21` (main baseline; U8 branch adds observability/backfill/e2e) |
| Environment | Local compose: Postgres 16 (`ji_test`), Manticore RT, Redis, Bun 1.3 |
| Plan unit | U8 — Observability, Motian-Neon read-only backfill, e2e, review pack |
| Linear | RJC-334 |

## Bron runs (F2 / R16)

| Bron | Run kind | Fixture/live | Idempotent replay | Metrics visible |
| --- | --- | --- | --- | --- |
| TenderNed | test/poll | `fixtures/connectors/tenderned/*` | AE2 green (`read-path.spec.ts`) | found/new/changed/rejected/error |
| Inhuurdesk | test/poll | `fixtures/connectors/inhuurdesk/*` | AE2 green | same |
| Motian-Neon v1 | backfill | `fixtures/backfill/neon-v1-sample.json` (~200 rows) | duplicate `v1_id` skipped | found/imported/skipped/rejected/errors |

Live Motian import is opt-in via `MOTIAN_DATABASE_URL` (read-only role). Catapulze never writes to Motian-Neon. Recruitment tables excluded per JI-MIG-05.

## Reconciliation

| Check | Status | Evidence |
| --- | --- | --- |
| Raw pointer before curated row | Pass | Backfill writes object-store path before `curateObservation` |
| Unreachable source → failed run | Pass | `neon-v1.spec.ts` unreachable source case |
| v1_id provenance | Pass | `aanvraag.v1_id` migration + mapping in `neon-v1.ts` |
| Forbidden v1 tables not imported | Pass | `NEON_V1_FORBIDDEN_TABLES` constant + db `core.spec.ts` guard |

## Golden queries (AE1 / R8)

| Query | Expected | CI |
| --- | --- | --- |
| `(Azure OR "platform engineer") NOT intern` | Stable IDs on repeat | `packages/domain` Boolean suite |
| TenderNed fixture titel term | ≥1 hit after projector | `tests/e2e/read-path.spec.ts` |

## Latency (R11 / JI-016)

| Gate | Target | Status |
| --- | --- | --- |
| SearchAdapter p95 | ≤ 100 ms @ 200k profile | Profile documented in `benchmarks/search/profile.json`; run `bun run bench:search --profile benchmarks/search/profile.json` before release claim |

## Observability (F4 / AE7)

| Check | Status | Evidence |
| --- | --- | --- |
| Silence event shape | Pass | `packages/application/src/observability/silence.spec.ts` |
| Dedupe on identical event | Pass | same spec |
| Runbook linked | Pass | `docs/runbooks/source-silence.md` |

## End-to-end read path (JI-052)

| Step | Status |
| --- | --- |
| fixture bron → raw | Pass |
| normalise / curate | Pass |
| search via SearchAdapter | Pass |
| QuerySnapshot freeze | Pass |

Command: `bun test tests/e2e/read-path.spec.ts`

## Open Gate-0 items

| ID | Item | Blocks donderdag-ready? |
| --- | --- | --- |
| RJC-347 | On-box Postgres production evidence (U10 / JI-037) | Partial — CI restore drill + in-repo checks; Hetzner firewall/off-site bucket probes remain |
| JI-007 | Indeed allowed route | No for Slice A (explicitly out) |
| DEC-006 | Spott export contract | Slice B only |
| SC6 | Production DB recovery evidence | Partial until U10 Hetzner ops evidence; CI AE9 drill + compose guards pass in PR |

## Postgres hardening (U10 / RJC-347)

| Check | Status | Evidence |
| --- | --- | --- |
| Distinct admin/migrator/app roles | Pass | `tools/postgres/init/10-bootstrap-roles.sh`, `tools/postgres/postgres-roles.spec.ts` |
| App role cannot create schema/role/database | Pass | `tools/postgres/postgres-roles.spec.ts` |
| External protected Postgres volume | Pass | `docker-compose.yml`, `bun run check:postgres-compose` |
| Localhost-only 5432 publish | Pass | `bun run check:postgres-compose` |
| Production never `down -v` | Pass | `bun run check:production-compose-guard` |
| WAL archive to S3-compatible fixture | Pass | `docker-compose.backup.yml`, CI job `postgres-restore-drill` |
| AE9 isolated restore drill | Pass | `tools/postgres/restore-drill.sh`, `.artifacts/postgres-restore-evidence.json` |
| Monitoring/alert stubs + DB-first limits | Pass | `tools/postgres/monitoring/alerts.yml`, compose mem limits |
| Versioned restore runbook | Pass | `docs/runbooks/postgres-restore-v1.md` |

Remaining **production-only** ops evidence (do not block in-repo PR):

- External firewall probe: public `5432` unreachable on Hetzner
- Live off-site bucket with production credentials and retention
- Alert route test for disk/WAL/base-backup staleness

## Verification commands (PR gate)

```bash
bun test
bun run check-secrets
bun run check-layering
bun run check:capability-coverage
bun run check:capability-registry
bun test tests/e2e/read-path.spec.ts
bun test packages/application/src/observability/silence.spec.ts
bun run check:postgres-compose
bun run check:production-compose-guard
bun test tools/postgres/postgres-roles.spec.ts
bash tools/postgres/restore-drill.sh
```

## Notes

- Health endpoints: `GET /`, `/health`, `/livez`, `/readyz` on `apps/server` (port 3000).
- MCP + REST parity remains on U7 registry (`apps/server/src/capabilities/parity.spec.ts`).
- This pack intentionally does **not** claim all 23 sources or Spott export readiness.
