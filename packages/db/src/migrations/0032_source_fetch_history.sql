-- Additive: when a run last processed each listed reference of a bron
-- (fetched, skipped on a known listing hash, or rejected). Lets the next run
-- process never-seen and longest-unprocessed references first, so a
-- budget-cut crawl resumes where the previous one stopped. Rejected
-- references have no source_record row, so this is its own table.
CREATE TABLE IF NOT EXISTS "staging"."source_fetch_history" (
  "bron_id" uuid NOT NULL,
  "bron_referentie" text NOT NULL,
  "last_fetched_at" timestamp with time zone NOT NULL,
  CONSTRAINT "source_fetch_history_pkey" PRIMARY KEY ("bron_id", "bron_referentie"),
  CONSTRAINT "source_fetch_history_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE cascade ON UPDATE no action
);
