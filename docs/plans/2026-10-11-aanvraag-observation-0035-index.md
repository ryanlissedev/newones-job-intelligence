# Plan: optional sibling-probe index 0035 on `staging.aanvraag_observation`

Status: draft PR, split out of #490 so #490 is the query rewrite only. Nothing has run in production.
Every prod step below needs Ryan's GO.

## What
Migration `0035_aanvraag_observation_source_record_hash_idx`:
`CREATE INDEX IF NOT EXISTS aanvraag_observation_source_record_hash_idx ON staging.aanvraag_observation (source_record_id, content_hash)`.
Additive only: no table, column, constraint or row change. The drizzle schema (`schema/staging.ts`) declares the
same index, and `readiness.spec.ts` expects 0035 as the newest journal entry.

## Why (optional)
The dominated-unchanged sweep (`selectDominatedPairs`) probes, per dominated row, its same-content siblings
(`source_record_id = $1 AND content_hash = $2`). With only `aanvraag_observation_source_record_id_idx` each probe
reads the record's whole observation history; this index narrows it to the same-hash chain.
Measured on the #490 perf fixture (`docs/evidence/dominated-sweep/README.md` in #490), new query:

| bron | without 0035 | with 0035 |
|---|---|---|
| perf-bron-5 | 164 ms | 157 ms |
| perf-bron-17 | 351 ms | 326 ms |
| perf-bron-1 | 1,983 ms | 1,856 ms |

That is a 5-7% gain, more for records with many content versions. **The #490 rewrite carries the fix; this
index is a secondary gain.** The index alone does not fix the old query (old bron-5 still 34.9 s with it).
16 MB on 2M rows (btree deduplication); the pre-build took 1.7 s locally.

## Order
Independent of #490: either can merge and deploy first. The code never depends on the index.

## Prod operator plan (not run; each step needs a GO)
drizzle-kit applies pending migrations in one transaction, so `CONCURRENTLY` can't be used in 0035 itself.
A plain build would hold SHARE on the table (~2M rows) and block observation writes. Same pattern as 0031:

1. **Pre-build, before deploying the release that contains 0035**, as the migrator role, psql autocommit
   (not inside `BEGIN`, not with `-1`):
   `psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f tools/postgres/indexes/0035-aanvraag-observation-source-record-hash-concurrently.sql`
   It sets `lock_timeout = '5s'` and `statement_timeout = 0`, runs `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
   (SHARE UPDATE EXCLUSIVE: reads and writes continue), then lists invalid copies of the index.
2. **Check:** the final query must return 0 rows. If it lists the index as INVALID (interrupted build):
   `DROP INDEX CONCURRENTLY IF EXISTS "staging"."aanvraag_observation_source_record_hash_idx";` and re-run step 1.
3. **Deploy** (migrator first, option B). 0035 is then a no-op:
   `relation "aanvraag_observation_source_record_hash_idx" already exists, skipping`.
4. **Verify:** `\d staging.aanvraag_observation` shows the index as valid; readiness reports 0035.

## Rollback
* Before 0035 is recorded in `drizzle.__drizzle_migrations`: autocommit
  `DROP INDEX CONCURRENTLY IF EXISTS "staging"."aanvraag_observation_source_record_hash_idx";`
* After 0035 is recorded: revert the release (readiness compares the newest recorded migration with the
  journal); dropping the index alone is still safe for the code, which does not depend on it.

## Tests
`packages/db/src/dominated-sweep-index.spec.ts`: after migrating, the index exists, is valid and is on
`(source_record_id, content_hash)`; the planner uses it for the same-content sibling probe; the operator
`CONCURRENTLY` script runs statement by statement and is a no-op once 0035 is applied (no invalid index).
`packages/db/src/readiness.spec.ts`: 0035 is the expected newest migration.
