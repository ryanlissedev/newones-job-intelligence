ALTER TABLE "curated"."aanvraag" ADD COLUMN "opdrachtgever_naam" text;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN "start_datum" text;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN "contracttype" text;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN "werkvorm" text;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN "publicatiedatum" text;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN "uren_per_week" text;
--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD COLUMN "eind_datum" text;
--> statement-breakpoint
UPDATE "curated"."aanvraag"
SET
  "opdrachtgever_naam" = COALESCE(
    "opdrachtgever_naam",
    NULLIF(trim("bron_specifiek"->>'opdrachtgever_naam'), ''),
    NULLIF(trim("bron_specifiek"->>'opdrachtgeverNaam'), '')
  ),
  "start_datum" = COALESCE(
    "start_datum",
    NULLIF(trim("bron_specifiek"->>'start_datum'), ''),
    NULLIF(trim("bron_specifiek"->>'startDatum'), '')
  ),
  "contracttype" = COALESCE(
    "contracttype",
    NULLIF(trim("bron_specifiek"->>'contracttype'), ''),
    NULLIF(trim("bron_specifiek"->>'contract_type'), '')
  ),
  "werkvorm" = COALESCE(
    "werkvorm",
    NULLIF(trim("bron_specifiek"->>'werkvorm'), '')
  ),
  "publicatiedatum" = COALESCE(
    "publicatiedatum",
    NULLIF(trim("bron_specifiek"->>'publicatiedatum'), ''),
    NULLIF(trim("bron_specifiek"->>'gepubliceerd_op'), ''),
    NULLIF(trim("bron_specifiek"->>'publicatie_datum'), ''),
    NULLIF(trim("bron_specifiek"->>'json_ld_date_posted'), '')
  ),
  "uren_per_week" = COALESCE(
    "uren_per_week",
    NULLIF(trim("bron_specifiek"->>'uren_per_week'), ''),
    NULLIF(trim("bron_specifiek"->>'uren_per_week_raw'), '')
  ),
  "eind_datum" = COALESCE(
    "eind_datum",
    NULLIF(trim("bron_specifiek"->>'eind_datum'), ''),
    NULLIF(trim("bron_specifiek"->>'eindDatum'), '')
  );
