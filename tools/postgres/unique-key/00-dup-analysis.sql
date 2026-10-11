-- 00-dup-analysis.sql: READ-ONLY duplicate analysis for the (bron_id, bron_referentie) key.
--
-- Run as ji_readonly on the ji-postgres host (db catapulze), e.g.
--   psql "host=<db host> dbname=catapulze user=ji_readonly" -X -v ON_ERROR_STOP=1 \
--        -f dup-analysis.sql > dup-analysis.out 2>&1
--
-- Safety:
--   * Only SELECT statements, inside BEGIN READ ONLY ... ROLLBACK. Any write raises
--     "cannot execute ... in a read-only transaction" and nothing is committed.
--   * statement_timeout 60s per query and lock_timeout 2s: this never waits behind DDL
--     and never holds more than ACCESS SHARE locks (same as any SELECT).
--   * Output contains only ids (aanvraag/source_record uuids, v1_id, bron_referentie,
--     which is the external posting id), bron names and counts. No titles,
--     descriptions, contacts or other personal data.
--
-- Normalization tiers used below (each tier includes the previous one):
--   T1 btrim(ref)                                         (leading/trailing whitespace)
--   T2 lower(T1)                                          (casing)
--   T3 T2, trailing '/' trimmed, internal whitespace and '_' -> '-', repeated '-' collapsed
--      (mirrors the Starapple URL slug normalization and urlSlugBronReferentie)

\set ON_ERROR_STOP 1
\pset pager off
\pset null '(null)'

BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

\echo '== 0. session (read_only must be on) =='
SELECT current_user, current_database(), current_setting('transaction_read_only') AS read_only,
       current_setting('statement_timeout') AS statement_timeout, now() AS run_at;

\echo '== 1. key indexes present and valid =='
SELECT n.nspname AS schema, t.relname AS table_name, i.relname AS index_name,
       x.indisunique AS is_unique, x.indisvalid AS is_valid, pg_get_indexdef(x.indexrelid) AS definition
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE (n.nspname, t.relname) IN (('curated','aanvraag'), ('staging','source_record'),
                                  ('staging','aanvraag_observation'), ('curated','aanvraag_bron_link'),
                                  ('staging','source_fetch_history'))
   AND (x.indisunique OR x.indisprimary)
 ORDER BY 1, 2, 3;

\echo '== 2. relations in app schemas NOT owned by ji_migrator (expect 0 rows) =='
SELECT schemaname, tablename, tableowner
  FROM pg_tables
 WHERE schemaname IN ('public','staging','curated','marts','drizzle')
   AND tableowner <> 'ji_migrator'
 ORDER BY 1, 2;

\echo '== 3. row counts =='
SELECT 'curated.aanvraag' AS table_name, count(*) AS row_count FROM curated.aanvraag
UNION ALL SELECT 'staging.source_record', count(*) FROM staging.source_record
UNION ALL SELECT 'staging.aanvraag_observation', count(*) FROM staging.aanvraag_observation
UNION ALL SELECT 'curated.aanvraag_bron_link', count(*) FROM curated.aanvraag_bron_link
UNION ALL SELECT 'curated.bron', count(*) FROM curated.bron;

\echo '== 4. curated.aanvraag per bron: v1 rows (v1_id set) vs live rows (v1_id null) =='
SELECT b.id AS bron_id, b.naam, b.actief, b.config_ref,
       count(a.id) AS total,
       count(a.id) FILTER (WHERE a.v1_id IS NOT NULL) AS v1_rows,
       count(a.id) FILTER (WHERE a.v1_id IS NULL) AS live_rows
  FROM curated.bron b
  LEFT JOIN curated.aanvraag a ON a.bron_id = b.id
 GROUP BY b.id, b.naam, b.actief, b.config_ref
 ORDER BY total DESC, b.naam;

\echo '== 5. exact duplicate groups on (bron_id, bron_referentie) (expect 0: unique indexes) =='
SELECT 'curated.aanvraag' AS table_name, count(*) AS dup_groups
  FROM (SELECT 1 FROM curated.aanvraag GROUP BY bron_id, bron_referentie HAVING count(*) > 1) g
UNION ALL
SELECT 'staging.source_record', count(*)
  FROM (SELECT 1 FROM staging.source_record GROUP BY bron_id, bron_referentie HAVING count(*) > 1) g
UNION ALL
SELECT 'curated.aanvraag_bron_link (>1 aanvraag per bron+ref)', count(*)
  FROM (SELECT 1 FROM curated.aanvraag_bron_link GROUP BY bron_id, bron_referentie
        HAVING count(DISTINCT aanvraag_id) > 1) g;

