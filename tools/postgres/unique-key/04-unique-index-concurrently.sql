-- Step 4 (operator, after step 3). Builds the 0034 index without blocking writes.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction: run with psql autocommit (no -1),
-- as ji_migrator (index owner = table owner; the migrator must own curated.aanvraag):
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 04-unique-index-concurrently.sql
-- Locks: SHARE UPDATE EXCLUSIVE on curated.aanvraag for the duration (reads and writes continue;
-- other DDL/VACUUM FULL wait). Two table scans; it waits for transactions older than the build.
-- If a new normalized duplicate is written between step 3 and the end of the build, the build
-- fails and leaves an INVALID index: run 90-rollback.sql section A, re-run step 3, then this.
-- Afterwards deploy 0033 + 0034 + code: both migrations are no-ops (IF NOT EXISTS).
SET statement_timeout = 0;
SET lock_timeout = '10s';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "aanvraag_bron_referentie_live_uidx"
  ON "curated"."aanvraag" ("bron_id", lower(btrim("bron_referentie")))
  WHERE "superseded_by" IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
     WHERE i.relname = 'aanvraag_bron_referentie_live_uidx'
       AND i.relnamespace = 'curated'::regnamespace
       AND x.indisvalid AND x.indisready
  ) THEN
    RAISE EXCEPTION 'aanvraag_bron_referentie_live_uidx is missing or INVALID: drop it (90-rollback.sql section A) and retry';
  END IF;
  RAISE NOTICE 'aanvraag_bron_referentie_live_uidx valid';
END $$;
