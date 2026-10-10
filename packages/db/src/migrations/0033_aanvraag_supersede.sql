-- Additive: mark-not-delete support for duplicate aanvragen under one (bron_id, bron_referentie)
-- identity. No existing column, constraint, index or row changes.
--
--   * superseded_by / superseded_at / superseded_reason: nullable, no default, so ADD COLUMN is
--     catalog-only (brief ACCESS EXCLUSIVE, no table rewrite, no scan).
--   * curated.aanvraag_dup_archive: append-only audit snapshot (to_jsonb of the full row) of every
--     row marked superseded, so a mark can be audited and undone without ever deleting a row.
--
-- On a database with live traffic run tools/postgres/unique-key/01-prepare.sql first (same DDL,
-- IF NOT EXISTS, lock_timeout guarded, as ji_migrator); every statement below is then a no-op.
ALTER TABLE "curated"."aanvraag" ADD COLUMN IF NOT EXISTS "superseded_by" uuid;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN IF NOT EXISTS "superseded_reason" text;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aanvraag_dup_archive_aanvraag_idx"
  ON "curated"."aanvraag_dup_archive" ("aanvraag_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aanvraag_dup_archive_reason_idx"
  ON "curated"."aanvraag_dup_archive" ("reason", "archived_at");
