ALTER TABLE "curated"."outbox_event" ALTER COLUMN "index_version" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ADD COLUMN "claimed_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ADD COLUMN "last_error" text;
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ADD COLUMN "dead_lettered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ADD COLUMN "claim_token" uuid;
--> statement-breakpoint
CREATE INDEX "outbox_event_aggregate_open_idx" ON "curated"."outbox_event" USING btree ("aggregate_id") WHERE "curated"."outbox_event"."processed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "curated"."outbox_event" ADD CONSTRAINT "outbox_event_retry_count_check" CHECK ("retry_count" >= 0);
--> statement-breakpoint
CREATE INDEX "outbox_event_claimable_idx" ON "curated"."outbox_event" USING btree ("sequence_number") WHERE "curated"."outbox_event"."processed_at" IS NULL AND "curated"."outbox_event"."dead_lettered_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "curated"."search_projection_state" (
	"aggregate_id" uuid PRIMARY KEY NOT NULL,
	"applied_sequence" bigint NOT NULL,
	"generation" integer NOT NULL,
	"projection_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."search_projection_state" ADD CONSTRAINT "search_projection_state_generation_check" CHECK ("generation" >= 1);
--> statement-breakpoint
ALTER TABLE "curated"."search_projection_state" ADD CONSTRAINT "search_projection_state_applied_sequence_check" CHECK ("applied_sequence" >= 0);
