-- Operator pre-step for migration 0035_aanvraag_observation_source_record_hash_idx. Run it BEFORE
-- deploying the release that contains 0035, as the migrator role, with psql in autocommit mode
-- (NOT inside BEGIN; and NOT with -1 / --single-transaction):
--
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f tools/postgres/indexes/0035-aanvraag-observation-source-record-hash-concurrently.sql
--
-- CONCURRENTLY builds without blocking reads or writes: it takes SHARE UPDATE EXCLUSIVE on
-- staging.aanvraag_observation (only other DDL, VACUUM FULL and another index build wait), scans
-- the table twice and waits for transactions older than the build. lock_timeout bounds only the
-- lock wait, not the build. Additive only: no table, column or row changes.
-- Afterwards the 0035 migration's CREATE INDEX IF NOT EXISTS is a no-op.
--
-- If a build is interrupted, Postgres leaves an INVALID index with the same name, and
-- IF NOT EXISTS would then skip it. The final query lists it. Drop it with
-- DROP INDEX CONCURRENTLY IF EXISTS "staging"."aanvraag_observation_source_record_hash_idx";
-- and run this script again before deploying.
--
-- Rollback (the code does not depend on the index; it is a speed-up only), autocommit:
--   DROP INDEX CONCURRENTLY IF EXISTS "staging"."aanvraag_observation_source_record_hash_idx";
-- If 0035 is already recorded in drizzle.__drizzle_migrations, revert the release instead of
-- dropping the index alone: readiness compares the newest recorded migration with the journal.

SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "aanvraag_observation_source_record_hash_idx"
  ON "staging"."aanvraag_observation" ("source_record_id", "content_hash");

-- Must return zero rows before deploying 0035.
SELECT c.relname AS invalid_index
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid
  AND c.relname = 'aanvraag_observation_source_record_hash_idx';
