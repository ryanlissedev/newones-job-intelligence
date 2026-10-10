# `/readyz` component-wise readiness (RJC-391)

Before RJC-391, `/readyz` only checked Postgres (migration timestamp match).
The server answered 200 while Manticore was unreachable, the `aanvragen` RT
table was missing, the outbox drain was hours behind, or the raw object
store was gone. `apps/server/src/readiness.ts` now checks five components
independently, each on its own budget, and reports an explicit per-component
verdict alongside the overall one.

## Reading the response

```
GET /readyz
```

```json
{
  "status": "ready" | "degraded" | "unavailable",
  "components": {
    "postgres": { "status": "ok" | "failed", "reason"?: string, "checkedAt": "...", "durationMs": 0 },
    "manticore": { "status": "ok" | "failed", ... },
    "rawObjectStore": { "status": "ok" | "degraded" | "failed", ... },
    "redis": { "status": "ok" | "degraded" } | { "status": "not-configured" },
    "searchProjection": {
      "status": "ok" | "degraded" | "failed",
      "generation": number | null,
      "appliedSequence": string | null,
      "lagEvents": number | null,
      "lagSeconds": number | null,
      "schemaHash": string | null,
      ...
    }
  }
}
```

HTTP status: `ready` → 200, `degraded` → 200 (a load balancer should keep
routing — the product still serves search), `unavailable` → 503.

`/livez` (`apps/server/src/http/health.ts`) is unaffected — it stays
process-only (200 while the event loop runs), independent of every check
below.

**Docker/Coolify HEALTHCHECK must probe `/livez`, not `/readyz`.** Coolify treats a failing image HEALTHCHECK as deploy rollback, which removes the Traefik backend even when the process is up (outage after tip `aca8478`). Keep `/readyz` as the app readiness contract for operators and routing decisions; see `apps/server/Dockerfile`.

The composite result is cached for `READINESS_CACHE_MS` (2000ms) so a probe
storm — a load balancer or k8s readiness/liveness probe hitting `/readyz`
every few seconds — cannot itself DoS Manticore or S3. Each individual check
is bounded by `READINESS_CHECK_TIMEOUT_MS` (1500ms); a check that doesn't
answer in time reports `status: "failed"` (or `"degraded"` for a component
whose severity ceiling is degraded — see below) with `reason: "timeout"`,
never a hung request.

## Component rules

| Component | `failed`/worse means | Maps to overall |
|---|---|---|
| `postgres` | Migration mismatch or the database is unreachable | `unavailable` |
| `manticore` | Unreachable, or `SHOW TABLES` doesn't list BOTH partition tables (`aanvragen_active` and `aanvragen_archive`, RJC-383) — search is the product | `unavailable` |
| `rawObjectStore` | Filesystem backend selected in production (RJC-386: worker-local, shares no disk with the server — production startup already refuses to boot on this; reaching it live would mean that guard was bypassed) | `unavailable` |
| `rawObjectStore` | S3 HEAD/list of the sentinel key fails or times out | `degraded` (ingest reads break; search keeps working) |
| `redis` | Unset (`REDIS_URL` not configured) | `not-configured`, does not affect overall status |
| `redis` | Configured but a live ping fails — Redis died *after* boot (a redis dead *at* boot already refuses production startup in `createResultCache`) | `degraded` (falls back to the in-process cache) |
| `searchProjection` | `schemaHash` on the checkpoint doesn't match the code's `SEARCH_SCHEMA_HASH` — the drain halted itself (`SearchIndexSchemaMismatchError`); results are from a stale generation | `unavailable` — see [search-schema-migration.md](./search-schema-migration.md) |
| `searchProjection` | Outbox lag (`readOutboxLag`) exceeds `READINESS_LAG_DEGRADED_SECONDS` (300s) | `degraded`, `reason: "lag_elevated"` |
| `searchProjection` | Lag exceeds `READINESS_LAG_CRITICAL_SECONDS` (3600s) | still `degraded`, `reason: "lag_critical"` — **decided**: `/readyz` is per-instance routing, and the projector is a shared background process, not per-instance; a dead projector must alert (the reason string is what alerting hooks into), not depair every server instance, so this only sharpens the alerting signal rather than escalating |
| `searchProjection` | The checkpoint/lag READ itself fails or times out (Postgres is up — the `postgres` component already covers that — but this specific query is slow on a large outbox, or errors) | `degraded`, `reason: "projection_read_failed"` / `"timeout"` — a slow metrics query takes the instance off search-freshness reporting, not out of rotation entirely |

Never leaked in a `reason`: connection strings, bucket credentials, or a
hostname carrying credentials. Every failure/timeout reason is a fixed,
pre-defined string (`"unreachable"`, `"timeout"`, `"table_missing"`,
`"schema_hash_mismatch"`, `"lag_elevated"`, `"lag_critical"`,
`"projection_read_failed"`, `"filesystem_backend_in_production"`,
`"check_error"`) or one of `DbReadinessResult`'s existing sanitized reasons
(`"database_error"`, `"migration_mismatch"`) — the raw error/exception is
never serialized.

## Extending or tuning this

- The named constants (`READINESS_CHECK_TIMEOUT_MS`, `READINESS_CACHE_MS`,
  `READINESS_LAG_DEGRADED_SECONDS`, `READINESS_LAG_CRITICAL_SECONDS`) live
  at the top of `apps/server/src/readiness.ts`. Ryan's SLO thresholds under
  DEC-004, if and when they land, likely replace the two lag constants —
  check that decision before changing them ad hoc.
- `createReadinessDeps` (also in `readiness.ts`) wires the real checkers
  (Manticore `SHOW TABLES` probe, raw-object-store sentinel read, search
  checkpoint + outbox lag) from facts already computed in
  `apps/server/src/slice-a-registry.ts` (`manticoreUrl`, `rawObjectStoreKind`)
  and `apps/server/src/index.ts` (`database`, `objectStore`, `redisUrl`,
  `nodeEnv`). `createReadinessHandler` itself only takes a `ReadinessDeps`
  object of plain async checker functions — that's the whole test seam
  (see `apps/server/src/readiness.spec.ts`).
- **`checkSearchProjection`'s default (`PostgresSearchVersionStore.read()`)
  can WRITE, not just read**: it initializes the
  `curated.search_projection_checkpoint` row via `ensureCheckpoint()`
  (`INSERT ... ON CONFLICT DO NOTHING`) if the row is absent — so on a
  freshly migrated database with no drain having run yet, the very first
  `/readyz` probe creates that row. This is intentional and safe
  (idempotent, matches the drain's own first-touch behavior), but it means
  a health check is not purely read-only here.
- Metrics export (Prometheus, etc.) is **not in scope** here — `/readyz` is
  a point-in-time HTTP check, not a metrics endpoint. Wiring these same
  component checks into a metrics exporter is a follow-up.
