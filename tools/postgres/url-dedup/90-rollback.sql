-- Rollback for url-dedup.sql (reason 'dup-url-v1'). Unmarks every row this step marked,
-- restoring it to live from the archive bookkeeping. Nothing is deleted; the archive rows stay
-- as audit trail with restored_at set. As ji_migrator, needs a GO:
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 90-rollback.sql
-- 0034 live-key index: url-dedup only marks pairs whose normalized bron_referentie differs, but
-- ingestion may since have created a live casing/whitespace variant of a marked row's key (the
-- marked row is outside the partial index). Such rows are NOT unmarked (that would violate the
-- index and abort the whole rollback): they stay marked, keep restored_at NULL, are counted in
-- skipped_live_key_collision and listed below for manual resolution.
-- Every unmarked row gets one `aanvraag.gewijzigd` outbox event so the projector re-indexes it.
-- Idempotent: a second run touches 0 rows and queues nothing.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
-- No writer may create a colliding live key between the check and the unmark.
LOCK TABLE curated.aanvraag IN SHARE ROW EXCLUSIVE MODE;
WITH candidates AS (
  SELECT a.id, a.bron_id, lower(btrim(a.bron_referentie)) AS live_key
    FROM curated.aanvraag a
    JOIN curated.aanvraag_dup_archive r ON r.aanvraag_id = a.id
   WHERE r.reason = 'dup-url-v1'
     AND r.restored_at IS NULL
     AND a.superseded_reason = 'dup-url-v1'
), colliding AS (
  -- A live row already holds the key, or two candidates would claim the same key.
  SELECT c.id FROM candidates c
   WHERE EXISTS (SELECT 1 FROM curated.aanvraag l
                  WHERE l.superseded_by IS NULL AND l.bron_id = c.bron_id
                    AND lower(btrim(l.bron_referentie)) = c.live_key AND l.id <> c.id)
      OR EXISTS (SELECT 1 FROM candidates o
                  WHERE o.bron_id = c.bron_id AND o.live_key = c.live_key AND o.id <> c.id)
), unmarked AS (
  UPDATE curated.aanvraag a
     SET superseded_by = NULL, superseded_at = NULL, superseded_reason = NULL
   WHERE a.id IN (SELECT id FROM candidates)
     AND a.id NOT IN (SELECT id FROM colliding)
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
       (SELECT count(*) FROM reprojected) AS index_upserts_enqueued,
       (SELECT count(*) FROM colliding) AS skipped_live_key_collision;

\echo '-- still marked (live-key collision; resolve by hand, then rerun)'
SELECT a.id, a.bron_id, a.bron_referentie
  FROM curated.aanvraag a
  JOIN curated.aanvraag_dup_archive r ON r.aanvraag_id = a.id
 WHERE r.reason = 'dup-url-v1' AND r.restored_at IS NULL AND a.superseded_reason = 'dup-url-v1'
 ORDER BY a.bron_id, a.id;
COMMIT;
