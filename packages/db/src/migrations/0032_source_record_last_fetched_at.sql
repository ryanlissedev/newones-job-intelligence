-- Additive: when the detail page of a source record was last fetched and
-- recorded. Lets a run fetch never-fetched and longest-unfetched items
-- first, so a budget-cut crawl resumes where the previous one stopped.
-- Nullable, no default: existing rows read as "fetch time unknown" and sort
-- before any row with a time, and the ALTER is a catalog-only change.
ALTER TABLE "staging"."source_record" ADD COLUMN IF NOT EXISTS "last_fetched_at" timestamp with time zone;
