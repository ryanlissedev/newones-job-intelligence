ALTER TABLE "curated"."dedup_groep" ADD COLUMN "dedup_key" text;
--> statement-breakpoint
-- Pre-0015 the dedup key lived in "methode" with no uniqueness guarantee, so a
-- find-then-insert race under READ COMMITTED could create two groups for one
-- key. Merge such duplicates deterministically before the unique index goes
-- on: per key the survivor is the manually confirmed group first, then the
-- oldest by (created_at, id). Every aanvraag on a losing group moves to the
-- survivor. Only rows whose "methode" is an actual key (contains the U+001F
-- field separator) take part; other "methode" values are left untouched.
WITH ranked AS (
	SELECT
		"id",
		first_value("id") OVER (
			PARTITION BY "methode"
			ORDER BY "handmatig_bevestigd" DESC, "created_at" ASC, "id" ASC
		) AS "survivor_id"
	FROM "curated"."dedup_groep"
	WHERE "methode" IS NOT NULL AND position(chr(31) IN "methode") > 0
),
losers AS (
	SELECT "id", "survivor_id" FROM ranked WHERE "id" <> "survivor_id"
)
UPDATE "curated"."aanvraag" AS a
SET "dedup_groep_id" = losers."survivor_id"
FROM losers
WHERE a."dedup_groep_id" = losers."id";
--> statement-breakpoint
WITH ranked AS (
	SELECT
		"id",
		first_value("id") OVER (
			PARTITION BY "methode"
			ORDER BY "handmatig_bevestigd" DESC, "created_at" ASC, "id" ASC
		) AS "survivor_id"
	FROM "curated"."dedup_groep"
	WHERE "methode" IS NOT NULL AND position(chr(31) IN "methode") > 0
),
losers AS (
	SELECT "id" FROM ranked WHERE "id" <> "survivor_id"
)
DELETE FROM "curated"."dedup_groep" AS d
USING losers
WHERE d."id" = losers."id";
--> statement-breakpoint
UPDATE "curated"."dedup_groep"
SET "dedup_key" = "methode"
WHERE "dedup_key" IS NULL
	AND "methode" IS NOT NULL
	AND position(chr(31) IN "methode") > 0;
--> statement-breakpoint
CREATE UNIQUE INDEX "dedup_groep_dedup_key_uidx" ON "curated"."dedup_groep" USING btree ("dedup_key") WHERE "dedup_key" IS NOT NULL;
