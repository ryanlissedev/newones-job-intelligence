CREATE TABLE "curated"."bron_health" (
	"bron_id" uuid PRIMARY KEY NOT NULL,
	"circuit_status" text DEFAULT 'closed' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"silence_alert_open" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."bron_health" ADD CONSTRAINT "bron_health_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "curated"."bron_health" ADD CONSTRAINT "bron_health_circuit_status_check" CHECK (length(trim("circuit_status")) > 0);
--> statement-breakpoint
CREATE TABLE "curated"."alert" (
	"acked_at" timestamp with time zone,
	"acked_by" text,
	"bron_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."alert" ADD CONSTRAINT "alert_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "alert_bron_id_idx" ON "curated"."alert" USING btree ("bron_id");
--> statement-breakpoint
CREATE INDEX "alert_dedupe_key_idx" ON "curated"."alert" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "alert_open_idx" ON "curated"."alert" USING btree ("dedupe_key") WHERE "acked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "curated"."alert" ADD CONSTRAINT "alert_dedupe_key_check" CHECK (length(trim("dedupe_key")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."alert" ADD CONSTRAINT "alert_kind_check" CHECK (length(trim("kind")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."alert" ADD CONSTRAINT "alert_message_check" CHECK (length(trim("message")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."alert" ADD CONSTRAINT "alert_acked_consistency_check" CHECK (("acked_at" IS NULL AND "acked_by" IS NULL) OR ("acked_at" IS NOT NULL AND "acked_by" IS NOT NULL));
