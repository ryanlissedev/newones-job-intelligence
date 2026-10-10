CREATE TABLE "curated"."export_effect" (
	"action_type" text NOT NULL,
	"canonical_vacancy_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_id" text,
	"external_id_source" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"target" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "export_effect_key_uidx" ON "curated"."export_effect" USING btree ("scope_id","target","canonical_vacancy_id","action_type");
--> statement-breakpoint
ALTER TABLE "curated"."export_effect" ADD CONSTRAINT "export_effect_action_type_check" CHECK ("action_type" IN ('create'));
--> statement-breakpoint
ALTER TABLE "curated"."export_effect" ADD CONSTRAINT "export_effect_target_check" CHECK ("target" IN ('spott'));
--> statement-breakpoint
ALTER TABLE "curated"."export_effect" ADD CONSTRAINT "export_effect_status_check" CHECK ("status" IN ('reserved', 'external_id_acquired', 'confirmed'));
--> statement-breakpoint
ALTER TABLE "curated"."export_effect" ADD CONSTRAINT "export_effect_external_id_source_check" CHECK ("external_id_source" IS NULL OR "external_id_source" IN ('provider_response', 'manual_evidence'));
--> statement-breakpoint
ALTER TABLE "curated"."export_effect" ADD CONSTRAINT "export_effect_evidence_check" CHECK ((
	"status" = 'reserved'
	AND "external_id" IS NULL
	AND "external_id_source" IS NULL
) OR (
	"status" IN ('external_id_acquired', 'confirmed')
	AND "external_id" IS NOT NULL
	AND length(trim("external_id")) > 0
	AND "external_id_source" IS NOT NULL
));
--> statement-breakpoint
ALTER TABLE "curated"."export_effect" ADD CONSTRAINT "export_effect_scope_id_check" CHECK (length(trim("scope_id")) > 0);
