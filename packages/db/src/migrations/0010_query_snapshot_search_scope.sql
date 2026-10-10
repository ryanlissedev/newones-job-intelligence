ALTER TABLE "curated"."query_snapshot" ADD COLUMN "search_scope" text DEFAULT 'all' NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ALTER COLUMN "search_scope" SET DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD CONSTRAINT "query_snapshot_search_scope_check" CHECK ("search_scope" IN ('active', 'all'));