\echo '== 6. null / empty / padded / non-normalized bron_referentie =='
SELECT 'curated.aanvraag' AS table_name,
       count(*) FILTER (WHERE bron_referentie IS NULL) AS null_ref,
       count(*) FILTER (WHERE btrim(bron_referentie) = '') AS empty_ref,
       count(*) FILTER (WHERE bron_referentie <> btrim(bron_referentie)) AS padded_ref,
       count(*) FILTER (WHERE bron_referentie <> lower(bron_referentie)) AS has_uppercase,
       count(*) FILTER (WHERE bron_referentie ~ '/$') AS trailing_slash,
       count(*) FILTER (WHERE bron_referentie ~ '%[0-9A-Fa-f]{2}') AS percent_encoded,
       count(*) FILTER (WHERE bron_referentie ~ '^https?://') AS full_url
  FROM curated.aanvraag
UNION ALL
SELECT 'staging.source_record',
       count(*) FILTER (WHERE bron_referentie IS NULL),
       count(*) FILTER (WHERE btrim(bron_referentie) = ''),
       count(*) FILTER (WHERE bron_referentie <> btrim(bron_referentie)),
       count(*) FILTER (WHERE bron_referentie <> lower(bron_referentie)),
       count(*) FILTER (WHERE bron_referentie ~ '/$'),
       count(*) FILTER (WHERE bron_referentie ~ '%[0-9A-Fa-f]{2}'),
       count(*) FILTER (WHERE bron_referentie ~ '^https?://')
  FROM staging.source_record;

\echo '== 7. collisions that only appear after normalization, per tier and bron (curated.aanvraag) =='
WITH k AS (
  SELECT bron_id, bron_referentie,
         btrim(bron_referentie) AS t1,
         lower(btrim(bron_referentie)) AS t2,
         regexp_replace(regexp_replace(regexp_replace(lower(btrim(bron_referentie)), '/+$', ''), '[[:space:]_]+', '-', 'g'), '-{2,}', '-', 'g') AS t3
    FROM curated.aanvraag
), tiers AS (
  SELECT 'T1 trim' AS tier, bron_id, t1 AS norm, count(*) AS n, count(DISTINCT bron_referentie) AS variants FROM k GROUP BY bron_id, t1
  UNION ALL
  SELECT 'T2 +lower', bron_id, t2, count(*), count(DISTINCT t1) FROM k GROUP BY bron_id, t2
  UNION ALL
  SELECT 'T3 +slash/space/underscore/dashes', bron_id, t3, count(*), count(DISTINCT t2) FROM k GROUP BY bron_id, t3
)
SELECT tiers.tier, b.naam, tiers.bron_id,
       count(*) AS new_groups_at_tier,
       sum(tiers.n) AS rows_in_groups,
       sum(tiers.n) - count(*) AS rows_that_would_be_superseded
  FROM tiers JOIN curated.bron b ON b.id = tiers.bron_id
 WHERE tiers.n > 1 AND tiers.variants > 1
 GROUP BY tiers.tier, b.naam, tiers.bron_id
 ORDER BY tiers.tier, rows_in_groups DESC;

\echo '== 8. examples of T3 collisions (max 30 groups; ids only) =='
WITH k AS (
  SELECT a.id, a.bron_id, a.bron_referentie, a.v1_id, a.laatst_gezien_op, a.status,
         regexp_replace(regexp_replace(regexp_replace(lower(btrim(a.bron_referentie)), '/+$', ''), '[[:space:]_]+', '-', 'g'), '-{2,}', '-', 'g') AS t3
    FROM curated.aanvraag a
), g AS (
  SELECT bron_id, t3 FROM k GROUP BY bron_id, t3 HAVING count(*) > 1 ORDER BY bron_id, t3 LIMIT 30
)
SELECT b.naam, k.t3 AS normalized_ref, k.bron_referentie AS raw_ref, k.id AS aanvraag_id,
       k.v1_id, (k.v1_id IS NULL) AS is_live, k.status, k.laatst_gezien_op
  FROM k JOIN g USING (bron_id, t3) JOIN curated.bron b ON b.id = k.bron_id
 ORDER BY b.naam, k.t3, k.laatst_gezien_op DESC NULLS LAST;

\echo '== 9. T3 collisions in staging.source_record, per bron =='
WITH k AS (
  SELECT bron_id, regexp_replace(regexp_replace(regexp_replace(lower(btrim(bron_referentie)), '/+$', ''), '[[:space:]_]+', '-', 'g'), '-{2,}', '-', 'g') AS t3 FROM staging.source_record
), g AS (
  SELECT bron_id, t3, count(*) AS n FROM k GROUP BY bron_id, t3 HAVING count(*) > 1
)
SELECT b.naam, g.bron_id, count(*) AS groups, sum(g.n) AS rows_in_groups
  FROM g JOIN curated.bron b ON b.id = g.bron_id
 GROUP BY b.naam, g.bron_id
 ORDER BY rows_in_groups DESC;

