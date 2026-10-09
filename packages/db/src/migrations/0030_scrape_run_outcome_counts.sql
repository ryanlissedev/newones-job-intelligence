-- Additive: per-run outcome taxonomy. Existing rows get '{}' / 0 / NULL.
-- completion separates budget-cut/partial succeeded runs from complete ones.
ALTER TABLE "curated"."scrape_run" ADD COLUMN "ongewijzigd" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "outcome_counts" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "failure_kind" text;
--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "completion" text;
--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_ongewijzigd_check" CHECK ("ongewijzigd" >= 0);
--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_outcome_counts_object_check" CHECK (jsonb_typeof("outcome_counts") = 'object');
--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_failure_kind_check" CHECK ("failure_kind" IS NULL OR ("status" = 'failed' AND "failure_kind" IN ('blocked', 'rate_limited', 'timeout', 'http_5xx', 'http_4xx', 'not_found', 'network', 'internal')));
--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_completion_kind_check" CHECK ("completion" IS NULL OR ("status" = 'succeeded' AND "completion" IN ('complete', 'budget_exhausted', 'aborted', 'truncated', 'resumed', 'empty')));
