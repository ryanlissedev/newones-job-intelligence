-- Rollback for url-dedup.sql (reason 'dup-url-v1'). Unmarks every row this step marked,
-- restoring it to live from the archive bookkeeping. Nothing is deleted; the archive rows stay
-- as audit trail with restored_at set. As ji_migrator, needs a GO:
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 90-rollback.sql
-- Safe with the 0034 unique index in place: url-dedup only marks pairs whose normalized
-- bron_referentie differs, so unmarking never re-creates a duplicate live identity.
-- Every unmarked row gets one `aanvraag.gewijzigd` outbox event so the projector re-indexes it.
-- Idempotent: a second run touches 0 rows and queues nothing.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
WITH unmarked AS (
  UPDATE curated.aanvraag a
     SET superseded_by = NULL, superseded_at = NULL, superseded_reason = NULL
    FROM curated.aanvraag_dup_archive r
   WHERE r.aanvraag_id = a.id
     AND r.reason = 'dup-url-v1'
     AND r.restored_at IS NULL
     AND a.superseded_reason = 'dup-url-v1'
  RETURNING a.id
), restored AS (
  UPDATE curated.aanvraag_dup_archive
     SET restored_at = now()
   WHERE reason = 'dup-url-v1' AND restored_at IS NULL
     -- only the archive rows of rows this run actually unmarked
     AND aanvraag_id IN (SELECT id FROM unmarked)
  RETURNING id
), reprojected AS (
  -- Put the restored rows back in the search index (any non-delete event reloads and upserts).
  INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload)
  SELECT u.id, 'aanvraag', 'aanvraag.gewijzigd', jsonb_build_object('reden', 'supersede_rollback')
    FROM unmarked u
  RETURNING aggregate_id
)
SELECT (SELECT count(*) FROM unmarked) AS unmarked, (SELECT count(*) FROM restored) AS archive_rows_restored,
       (SELECT count(*) FROM reprojected) AS index_upserts_enqueued;
COMMIT;
