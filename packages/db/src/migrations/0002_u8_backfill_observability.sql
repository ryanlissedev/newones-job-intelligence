ALTER TABLE "curated"."aanvraag" ADD COLUMN "v1_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "aanvraag_v1_id_uidx" ON "curated"."aanvraag" ("v1_id") WHERE "v1_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" DROP CONSTRAINT "scrape_run_kind_check";--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_kind_check" CHECK ("curated"."scrape_run"."run_kind" IN ('test', 'poll', 'backfill'));
