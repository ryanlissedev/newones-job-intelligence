ALTER TABLE "curated"."query_snapshot" ALTER COLUMN "index_version" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD COLUMN "search_generation" integer;
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD COLUMN "search_applied_sequence" bigint;
--> statement-breakpoint
UPDATE "curated"."query_snapshot"
SET "search_generation" = 1,
	"search_applied_sequence" = GREATEST(COALESCE("index_version", 0), 0);
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ALTER COLUMN "search_generation" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ALTER COLUMN "search_applied_sequence" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD CONSTRAINT "query_snapshot_search_generation_check" CHECK ("search_generation" >= 1);
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD CONSTRAINT "query_snapshot_search_applied_sequence_check" CHECK ("search_applied_sequence" >= 0);