\echo '== 10. v1 vs live duplicates within one bron: same normalized posting URL, different referentie =='
WITH k AS (
  SELECT a.id, a.bron_id, a.v1_id, a.bron_referentie, regexp_replace(lower(btrim(split_part(split_part(a.bron_url, '#', 1), '?', 1))), '/+$', '') AS url_norm
    FROM curated.aanvraag a
   WHERE a.bron_url IS NOT NULL AND btrim(a.bron_url) <> ''
), g AS (
  SELECT bron_id, url_norm,
         count(*) AS n,
         count(*) FILTER (WHERE v1_id IS NOT NULL) AS v1_rows,
         count(*) FILTER (WHERE v1_id IS NULL) AS live_rows
    FROM k GROUP BY bron_id, url_norm HAVING count(*) > 1
)
SELECT b.naam, g.bron_id,
       count(*) AS url_groups,
       count(*) FILTER (WHERE g.v1_rows > 0 AND g.live_rows > 0) AS v1_and_live_groups,
       count(*) FILTER (WHERE g.live_rows = 0) AS v1_only_groups,
       count(*) FILTER (WHERE g.v1_rows = 0) AS live_only_groups,
       sum(g.n) AS rows_in_groups
  FROM g JOIN curated.bron b ON b.id = g.bron_id
 GROUP BY b.naam, g.bron_id
 ORDER BY rows_in_groups DESC;

\echo '== 11. examples for section 10 (max 20 v1+live groups; ids only) =='
WITH k AS (
  SELECT a.id, a.bron_id, a.v1_id, a.bron_referentie, a.laatst_gezien_op, regexp_replace(lower(btrim(split_part(split_part(a.bron_url, '#', 1), '?', 1))), '/+$', '') AS url_norm
    FROM curated.aanvraag a
   WHERE a.bron_url IS NOT NULL AND btrim(a.bron_url) <> ''
), g AS (
  SELECT bron_id, url_norm FROM k GROUP BY bron_id, url_norm
  HAVING count(*) FILTER (WHERE v1_id IS NOT NULL) > 0 AND count(*) FILTER (WHERE v1_id IS NULL) > 0
  ORDER BY bron_id, url_norm LIMIT 20
)
SELECT b.naam, k.bron_id, k.id AS aanvraag_id, k.v1_id, k.bron_referentie, k.laatst_gezien_op
  FROM k JOIN g USING (bron_id, url_norm) JOIN curated.bron b ON b.id = k.bron_id
 ORDER BY b.naam, k.url_norm, k.v1_id NULLS LAST;

\echo '== 12. bron-id collision 035/036 (Werkzoeken/Starapple vs Stedin/Gasunie): which rows live there =='
SELECT b.id AS bron_id, b.naam, b.config_ref, b.actief,
       coalesce(r.run_kind, '(no run)') AS run_kind,
       (a.v1_id IS NOT NULL) AS from_v1,
       a.extractie_methode,
       (a.bron_referentie ~ '^[0-9]+$') AS numeric_ref,
       (a.bron_referentie ~ '/') AS ref_has_slash,
       count(*) AS row_count,
       min(a.eerste_gezien_op) AS first_seen,
       max(a.laatst_gezien_op) AS last_seen
  FROM curated.aanvraag a
  JOIN curated.bron b ON b.id = a.bron_id
  LEFT JOIN curated.scrape_run r ON r.id = a.scrape_run_id
 WHERE a.bron_id IN ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000036')
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
 ORDER BY 2, row_count DESC;

\echo '== 13. scrape runs against 035/036 by kind and status =='
SELECT r.bron_id, b.naam, r.run_kind, r.status, count(*) AS runs, min(r.gestart) AS first_run, max(r.gestart) AS last_run
  FROM curated.scrape_run r
  JOIN curated.bron b ON b.id = r.bron_id
 WHERE r.bron_id IN ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000036')
 GROUP BY 1, 2, 3, 4
 ORDER BY 1, 3, 4;

\echo '== 14. bron rows named like stedin/gasunie/werkzoeken/starapple (seed conflict check) =='
SELECT id, naam, actief, categorie, config_ref
  FROM curated.bron
 WHERE lower(naam) ~ '(stedin|gasunie|werkzoeken|starapple)'
 ORDER BY naam;

\echo '== 15. v1 rows per bron: referentie shape =='
SELECT b.naam, count(*) AS v1_rows,
       count(*) FILTER (WHERE a.bron_referentie <> btrim(a.bron_referentie)) AS padded,
       count(*) FILTER (WHERE a.bron_referentie ~ '^https?://') AS url_as_ref,
       count(*) FILTER (WHERE a.bron_referentie ~ '^[0-9]+$') AS numeric_ref
  FROM curated.aanvraag a JOIN curated.bron b ON b.id = a.bron_id
 WHERE a.v1_id IS NOT NULL
 GROUP BY b.naam
 ORDER BY v1_rows DESC;

ROLLBACK;
\echo '== done (rolled back, nothing written) =='
