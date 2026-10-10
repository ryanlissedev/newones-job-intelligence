-- Operator pre-step for migration 0031_hot_path_indexes. Run it BEFORE deploying the
-- release that contains 0031, as the migrator role, with psql in autocommit mode
-- (NOT inside BEGIN; and NOT with --single-transaction):
--
--   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f tools/postgres/indexes/0031-hot-path-indexes-concurrently.sql
--
-- CONCURRENTLY builds without blocking writes. It is additive only: no table, column or row changes.
-- The outbox index goes first: it removes the biggest recurring cost (the per-tick prune seq scan).
-- Afterwards the 0031 migration's CREATE INDEX IF NOT EXISTS statements are no-ops.
--
-- If a build is interrupted, Postgres leaves an INVALID index with the same name, and
-- IF NOT EXISTS would then skip it. The final query lists any such index. Rebuild it with
-- REINDEX INDEX CONCURRENTLY <name>; before deploying.

SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_event_processed_at_idx"
  ON "curated"."outbox_event" ("processed_at")
  WHERE "processed_at" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "aanvraag_observation_bron_status_created_idx"
  ON "staging"."aanvraag_observation" ("bron_id", "status", "created_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "aanvraag_bron_status_idx"
  ON "curated"."aanvraag" ("bron_id", "status");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "aanvraag_dedup_groep_bron_idx"
  ON "curated"."aanvraag" ("dedup_groep_id", "bron_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scrape_run_bron_gestart_idx"
  ON "curated"."scrape_run" ("bron_id", "gestart" DESC);

-- Must return zero rows before deploying 0031.
SELECT c.relname AS invalid_index
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid
  AND c.relname IN (
    'outbox_event_processed_at_idx',
    'aanvraag_observation_bron_status_created_idx',
    'aanvraag_bron_status_idx',
    'aanvraag_dedup_groep_bron_idx',
    'scrape_run_bron_gestart_idx'
  );
