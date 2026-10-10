CREATE TABLE "curated"."aanvraag_enrichment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aanvraag_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric NOT NULL,
	"raw_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_enrichment" ADD CONSTRAINT "aanvraag_enrichment_aanvraag_id_aanvraag_id_fk" FOREIGN KEY ("aanvraag_id") REFERENCES "curated"."aanvraag"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "aanvraag_enrichment_aanvraag_field_uidx" ON "curated"."aanvraag_enrichment" USING btree ("aanvraag_id","field");
--> statement-breakpoint
CREATE INDEX "aanvraag_enrichment_aanvraag_id_idx" ON "curated"."aanvraag_enrichment" USING btree ("aanvraag_id");
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_enrichment" ADD CONSTRAINT "aanvraag_enrichment_field_check" CHECK ("field" IN ('locatie', 'tarief', 'contract', 'remote'));
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_enrichment" ADD CONSTRAINT "aanvraag_enrichment_source_check" CHECK ("source" IN ('deterministic', 'llm'));
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_enrichment" ADD CONSTRAINT "aanvraag_enrichment_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1);
