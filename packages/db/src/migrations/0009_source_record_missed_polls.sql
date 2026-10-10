ALTER TABLE "staging"."source_record" ADD COLUMN "missed_polls" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD COLUMN "last_seen_scrape_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD COLUMN "last_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD COLUMN "last_missed_scrape_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD CONSTRAINT "source_record_last_missed_scrape_run_id_scrape_run_id_fk" FOREIGN KEY ("last_missed_scrape_run_id") REFERENCES "curated"."scrape_run"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD CONSTRAINT "source_record_last_seen_scrape_run_id_scrape_run_id_fk" FOREIGN KEY ("last_seen_scrape_run_id") REFERENCES "curated"."scrape_run"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD CONSTRAINT "source_record_missed_polls_check" CHECK ("missed_polls" >= 0);
