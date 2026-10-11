-- Step 1 (operator, BEFORE deploying migrations 0033/0034). Same DDL as 0033, idempotent.
-- Run as ji_migrator so the new table is owned by the migration role (the migrator preflight
-- refuses to run when app-schema tables have another owner):
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 01-prepare.sql
-- Locks: three catalog-only ADD COLUMNs (nullable, no default: no rewrite, no scan) each take a
-- brief ACCESS EXCLUSIVE on curated.aanvraag. lock_timeout makes them give up after 5 s instead
-- of queueing behind a long reader and blocking everyone behind them; just re-run.
-- Rollback: nothing to roll back functionally (unused nullable columns + empty table). To remove,
-- see 90-rollback.sql section C (only before any row was marked).
SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE "curated"."aanvraag" ADD COLUMN IF NOT EXISTS "superseded_by" uuid;
ALTER TABLE "curated"."aanvraag" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;
ALTER TABLE "curated"."aanvraag" ADD COLUMN IF NOT EXISTS "superseded_reason" text;
CREATE TABLE IF NOT EXISTS "curated"."aanvraag_dup_archive" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aanvraag_id" uuid NOT NULL,
  "kept_aanvraag_id" uuid NOT NULL,
  "bron_id" uuid NOT NULL,
  "bron_referentie" text NOT NULL,
  "normalized_referentie" text NOT NULL,
  "reason" text NOT NULL,
  "row_snapshot" jsonb NOT NULL,
  "archived_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_by" text DEFAULT current_user NOT NULL,
  "restored_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "aanvraag_dup_archive_aanvraag_idx"
  ON "curated"."aanvraag_dup_archive" ("aanvraag_id");
CREATE INDEX IF NOT EXISTS "aanvraag_dup_archive_reason_idx"
  ON "curated"."aanvraag_dup_archive" ("reason", "archived_at");
