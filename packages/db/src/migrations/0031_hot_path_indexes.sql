-- Additive: five read-path indexes measured as missing in prod (2026-10-09, Postgres 18.6).
-- No column, constraint or data change.
--
-- drizzle-kit runs every pending migration inside one transaction, and
-- CREATE INDEX CONCURRENTLY cannot run in a transaction. So, on a database
-- with live traffic, run tools/postgres/indexes/0031-hot-path-indexes-concurrently.sql
-- first (psql, autocommit; outbox index first). Every statement below is then a
-- no-op (IF NOT EXISTS). On an empty or dev database this file builds them directly.
--
-- 1. outbox prune: DELETE ... WHERE processed_at IS NOT NULL AND processed_at < cutoff
--    seq-scanned 87k pages (~680 MB) every ~60 s and found 0 rows.
CREATE INDEX IF NOT EXISTS "outbox_event_processed_at_idx"
  ON "curated"."outbox_event" ("processed_at")
  WHERE "processed_at" IS NOT NULL;
--> statement-breakpoint
-- 2. curation backlog per bron and status, oldest first (curateScrapeRun, backlog stats).
CREATE INDEX IF NOT EXISTS "aanvraag_observation_bron_status_created_idx"
  ON "staging"."aanvraag_observation" ("bron_id", "status", "created_at");
--> statement-breakpoint
-- 3. per-bron active counts (dashboard, bronnen page, lifecycle reconcile).
CREATE INDEX IF NOT EXISTS "aanvraag_bron_status_idx"
  ON "curated"."aanvraag" ("bron_id", "status");
--> statement-breakpoint
-- 4. overlap endpoint: group by dedup_groep_id with bron_id, index-only instead of 4 heap scans.
CREATE INDEX IF NOT EXISTS "aanvraag_dedup_groep_bron_idx"
  ON "curated"."aanvraag" ("dedup_groep_id", "bron_id");
--> statement-breakpoint
-- 5. run stats: newest run per bron within a window (bron-run-stats latest-value aggregates).
CREATE INDEX IF NOT EXISTS "scrape_run_bron_gestart_idx"
  ON "curated"."scrape_run" ("bron_id", "gestart" DESC);
