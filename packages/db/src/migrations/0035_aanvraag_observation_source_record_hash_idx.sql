-- Additive: one index for the dominated-unchanged sweep (curate-scrape-run.ts selectDominatedPairs).
-- No column, constraint or data change.
--
-- The sweep probes, per dominated row, its same-content siblings:
--   WHERE source_record_id = $1 AND content_hash = $2 (plus bron/status filters)
-- With only aanvraag_observation_source_record_id_idx every probe read the record's whole
-- observation history (all content versions); this index narrows it to the same-hash chain.
--
-- drizzle-kit runs every pending migration inside one transaction, and
-- CREATE INDEX CONCURRENTLY cannot run in a transaction. A plain CREATE INDEX here would hold a
-- SHARE lock on staging.aanvraag_observation (~2M rows on prod) and block every observation
-- write for the whole build. So, on a database with live traffic, run
-- tools/postgres/indexes/0035-aanvraag-observation-source-record-hash-concurrently.sql first
-- (psql, autocommit). This statement is then a no-op (IF NOT EXISTS). On an empty or dev
-- database it builds the index directly.
CREATE INDEX IF NOT EXISTS "aanvraag_observation_source_record_hash_idx"
  ON "staging"."aanvraag_observation" ("source_record_id", "content_hash");
