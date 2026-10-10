ALTER TABLE "curated"."aanvraag" ADD COLUMN "contactpersonen" jsonb DEFAULT '[]'::jsonb NOT NULL;
