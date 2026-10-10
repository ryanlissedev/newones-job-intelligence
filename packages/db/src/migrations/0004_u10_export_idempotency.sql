CREATE TABLE "curated"."external_id_crosswalk" (
	"action_type" text NOT NULL,
	"canonical_vacancy_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_id" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."export_attempt" (
	"action_type" text NOT NULL,
	"approval_id" uuid NOT NULL,
	"canonical_vacancy_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text,
	"external_id" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" text NOT NULL,
	"target" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ADD CONSTRAINT "export_attempt_approval_id_approval_record_id_fk" FOREIGN KEY ("approval_id") REFERENCES "curated"."approval_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ADD CONSTRAINT "export_attempt_snapshot_id_query_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "curated"."query_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_id_crosswalk_idempotency_uidx" ON "curated"."external_id_crosswalk" USING btree ("target","canonical_vacancy_id","action_type");--> statement-breakpoint
CREATE INDEX "export_attempt_snapshot_id_idx" ON "curated"."export_attempt" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "export_attempt_idempotency_key_idx" ON "curated"."export_attempt" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "curated"."external_id_crosswalk" ADD CONSTRAINT "external_id_crosswalk_action_type_check" CHECK ("action_type" IN ('create'));--> statement-breakpoint
ALTER TABLE "curated"."external_id_crosswalk" ADD CONSTRAINT "external_id_crosswalk_target_check" CHECK ("target" IN ('spott'));--> statement-breakpoint
ALTER TABLE "curated"."external_id_crosswalk" ADD CONSTRAINT "external_id_crosswalk_external_id_check" CHECK (length(trim("external_id")) > 0);--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ADD CONSTRAINT "export_attempt_status_check" CHECK ("status" IN ('created', 'skipped', 'failed'));--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ADD CONSTRAINT "export_attempt_action_type_check" CHECK ("action_type" IN ('create'));--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ADD CONSTRAINT "export_attempt_target_check" CHECK ("target" IN ('spott'));
