ALTER TABLE "curated"."aanvraag_enrichment" DROP CONSTRAINT "aanvraag_enrichment_field_check";
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_enrichment" ADD CONSTRAINT "aanvraag_enrichment_field_check" CHECK ("field" IN ('locatie', 'tarief', 'contract', 'remote', 'publicatiedatum', 'beschrijving', 'uren', 'opleiding', 'startdatum', 'einddatum', 'sluitingsdatum', 'organisatie'));
