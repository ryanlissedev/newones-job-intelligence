-- Evidence fixture for docs/evidence/dominated-sweep. Run on a scratch DB migrated through 0034, never on prod.
-- Synthetic prod-like data for the dominated-sweep query. Distribution is deterministic (hashtext); ids are random.
-- Needs a superuser (session_replication_role = replica skips FK triggers during the bulk load).
\set ON_ERROR_STOP 1
SET synchronous_commit = off;
SET session_replication_role = replica; -- skip FK triggers for bulk load speed
CREATE OR REPLACE FUNCTION pg_temp.h(text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT abs(hashtext($1)) $$;

-- 24 brons; bron 1 is the "treadmill" source with the big backlog.
CREATE TEMP TABLE b AS
SELECT i AS n,
       ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid AS id,
       CASE WHEN i = 1 THEN 12000 ELSE 1324 + (pg_temp.h('rc' || i) % 60) - 30 END AS records,
       CASE WHEN i = 1 THEN 150 ELSE 50 + pg_temp.h('rn' || i) % 70 END AS runs,
       CASE WHEN i = 1 THEN 0.30 ELSE 0.85 + (pg_temp.h('fr' || i) % 10) / 100.0 END AS frontier
FROM generate_series(1, 24) i;

INSERT INTO curated.bron (id, naam, categorie)
SELECT id, 'perf-bron-' || n, 'perf' FROM b;

-- Runs: unique gestart per run (hourly cadence, bron offset in seconds).
CREATE TEMP TABLE r AS
SELECT b.n AS bn, b.id AS bron_id, k AS idx,
       gen_random_uuid() AS id,
       timestamptz '2026-06-01 00:00:00+00' + (k * interval '1 hour') + (b.n * interval '7 seconds') AS gestart,
       CASE WHEN pg_temp.h('rs' || b.n || ':' || k) % 100 < 90 THEN 'succeeded'
            WHEN pg_temp.h('rs' || b.n || ':' || k) % 100 < 97 THEN 'failed'
            ELSE 'cancelled' END AS status
FROM b, generate_series(0, b.runs - 1) k;
CREATE INDEX ON r (bn, idx);
ANALYZE r;

INSERT INTO curated.scrape_run (id, bron_id, gestart, geindigd, status,
  failure_phase, failure_class, failure_code, failure_message, completion)
SELECT id, bron_id, gestart, gestart + interval '20 minutes', status,
  CASE WHEN status = 'failed' THEN 'fetch' END,
  CASE WHEN status = 'failed' THEN 'connector' END,
  CASE WHEN status = 'failed' THEN 'FETCH_FAILED' END,
  CASE WHEN status = 'failed' THEN 'Connector fetch failed' END,
  CASE WHEN status = 'succeeded' THEN 'complete' END
FROM r;

-- Source records: first seen at a skewed start run; change period controls content versions.
CREATE TEMP TABLE s AS
SELECT b.n AS bn, b.id AS bron_id, j,
       gen_random_uuid() AS id,
       'ref-' || b.n || '-' || j AS ref,
       (pg_temp.h('st' || b.n || ':' || j) % greatest(b.runs * 3 / 4, 1)) AS start_idx,
       20 + pg_temp.h('cp' || b.n || ':' || j) % 380 AS change_period,
       -- observation probability per run (chain length skew)
       CASE WHEN b.n = 1 THEN 70 + pg_temp.h('p' || j) % 31 ELSE 38 + pg_temp.h('p' || b.n || ':' || j) % 60 END AS p
FROM b, generate_series(1, b.records) j;
ANALYZE s;

-- Observations: record x run where run >= start and coin < p.
CREATE TEMP TABLE o AS
SELECT s.bn, s.bron_id, s.id AS source_record_id, s.ref, r.id AS scrape_run_id, r.idx, r.gestart,
       row_number() OVER (PARTITION BY s.id ORDER BY r.idx) - 1 AS ord,
       s.change_period
FROM s JOIN r ON r.bn = s.bn AND r.idx >= s.start_idx
WHERE pg_temp.h('o' || s.bn || ':' || s.j || ':' || r.idx) % 100 < s.p;
ALTER TABLE o ADD COLUMN ver int, ADD COLUMN outcome text, ADD COLUMN status text;
UPDATE o SET ver = ord / change_period,
  outcome = CASE WHEN ord = 0 THEN 'new' WHEN ord % change_period = 0 THEN 'changed' ELSE 'unchanged' END;
UPDATE o SET status = CASE
  WHEN o.idx < (SELECT floor(b.runs * b.frontier) FROM b WHERE b.n = o.bn) THEN
    CASE WHEN o.outcome <> 'unchanged' THEN 'curated'
         WHEN pg_temp.h('a' || o.source_record_id || o.idx) % 100 < 70 THEN 'unchanged'
         WHEN pg_temp.h('a' || o.source_record_id || o.idx) % 100 < 90 THEN 'superseded'
         WHEN pg_temp.h('a' || o.source_record_id || o.idx) % 100 < 99 THEN 'already_committed'
         ELSE 'curation_failed' END
  ELSE
    CASE WHEN pg_temp.h('w' || o.source_record_id || o.idx) % 100 < 85 THEN 'awaiting_curation'
         WHEN pg_temp.h('w' || o.source_record_id || o.idx) % 100 < 90 THEN 'pending'
         WHEN pg_temp.h('w' || o.source_record_id || o.idx) % 100 < 95 THEN 'blocked_ordering'
         WHEN pg_temp.h('w' || o.source_record_id || o.idx) % 100 < 98 THEN 'deferred_missing_raw'
         ELSE 'quarantined' END
  END;

CREATE TEMP TABLE mv AS SELECT source_record_id, max(ver) AS ver FROM o GROUP BY 1;
CREATE INDEX ON mv (source_record_id);
INSERT INTO staging.source_record (id, bron_id, bron_referentie, content_hash, raw_payload_ref, scrape_run_id, created_at)
SELECT s.id, s.bron_id, s.ref,
       md5(s.ref || ':' || coalesce((SELECT mv.ver FROM mv WHERE mv.source_record_id = s.id), 0)),
       'raw/' || s.bn || '/' || s.ref,
       coalesce((SELECT r.id FROM r WHERE r.bn = s.bn AND r.idx = s.start_idx), (SELECT r.id FROM r WHERE r.bn = s.bn LIMIT 1)),
       timestamptz '2026-06-01 00:00:00+00' + s.start_idx * interval '1 hour'
FROM s;

INSERT INTO staging.aanvraag_observation (id, bron_id, content_hash, created_at, outcome, parser_version, payload, scrape_run_id, source_record_id, status)
SELECT gen_random_uuid(), o.bron_id, md5(o.ref || ':' || o.ver), o.gestart + interval '5 minutes', o.outcome, 'v3',
  jsonb_build_object(
    'bronId', o.bron_id, 'bronReferentie', o.ref, 'contentHash', md5(o.ref || ':' || o.ver),
    'rawPayloadRef', 'raw/' || o.bn || '/' || o.ref || '/' || o.idx, 'scrapeRunId', o.scrape_run_id,
    'sourceRecordId', o.source_record_id, 'parserVersion', 'v3',
    'aanvraag', jsonb_build_object('titel', 'Synthetic vacancy title for ' || o.ref,
      'beschrijving', repeat('Lorem ipsum dolor sit amet ', 12), 'locatie', 'Amsterdam', 'uren', 36)),
  o.scrape_run_id, o.source_record_id, o.status
FROM o;

-- Curated aanvraag: one per source record (current content hash) + filler to ~278k.
INSERT INTO curated.aanvraag (bron_id, bron_referentie, content_hash, titel, beschrijving, extractie_methode,
  eerste_gezien_op, laatst_gezien_op, raw_payload_ref, scrape_run_id, status)
SELECT s.bron_id, sr.bron_referentie, sr.content_hash, 'titel', 'beschrijving', 'json-ld',
  sr.created_at, sr.created_at, sr.raw_payload_ref, sr.scrape_run_id,
  CASE WHEN pg_temp.h('as' || s.id) % 100 < 92 THEN 'active' ELSE 'closed' END
FROM s JOIN staging.source_record sr ON sr.id = s.id;

INSERT INTO curated.aanvraag (bron_id, bron_referentie, content_hash, titel, beschrijving, extractie_methode,
  eerste_gezien_op, laatst_gezien_op, raw_payload_ref, scrape_run_id, status)
SELECT b.id, 'legacy-' || b.n || '-' || g, md5('legacy' || g), 'titel', 'beschrijving', 'v1-import',
  now(), now(), 'raw/legacy/' || g, (SELECT r.id FROM r WHERE r.bn = b.n LIMIT 1),
  CASE WHEN g % 3 = 0 THEN 'active' ELSE 'closed' END
FROM b, generate_series(1, (278013 - (SELECT count(*) FROM s)) / 24) g;

SET session_replication_role = origin;
VACUUM (ANALYZE) staging.aanvraag_observation;
VACUUM (ANALYZE) staging.source_record;
VACUUM (ANALYZE) curated.aanvraag;
VACUUM (ANALYZE) curated.scrape_run;
