CREATE TABLE "curated"."external_receipt" (
	"canonical_vacancy_id" uuid NOT NULL,
	"confirmed_effect" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"export_attempt_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_hash" text NOT NULL,
	"spott_vacancy_id" text
);
--> statement-breakpoint
ALTER TABLE "curated"."external_receipt" ADD CONSTRAINT "external_receipt_export_attempt_id_export_attempt_id_fk" FOREIGN KEY ("export_attempt_id") REFERENCES "curated"."export_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_receipt_export_attempt_uidx" ON "curated"."external_receipt" USING btree ("export_attempt_id");--> statement-breakpoint
CREATE INDEX "external_receipt_canonical_vacancy_id_idx" ON "curated"."external_receipt" USING btree ("canonical_vacancy_id");--> statement-breakpoint
ALTER TABLE "curated"."external_receipt" ADD CONSTRAINT "external_receipt_response_hash_check" CHECK (length(trim("response_hash")) > 0);--> statement-breakpoint
ALTER TABLE "curated"."external_receipt" ADD CONSTRAINT "external_receipt_confirmed_spott_id_check" CHECK (("confirmed_effect" = false) OR ("spott_vacancy_id" IS NOT NULL AND length(trim("spott_vacancy_id")) > 0));
