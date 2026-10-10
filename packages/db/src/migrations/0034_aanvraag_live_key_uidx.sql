-- Unique live identity: at most one NOT-superseded aanvraag per (bron_id, lower(btrim(bron_referentie))).
-- The existing exact unique index aanvraag_bron_referentie_uidx stays; superseded rows keep their
-- original referentie and stay readable by id (FKs from history/links/user tables are untouched).
--
-- PRODUCTION ORDER (see docs/plans/2026-10-10-aanvraag-unique-key.md):
--   1. tools/postgres/unique-key/01-prepare.sql          (columns + archive, = 0033)
--   2. tools/postgres/unique-key/02-plan-dry-run.sql     (read-only: what would be marked)
--   3. tools/postgres/unique-key/03-mark-superseded.sql  (archive snapshot + mark, never delete)
--   4. tools/postgres/unique-key/04-unique-index-concurrently.sql (CREATE UNIQUE INDEX CONCURRENTLY)
--   5. deploy: 0033 + 0034 are then no-ops (IF NOT EXISTS).
-- Deployed without steps 3-4 on a database that still has normalized duplicates, this statement
-- fails with a unique violation and drizzle rolls the whole migration batch back (nothing applied).
-- On an empty or dev database it builds the index directly.
CREATE UNIQUE INDEX IF NOT EXISTS "aanvraag_bron_referentie_live_uidx"
  ON "curated"."aanvraag" ("bron_id", lower(btrim("bron_referentie")))
  WHERE "superseded_by" IS NULL;
