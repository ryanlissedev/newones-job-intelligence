-- Step 3 (operator, WRITES; needs Ryan's GO). Never deletes: snapshots every non-kept row into
-- curated.aanvraag_dup_archive and sets superseded_by/at/reason on it, in ONE transaction.
-- Idempotent: only NOT-superseded rows are considered, so a re-run marks nothing new.
-- Run as ji_migrator with the writers stopped (option B: poller + projector), e.g.
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 03-mark-superseded.sql
-- Keep rule: see 02-plan-dry-run.sql (identical ORDER BY).
-- Locks: ROW EXCLUSIVE on curated.aanvraag + row locks on the marked rows only; readers are not
-- blocked. lock_timeout 5s: if a writer holds a row lock the script aborts and rolls back.
-- Fails closed (rollback) if any normalized duplicate group remains afterwards.
-- Search: every marked row gets an `aanvraag.verwijderd` outbox event in the same statement, so
-- the projector removes it from Manticore (the loader never re-adds a superseded row).
-- Rollback: 90-rollback.sql section A, then 91-rollback-unmark.sql (section B; restores from the
-- archive reason tag).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- One statement: plan, archive snapshot and mark share one snapshot (no TEMP privilege needed).
WITH ranked AS (
  SELECT a.id, a.bron_id, a.bron_referentie,
         lower(btrim(a.bron_referentie)) AS normalized_referentie,
         row_number() OVER w AS rank_in_group,
         first_value(a.id) OVER w AS keep_id
    FROM curated.aanvraag a
   WHERE a.superseded_by IS NULL
  WINDOW w AS (PARTITION BY a.bron_id, lower(btrim(a.bron_referentie))
               ORDER BY a.laatst_gezien_op DESC NULLS LAST, (a.v1_id IS NULL) DESC,
                        a.compleetheid_score DESC NULLS LAST, a.eerste_gezien_op ASC, a.id ASC)
), mark_plan AS (
  SELECT id, keep_id, bron_id, bron_referentie, normalized_referentie
    FROM ranked
   WHERE rank_in_group > 1
), archived AS (
  INSERT INTO curated.aanvraag_dup_archive
    (aanvraag_id, kept_aanvraag_id, bron_id, bron_referentie, normalized_referentie, reason, row_snapshot)
  SELECT p.id, p.keep_id, p.bron_id, p.bron_referentie, p.normalized_referentie,
         'dup-key-normalized-v1', to_jsonb(a.*)
    FROM mark_plan p
    JOIN curated.aanvraag a ON a.id = p.id
  RETURNING aanvraag_id
), marked AS (
  UPDATE curated.aanvraag a
     SET superseded_by = p.keep_id,
         superseded_at = now(),
         superseded_reason = 'dup-key-normalized-v1'
    FROM mark_plan p
   WHERE a.id = p.id
     AND a.superseded_by IS NULL
  RETURNING a.id
), projected AS (
  -- The marked row must leave the search index: same transaction, outbox last (RJC-399).
  INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload)
  SELECT m.id, 'aanvraag', 'aanvraag.verwijderd',
         jsonb_build_object('reden', 'superseded', 'superseded_reason', 'dup-key-normalized-v1')
    FROM marked m
  RETURNING aggregate_id
)
SELECT (SELECT count(*) FROM mark_plan) AS planned,
       (SELECT count(*) FROM archived) AS archived,
       (SELECT count(*) FROM marked) AS marked,
       (SELECT count(*) FROM projected) AS index_deletes_enqueued;

DO $$
DECLARE
  remaining bigint;
  unarchived bigint;
BEGIN
  SELECT count(*) INTO remaining FROM (
    SELECT 1 FROM curated.aanvraag
     WHERE superseded_by IS NULL
     GROUP BY bron_id, lower(btrim(bron_referentie))
    HAVING count(*) > 1) g;
  SELECT count(*) INTO unarchived
    FROM curated.aanvraag a
   WHERE a.superseded_reason = 'dup-key-normalized-v1'
     AND NOT EXISTS (SELECT 1 FROM curated.aanvraag_dup_archive r
                      WHERE r.aanvraag_id = a.id AND r.reason = 'dup-key-normalized-v1'
                        AND r.restored_at IS NULL);
  IF remaining <> 0 OR unarchived <> 0 THEN
    RAISE EXCEPTION 'mark-superseded check failed: % duplicate group(s) left, % marked row(s) without archive snapshot',
      remaining, unarchived;
  END IF;
  RAISE NOTICE 'mark-superseded ok: 0 duplicate groups left, every marked row has an archive snapshot';
END $$;

COMMIT;
