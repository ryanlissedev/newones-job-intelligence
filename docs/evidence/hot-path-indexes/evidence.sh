#!/usr/bin/env bash
# PR-I evidence: prod-shaped outbox (600k processed, all inside retention, so the prune deletes 0 like prod).
# Measure the prune before/after the operator CONCURRENTLY script, then show that 0031 is a no-op afterwards.
set -euo pipefail
DB=ji_evidence_i2
export PGPASSWORD=ji_migrator_local
P="psql -h 127.0.0.1 -U ji_migrator -d $DB -v ON_ERROR_STOP=1 -X -q"
URL="postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/$DB"
echo "== state: migrated through 0030 (the release before this PR) =="
bun docs/evidence/hot-path-indexes/migrate-helper.ts "$URL" /tmp/mig0030
$P -c "INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload, processed_at, created_at)
       SELECT gen_random_uuid(), 'aanvraag', 'aanvraag.upserted', jsonb_build_object('n', g, 'pad', repeat('x', 300)), now() - make_interval(secs => g % 86400), now() - make_interval(secs => g % 86400)
       FROM generate_series(1, 600000) g"
$P -c "VACUUM ANALYZE curated.outbox_event"
$P -At -c "SELECT 'outbox_event rows=' || count(*) || ' size=' || pg_size_pretty(pg_total_relation_size('curated.outbox_event')) FROM curated.outbox_event"
PRUNE="EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) DELETE FROM curated.outbox_event WHERE id IN (SELECT id FROM curated.outbox_event WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days' LIMIT 500)"
echo; echo "== BEFORE: outbox prune (retention 7d, nothing to delete) =="
$P -c "$PRUNE"
echo; echo "== operator pre-step: tools/postgres/indexes/0031-hot-path-indexes-concurrently.sql (psql autocommit) =="
time $P -f tools/postgres/indexes/0031-hot-path-indexes-concurrently.sql
echo; echo "== AFTER: outbox prune =="
$P -c "$PRUNE"

echo; echo "== deploy: drizzle migrate applies 0031 inside its transaction; every statement is IF NOT EXISTS, so it is a no-op =="
bun docs/evidence/hot-path-indexes/migrate-helper.ts "$URL" packages/db/src/migrations
$P -At -c "SELECT count(*) || ' of 5 hot-path indexes present and valid' FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indisvalid AND c.relname IN ('outbox_event_processed_at_idx','aanvraag_observation_bron_status_created_idx','aanvraag_bron_status_idx','aanvraag_dedup_groep_bron_idx','scrape_run_bron_gestart_idx')"
