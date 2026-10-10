# Evidence: additive hot-path indexes (migration 0031)

Branch `perf/additive-hot-path-indexes`, stacked on PR1 (`feat/scrape-run-outcome-taxonomy`, migration 0030).
Ran 2026-10-09 against a scratch Postgres DB (`ji_evidence_i2`). There was no prod access.
Scripts: [`evidence.sh`](./evidence.sh) and [`migrate-helper.ts`](./migrate-helper.ts).

## Why

Prod measurement (MEASURED.md, 2026-10-09; Postgres 18.6, shared_buffers 128 MB):

- The poller's outbox prune runs every ~60 s and full-seq-scans `curated.outbox_event`: 87k pages (~680 MB) per pass, 0 rows deleted.
- The overlap endpoint scans `curated.aanvraag` at least 4× (3.3 s of DB time).
- Curation backlog and run-stats queries have no per-bron composite index.

## Why the operator script, too

drizzle-kit runs every pending migration in **one transaction**. I confirmed this in `drizzle-orm/pg-core/dialect.js`: `session.transaction(...)`.
`CREATE INDEX CONCURRENTLY` cannot run there. So:

- `tools/postgres/indexes/0031-hot-path-indexes-concurrently.sql` is run first by an operator, in psql autocommit mode.
  It builds without blocking writes, outbox index first, and ends with an invalid-index check.
- `0031_hot_path_indexes.sql` uses `CREATE INDEX IF NOT EXISTS`. On prod, after the pre-step, it is a no-op.
  On dev, CI or an empty DB, it builds the indexes directly.

## Result (600k processed outbox rows, all inside retention, so 0 deletes, like prod)

| outbox prune | plan | buffers | time |
|---|---|---|---|
| before | Seq Scan, 600,000 rows removed by filter | 35,295 (24,397 read) | 153.6 ms |
| after | Bitmap Index Scan on outbox_event_processed_at_idx | 3 | 0.16 ms |

After the pre-step, `drizzle migrate` applied 0031 with five "already exists, skipping" notices, and all 5 of 5 indexes are valid.

```
== state: migrated through 0030 (the release before this PR) ==
migrated; latest created_at=1790467200000; notices: none
outbox_event rows=600000 size=312 MB

== BEFORE: outbox prune (retention 7d, nothing to delete) ==
                                                       QUERY PLAN                                                       
------------------------------------------------------------------------------------------------------------------------
 Delete on outbox_event (actual time=153.432..153.435 rows=0 loops=1)
   Buffers: shared hit=10898 read=24397 written=32
   ->  Nested Loop (actual time=153.431..153.433 rows=0 loops=1)
         Buffers: shared hit=10898 read=24397 written=32
         ->  HashAggregate (actual time=153.430..153.431 rows=0 loops=1)
               Group Key: "ANY_subquery".id
               Batches: 1  Memory Usage: 24kB
               Buffers: shared hit=10898 read=24397 written=32
               ->  Subquery Scan on "ANY_subquery" (actual time=153.427..153.428 rows=0 loops=1)
                     Buffers: shared hit=10898 read=24397 written=32
                     ->  Limit (actual time=153.425..153.426 rows=0 loops=1)
                           Buffers: shared hit=10898 read=24397 written=32
                           ->  Seq Scan on outbox_event outbox_event_1 (actual time=153.424..153.424 rows=0 loops=1)
                                 Filter: ((processed_at IS NOT NULL) AND (processed_at < (now() - '7 days'::interval)))
                                 Rows Removed by Filter: 600000
                                 Buffers: shared hit=10898 read=24397 written=32
         ->  Index Scan using outbox_event_pkey on outbox_event (never executed)
               Index Cond: (id = "ANY_subquery".id)
 Planning:
   Buffers: shared hit=255 read=1 written=1
 Planning Time: 0.888 ms
 Execution Time: 153.564 ms
(22 rows)


== operator pre-step: tools/postgres/indexes/0031-hot-path-indexes-concurrently.sql (psql autocommit) ==
 invalid_index 
---------------
(0 rows)


real	0m0.424s
user	0m0.028s
sys	0m0.005s

== AFTER: outbox prune ==
                                                            QUERY PLAN                                                            
----------------------------------------------------------------------------------------------------------------------------------
 Delete on outbox_event (actual time=0.041..0.043 rows=0 loops=1)
   Buffers: shared hit=3
   ->  Nested Loop (actual time=0.040..0.041 rows=0 loops=1)
         Buffers: shared hit=3
         ->  HashAggregate (actual time=0.040..0.041 rows=0 loops=1)
               Group Key: "ANY_subquery".id
               Batches: 1  Memory Usage: 24kB
               Buffers: shared hit=3
               ->  Subquery Scan on "ANY_subquery" (actual time=0.037..0.038 rows=0 loops=1)
                     Buffers: shared hit=3
                     ->  Limit (actual time=0.037..0.037 rows=0 loops=1)
                           Buffers: shared hit=3
                           ->  Bitmap Heap Scan on outbox_event outbox_event_1 (actual time=0.036..0.036 rows=0 loops=1)
                                 Recheck Cond: (processed_at < (now() - '7 days'::interval))
                                 Buffers: shared hit=3
                                 ->  Bitmap Index Scan on outbox_event_processed_at_idx (actual time=0.031..0.031 rows=0 loops=1)
                                       Index Cond: (processed_at < (now() - '7 days'::interval))
                                       Buffers: shared hit=3
         ->  Index Scan using outbox_event_pkey on outbox_event (never executed)
               Index Cond: (id = "ANY_subquery".id)
 Planning:
   Buffers: shared hit=272 read=3
 Planning Time: 1.193 ms
 Execution Time: 0.164 ms
(24 rows)


== deploy: drizzle migrate applies 0031 inside its transaction; every statement is IF NOT EXISTS, so it is a no-op ==
migrated; latest created_at=1790553600000; notices: schema "drizzle" already exists, skipping | relation "__drizzle_migrations" already exists, skipping | relation "outbox_event_processed_at_idx" already exists, skipping | relation "aanvraag_observation_bron_status_created_idx" already exists, skipping | relation "aanvraag_bron_status_idx" already exists, skipping | relation "aanvraag_dedup_groep_bron_idx" already exists, skipping | relation "scrape_run_bron_gestart_idx" already exists, skipping
5 of 5 hot-path indexes present and valid
```

## Tests

- `packages/db/src/hot-path-indexes.spec.ts`:
  - all 5 indexes exist and are valid;
  - the prune can plan on `outbox_event_processed_at_idx`;
  - the operator script runs statement by statement as a no-op after 0031, and its invalid-index check is empty.
- `readiness.spec.ts` and `migration-journal.spec.ts` cover the new journal entry (idx 31, when 1790553600000).
