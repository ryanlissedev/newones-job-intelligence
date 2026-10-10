CREATE TABLE "curated"."aanvraag_markering" (
	"aanvraag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reden" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"scope_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_markering" ADD CONSTRAINT "aanvraag_markering_aanvraag_id_aanvraag_id_fk" FOREIGN KEY ("aanvraag_id") REFERENCES "curated"."aanvraag"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "curated"."saved_search" ADD COLUMN "scope_id" text;
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD COLUMN "scope_id" text;
--> statement-breakpoint
ALTER TABLE "curated"."approval_record" ADD COLUMN "scope_id" text;
--> statement-breakpoint
ALTER TABLE "curated"."audit_event" ADD COLUMN "scope_id" text;
--> statement-breakpoint
ALTER TABLE "curated"."external_id_crosswalk" ADD COLUMN "scope_id" text;
--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ADD COLUMN "scope_id" text;
--> statement-breakpoint
ALTER TABLE "curated"."external_receipt" ADD COLUMN "scope_id" text;
--> statement-breakpoint
UPDATE "curated"."saved_search" SET "scope_id" = 'catapulze' WHERE "scope_id" IS NULL;
--> statement-breakpoint
UPDATE "curated"."query_snapshot" SET "scope_id" = 'catapulze' WHERE "scope_id" IS NULL;
--> statement-breakpoint
UPDATE "curated"."approval_record" SET "scope_id" = 'catapulze' WHERE "scope_id" IS NULL;
--> statement-breakpoint
UPDATE "curated"."audit_event" SET "scope_id" = 'catapulze' WHERE "scope_id" IS NULL;
--> statement-breakpoint
UPDATE "curated"."external_id_crosswalk" SET "scope_id" = 'catapulze' WHERE "scope_id" IS NULL;
--> statement-breakpoint
UPDATE "curated"."export_attempt" SET "scope_id" = 'catapulze' WHERE "scope_id" IS NULL;
--> statement-breakpoint
UPDATE "curated"."external_receipt" SET "scope_id" = 'catapulze' WHERE "scope_id" IS NULL;
--> statement-breakpoint
UPDATE "curated"."audit_event" SET "audit_class" = 'none' WHERE "audit_class" IS NULL;
--> statement-breakpoint
ALTER TABLE "curated"."saved_search" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."approval_record" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."audit_event" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."audit_event" ALTER COLUMN "audit_class" SET DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "curated"."audit_event" ALTER COLUMN "audit_class" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."external_id_crosswalk" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "curated"."external_receipt" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "aanvraag_markering_user_aanvraag_uidx" ON "curated"."aanvraag_markering" USING btree ("scope_id","user_id","aanvraag_id");
--> statement-breakpoint
CREATE INDEX "aanvraag_markering_scope_user_idx" ON "curated"."aanvraag_markering" USING btree ("scope_id","user_id");
--> statement-breakpoint
CREATE INDEX "aanvraag_markering_aanvraag_id_idx" ON "curated"."aanvraag_markering" USING btree ("aanvraag_id");
--> statement-breakpoint
CREATE INDEX "aanvraag_markering_user_id_idx" ON "curated"."aanvraag_markering" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "saved_search_scope_user_idx" ON "curated"."saved_search" USING btree ("scope_id","user_id");
--> statement-breakpoint
CREATE INDEX "query_snapshot_scope_id_idx" ON "curated"."query_snapshot" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "approval_record_scope_snapshot_idx" ON "curated"."approval_record" USING btree ("scope_id","snapshot_id");
--> statement-breakpoint
CREATE INDEX "audit_event_scope_actor_idx" ON "curated"."audit_event" USING btree ("scope_id","actor_id");
--> statement-breakpoint
DROP INDEX "curated"."external_id_crosswalk_idempotency_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "external_id_crosswalk_idempotency_uidx" ON "curated"."external_id_crosswalk" USING btree ("scope_id","target","canonical_vacancy_id","action_type");
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_markering" ADD CONSTRAINT "aanvraag_markering_status_check" CHECK ("status" IN ('relevant', 'niet_relevant', 'gevolgd'));
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_markering" ADD CONSTRAINT "aanvraag_markering_revision_check" CHECK ("revision" >= 1);
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_markering" ADD CONSTRAINT "aanvraag_markering_scope_id_check" CHECK (length(trim("scope_id")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."saved_search" ADD CONSTRAINT "saved_search_scope_id_check" CHECK (length(trim("scope_id")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD CONSTRAINT "query_snapshot_scope_id_check" CHECK (length(trim("scope_id")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."approval_record" ADD CONSTRAINT "approval_record_scope_id_check" CHECK (length(trim("scope_id")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."audit_event" ADD CONSTRAINT "audit_event_actor_type_check" CHECK ("actor_type" IN ('user', 'agent', 'service', 'system'));
--> statement-breakpoint
ALTER TABLE "curated"."audit_event" ADD CONSTRAINT "audit_event_audit_class_check" CHECK ("audit_class" IN ('access', 'effect', 'none'));
--> statement-breakpoint
ALTER TABLE "curated"."audit_event" ADD CONSTRAINT "audit_event_scope_id_check" CHECK (length(trim("scope_id")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."external_id_crosswalk" ADD CONSTRAINT "external_id_crosswalk_scope_id_check" CHECK (length(trim("scope_id")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."export_attempt" ADD CONSTRAINT "export_attempt_scope_id_check" CHECK (length(trim("scope_id")) > 0);
--> statement-breakpoint
ALTER TABLE "curated"."external_receipt" ADD CONSTRAINT "external_receipt_scope_id_check" CHECK (length(trim("scope_id")) > 0);
