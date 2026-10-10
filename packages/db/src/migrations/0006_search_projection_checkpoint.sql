ALTER TABLE "curated"."outbox_event" ADD COLUMN "sequence_number" bigint;
--> statement-breakpoint
UPDATE "curated"."outbox_event" SET "sequence_number" = "numbered"."seq"
FROM (
	SELECT "id", row_number() OVER (ORDER BY "created_at" ASC, "id" ASC) AS "seq"
	FROM "curated"."outbox_event"
) AS "numbered"
WHERE "curated"."outbox_event"."id" = "numbered"."id";
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ALTER COLUMN "sequence_number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ALTER COLUMN "sequence_number" ADD GENERATED ALWAYS AS IDENTITY;
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('curated.outbox_event', 'sequence_number'), COALESCE((SELECT MAX("sequence_number") FROM "curated"."outbox_event"), 0) + 1, false);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_sequence_number_uidx" ON "curated"."outbox_event" USING btree ("sequence_number");
--> statement-breakpoint
CREATE TABLE "curated"."search_projection_checkpoint" (
	"index_name" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"applied_sequence" bigint NOT NULL,
	"schema_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."search_projection_checkpoint" ADD CONSTRAINT "search_projection_checkpoint_generation_check" CHECK ("generation" >= 1);
--> statement-breakpoint
ALTER TABLE "curated"."search_projection_checkpoint" ADD CONSTRAINT "search_projection_checkpoint_applied_sequence_check" CHECK ("applied_sequence" >= 0);
