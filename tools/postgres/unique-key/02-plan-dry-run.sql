-- Step 2 (operator, read-only). Shows exactly what 03-mark-superseded.sql would mark, using the
-- same keep rule. Safe as ji_readonly or ji_migrator; BEGIN READ ONLY ... ROLLBACK.
--   psql "<url>" -X -v ON_ERROR_STOP=1 -f 02-plan-dry-run.sql
--
-- Keep rule per (bron_id, lower(btrim(bron_referentie))) group of NOT-superseded rows, first wins:
--   1. most recent laatst_gezien_op (the row the live poller still updates)
--   2. live row (v1_id IS NULL) before a v1-backfill row
--   3. highest compleetheid_score
--   4. oldest eerste_gezien_op (longest history)
--   5. lowest id (deterministic tie-break)
BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

WITH ranked AS (
  SELECT a.id, a.bron_id, a.v1_id, a.bron_referentie,
         lower(btrim(a.bron_referentie)) AS normalized_referentie,
         row_number() OVER w AS rank_in_group,
         first_value(a.id) OVER w AS keep_id,
         count(*) OVER (PARTITION BY a.bron_id, lower(btrim(a.bron_referentie))) AS group_size
    FROM curated.aanvraag a
   WHERE a.superseded_by IS NULL
  WINDOW w AS (PARTITION BY a.bron_id, lower(btrim(a.bron_referentie))
               ORDER BY a.laatst_gezien_op DESC NULLS LAST, (a.v1_id IS NULL) DESC,
                        a.compleetheid_score DESC NULLS LAST, a.eerste_gezien_op ASC, a.id ASC)
)
SELECT b.naam, r.bron_id,
       count(DISTINCT r.keep_id) AS groups,
       count(*) FILTER (WHERE r.rank_in_group > 1) AS rows_to_mark,
       count(*) FILTER (WHERE r.rank_in_group > 1 AND r.v1_id IS NOT NULL) AS v1_rows_to_mark,
       count(*) FILTER (WHERE r.rank_in_group > 1 AND r.v1_id IS NULL) AS live_rows_to_mark
  FROM ranked r JOIN curated.bron b ON b.id = r.bron_id
 WHERE r.group_size > 1
 GROUP BY b.naam, r.bron_id
 ORDER BY rows_to_mark DESC;

WITH ranked AS (
  SELECT a.id, a.bron_id, a.v1_id, a.bron_referentie, a.laatst_gezien_op,
         lower(btrim(a.bron_referentie)) AS normalized_referentie,
         row_number() OVER w AS rank_in_group,
         first_value(a.id) OVER w AS keep_id,
         count(*) OVER (PARTITION BY a.bron_id, lower(btrim(a.bron_referentie))) AS group_size
    FROM curated.aanvraag a
   WHERE a.superseded_by IS NULL
  WINDOW w AS (PARTITION BY a.bron_id, lower(btrim(a.bron_referentie))
               ORDER BY a.laatst_gezien_op DESC NULLS LAST, (a.v1_id IS NULL) DESC,
                        a.compleetheid_score DESC NULLS LAST, a.eerste_gezien_op ASC, a.id ASC)
)
SELECT r.bron_id, r.normalized_referentie, r.id AS aanvraag_id, r.bron_referentie, r.v1_id,
       r.laatst_gezien_op, r.rank_in_group, r.keep_id,
       CASE WHEN r.rank_in_group = 1 THEN 'keep' ELSE 'mark superseded' END AS action
  FROM ranked r
 WHERE r.group_size > 1
 ORDER BY r.bron_id, r.normalized_referentie, r.rank_in_group
 LIMIT 200;

ROLLBACK;
