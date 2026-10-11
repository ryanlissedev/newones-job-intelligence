-- Stedin/Gasunie own bron ids: READ-ONLY precheck (run as ji_readonly, before and after apply).
--   psql "<url>" -X -v ON_ERROR_STOP=1 -f 01-precheck.sql
-- Expected today: …035 = Werkzoeken, …036 = Starapple (v1 backfill); no row on …046/…047;
-- no Stedin/Gasunie row anywhere; 0 live (non-v1) rows or poll runs under …035/…036.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';

\echo '== 1. bron rows on the old and new ids, and any stedin/gasunie/werkzoeken/starapple naam =='
SELECT id, naam, actief, status, voorwaarden_status, categorie, ingestie_type
  FROM curated.bron
 WHERE id IN ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000036',
              '00000000-0000-4000-8000-000000000046', '00000000-0000-4000-8000-000000000047')
    OR lower(naam) IN ('stedin', 'gasunie', 'werkzoeken', 'starapple')
 ORDER BY id;

\echo '== 2. data under …035/…036 by origin (anything not v1 would have to move; expected 0) =='
SELECT a.bron_id, (a.v1_id IS NOT NULL) AS from_v1, a.extractie_methode, count(*) AS aanvragen
  FROM curated.aanvraag a
 WHERE a.bron_id IN ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000036')
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo '== 3. scrape runs under …035/…036 by kind (poll runs would mean the json-ld connector ran there; expected 0) =='
SELECT bron_id, run_kind, status, count(*) AS runs, min(gestart) AS first_run, max(gestart) AS last_run
  FROM curated.scrape_run
 WHERE bron_id IN ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000036')
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo '== 4. staging/fetch state under …035/…036 (json-ld slugs would mean Stedin/Gasunie fetches; expected 0 or v1 only) =='
SELECT 'staging.source_record' AS table_name, bron_id, count(*) AS row_count
  FROM staging.source_record
 WHERE bron_id IN ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000036')
 GROUP BY bron_id
UNION ALL
SELECT 'staging.source_fetch_history', bron_id, count(*)
  FROM staging.source_fetch_history
 WHERE bron_id IN ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000036')
 GROUP BY bron_id
ORDER BY 1, 2;

ROLLBACK;
