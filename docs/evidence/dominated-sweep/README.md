# Evidence: dominated-unchanged sweep rewrite

Branch `perf/dominated-sweep-lateral`, based on main `d335981`. Ran 2026-10-11 on a throwaway local
cluster (Postgres 17.11, shared_buffers 1 GB, work_mem 16 MB). No prod access.
Fixture: [`seed.sql`](./seed.sql), a scratch DB migrated through 0034.

## Why

On prod (Postgres 18.6; `staging.aanvraag_observation` ~2.05M rows, `staging.source_record` 42,463,
`curated.aanvraag` 278,013) the dominated sweep in `markDominatedUnchangedObservations`
(`curate-scrape-run.ts`, alias `dominating_observation`) takes ~25 s per pass.

Old query: `SELECT DISTINCT ON (o.id) ...` over a self-join of every recoverable `unchanged` row with every
later same-content sibling, then `ORDER BY o.id, applied DESC, gestart DESC LIMIT 5000`.

- Every pair of a same-hash chain is produced (~N²/2 per chain), with `payload` jsonb. All pairs are sorted
  before `DISTINCT ON` and `LIMIT` run.
- The `aanvraag.content_hash = o.content_hash` join is correlated, so the planner estimates **1 row** after it.
  It then nested-loops a **Seq Scan on scrape_run per pair**, twice (run and dominating_run).

## Synthetic data (prod-like volume and shape)

| table | rows |
|---|---|
| staging.aanvraag_observation | 2,004,278 (2.25 GB) |
| staging.source_record | 42,241 |
| curated.aanvraag | 277,993 |
| curated.scrape_run | 1,991 (24 brons, hourly, ~90% succeeded / 7% failed / 3% cancelled) |

24 brons. Each source record is re-observed in most runs after it first appears. The content hash changes
every 20-400 observations (`new`/`changed`/`unchanged`). Statuses are applied before a per-bron curation
frontier and recoverable after it. `perf-bron-1` is the treadmill source: 968k observations, 845k of them
recoverable `unchanged`. That is deliberately worse than prod's whole backlog.

## Result: old vs new, `bronId` = one bron, `eligibleRunStatuses` = ['succeeded'], limit 5000

| bron (recoverable unchanged rows) | old | new, without 0035 index | new, with 0035 index |
|---|---|---|---|
| perf-bron-5 (5,250) | **89.9 s** (EXPLAIN ANALYZE, 351M rows removed by join filters) | 164 ms | **157 ms** |
| perf-bron-17 (14.6k) | **238.8 s** (EXPLAIN ANALYZE, 41.5M buffers, 841M rows removed by join filter, 58 MB external sort) | 351 ms | **326 ms** |
| perf-bron-1 (845k) | **> 5 min**, cancelled | 1,983 ms | **1,856 ms** |

The "new" columns are the median of 5 warm calls of `selectDominatedPairs` through drizzle/postgres-js,
with bind parameters as in prod. EXPLAIN (ANALYZE, BUFFERS) of the new query:
bron-5 191 ms / 364k buffers, bron-17 362 ms / 768k buffers, bron-1 2.3 s / 3.4M buffers.

The 0035 index alone does **not** fix the old query. With the index, old bron-5 still took 34.9 s
(the same nested-loop scrape_run seq scans).

### Old plan (bron-17, abridged)

```
Limit (actual 238805 ms, rows=5000)
  Unique -> Sort (external merge, 59616 kB; 62230 pairs)
    Nested Loop  Join Filter: dominating_run.gestart > scrape_run.gestart ...  Rows Removed by Join Filter: 841,050,954
      Nested Loop  Join Filter: o.scrape_run_id = scrape_run.id               Rows Removed by Join Filter: 696,089,552
        ... (aanvraag ⋈ source_record ⋈ dominating_observation ⋈ aanvraag_observation, est rows=1, actual 515,676)
        Seq Scan on scrape_run                (loops=515,676)
      Seq Scan on scrape_run dominating_run   (loops=486,453)
Buffers: shared hit=41,536,118
```

### New plan (bron-17, with 0035)

```
Limit (actual 361 ms, rows=5000)
  Nested Loop                                   <- stops after 5,524 candidates
    Sort by o.id (12,230 candidates, 2 MB quicksort)
      aanvraag ⋈ source_record (hash) -> Index Scan aanvraag_observation_source_record_hash_idx o
      -> Index Scan scrape_run_pkey r
    Limit 1 -> Sort (applied DESC, gestart DESC, id DESC)   loops=5,524
      Index Scan aanvraag_observation_source_record_hash_idx d -> Index Scan scrape_run_pkey dr
Buffers: shared hit=767,880
```

## Rewrite

`selectDominatedPairs` (exported from `curate-scrape-run.ts`):

1. `candidate` is the dominated rows, with the same joins and filters as before, `ORDER BY o.id OFFSET 0`.
   The planner keeps this id order, so the outer `ORDER BY candidate.id LIMIT n` needs no sort above the lateral.
2. `CROSS JOIN LATERAL (... ORDER BY applied DESC, gestart DESC, d.id DESC LIMIT 1)` picks one dominator per
   candidate. That is the old `DISTINCT ON` choice. `d.id` only breaks ties between runs of one bron that
   started at the same instant, which the old query left unspecified.
3. The joins are 1:1 (PKs and the unique `(bron_id, bron_referentie)` on aanvraag), so no `DISTINCT ON` is needed.

The plan shape also holds as a generic (prepared) plan. `EXPLAIN (GENERIC_PLAN)` gives the same
Limit → Nested Loop → Sort(o.id) shape.

Parity: `packages/db/src/dominated-pairs-query.spec.ts` keeps the old drizzle query verbatim as an oracle. It
asserts identical rows for every bron × {succeeded, all} eligibility × {unscoped, each run} × limit {10000, 7, 1}
on a seeded fixture. The fixture mixes run statuses, content changes, every observation status, stale and closed
aanvraag rows, and applied and not-yet-applied dominators. A mutation (applied ordering flipped) makes it fail.
`curation-history-recovery.spec.ts`, `apps/worker/src/curation-recovery.spec.ts` and
`tools/backfill/*` (249 tests) pass unchanged.

## Optional index 0035 (separate PR)

The sibling-probe index `aanvraag_observation_source_record_hash_idx` (migration 0035, its `CONCURRENTLY`
pre-build script and operator plan) moved to its own draft PR, so this PR is the query rewrite only and adds
no migration. The "with 0035 index" column above was measured with that index built; the rewrite alone
(the "without" column) already carries the fix. **The rewrite carries the fix. The index is a secondary gain.**
