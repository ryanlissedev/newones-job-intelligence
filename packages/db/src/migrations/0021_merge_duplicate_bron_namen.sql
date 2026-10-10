-- Merge Motian seed Opdrachtoverheid/Striive rows onto live register ids, then
-- prevent same-name duplicates. Live ids win on (bron_id, bron_referentie):
-- Motian orphans whose referentie already exists on the live bron are DELETED,
-- not field-merged. Acceptable for Motian seed collision cleanup; do not reuse
-- this pattern for production dual-ingest without an explicit merge plan.

-- Opdrachtoverheid: Motian ...031 -> live ...0ad
UPDATE curated.aanvraag AS orphan
SET bron_id = '00000000-0000-4000-8000-0000000000ad'
WHERE orphan.bron_id = '00000000-0000-4000-8000-000000000031'
  AND NOT EXISTS (
    SELECT 1
    FROM curated.aanvraag AS live
    WHERE live.bron_id = '00000000-0000-4000-8000-0000000000ad'
      AND live.bron_referentie = orphan.bron_referentie
  );
--> statement-breakpoint
DELETE FROM curated.aanvraag
WHERE bron_id = '00000000-0000-4000-8000-000000000031';
--> statement-breakpoint
UPDATE staging.source_record AS orphan
SET bron_id = '00000000-0000-4000-8000-0000000000ad'
WHERE orphan.bron_id = '00000000-0000-4000-8000-000000000031'
  AND NOT EXISTS (
    SELECT 1
    FROM staging.source_record AS live
    WHERE live.bron_id = '00000000-0000-4000-8000-0000000000ad'
      AND live.bron_referentie = orphan.bron_referentie
  );
--> statement-breakpoint
DELETE FROM staging.source_record
WHERE bron_id = '00000000-0000-4000-8000-000000000031';
--> statement-breakpoint
UPDATE staging.aanvraag_observation
SET bron_id = '00000000-0000-4000-8000-0000000000ad'
WHERE bron_id = '00000000-0000-4000-8000-000000000031';
--> statement-breakpoint
UPDATE curated.scrape_run
SET bron_id = '00000000-0000-4000-8000-0000000000ad'
WHERE bron_id = '00000000-0000-4000-8000-000000000031';
--> statement-breakpoint
UPDATE curated.aanvraag_bron_link AS orphan
SET bron_id = '00000000-0000-4000-8000-0000000000ad'
WHERE orphan.bron_id = '00000000-0000-4000-8000-000000000031'
  AND NOT EXISTS (
    SELECT 1
    FROM curated.aanvraag_bron_link AS live
    WHERE live.bron_id = '00000000-0000-4000-8000-0000000000ad'
      AND live.aanvraag_id = orphan.aanvraag_id
  );
--> statement-breakpoint
DELETE FROM curated.aanvraag_bron_link
WHERE bron_id = '00000000-0000-4000-8000-000000000031';
--> statement-breakpoint
DELETE FROM curated.bron
WHERE id = '00000000-0000-4000-8000-000000000031';
--> statement-breakpoint

-- Striive: Motian ...034 -> live ...008
UPDATE curated.aanvraag AS orphan
SET bron_id = '00000000-0000-4000-8000-000000000008'
WHERE orphan.bron_id = '00000000-0000-4000-8000-000000000034'
  AND NOT EXISTS (
    SELECT 1
    FROM curated.aanvraag AS live
    WHERE live.bron_id = '00000000-0000-4000-8000-000000000008'
      AND live.bron_referentie = orphan.bron_referentie
  );
--> statement-breakpoint
DELETE FROM curated.aanvraag
WHERE bron_id = '00000000-0000-4000-8000-000000000034';
--> statement-breakpoint
UPDATE staging.source_record AS orphan
SET bron_id = '00000000-0000-4000-8000-000000000008'
WHERE orphan.bron_id = '00000000-0000-4000-8000-000000000034'
  AND NOT EXISTS (
    SELECT 1
    FROM staging.source_record AS live
    WHERE live.bron_id = '00000000-0000-4000-8000-000000000008'
      AND live.bron_referentie = orphan.bron_referentie
  );
--> statement-breakpoint
DELETE FROM staging.source_record
WHERE bron_id = '00000000-0000-4000-8000-000000000034';
--> statement-breakpoint
UPDATE staging.aanvraag_observation
SET bron_id = '00000000-0000-4000-8000-000000000008'
WHERE bron_id = '00000000-0000-4000-8000-000000000034';
--> statement-breakpoint
UPDATE curated.scrape_run
SET bron_id = '00000000-0000-4000-8000-000000000008'
WHERE bron_id = '00000000-0000-4000-8000-000000000034';
--> statement-breakpoint
UPDATE curated.aanvraag_bron_link AS orphan
SET bron_id = '00000000-0000-4000-8000-000000000008'
WHERE orphan.bron_id = '00000000-0000-4000-8000-000000000034'
  AND NOT EXISTS (
    SELECT 1
    FROM curated.aanvraag_bron_link AS live
    WHERE live.bron_id = '00000000-0000-4000-8000-000000000008'
      AND live.aanvraag_id = orphan.aanvraag_id
  );
--> statement-breakpoint
DELETE FROM curated.aanvraag_bron_link
WHERE bron_id = '00000000-0000-4000-8000-000000000034';
--> statement-breakpoint
DELETE FROM curated.bron
WHERE id = '00000000-0000-4000-8000-000000000034';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS bron_naam_lower_uidx
  ON curated.bron (lower(naam));
