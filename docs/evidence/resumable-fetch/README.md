# Scrape-architecture PR7: closure separated from fetch, resumable budget-cut crawls

Recorded 2026-10-09 ~12:00 CEST on the box. No network beyond 127.0.0.1; the
local Postgres is a scratch DB.

`evidence-harness.ts` drives the **real json-ld connector → `executeBronRun`**
with the **Postgres** observation recorder, run store and missed-poll
lifecycle ports. The setup:

- A local sitemap host lists 60 jobs.
- The crawl delay is 100 ms, and the run budget is a real `AbortSignal.timeout(2150 ms)`, which is enough for about 20 detail fetches. That is the Techniekwerkt situation in miniature: a crawl that never fits its budget (8 of 9 prod runs cut at 5.5 h, MEASURED.md).
- `job-5` is fetched in run 1 and gone from the listing from run 2 on.

The same file ran unchanged on two trees:

- **base:** `git archive` of `perf/additive-hot-path-indexes` (#474), migrated with its own migrations (up to 0031);
- **PR7:** this branch (migration 0032 applied).

### base

```
tree: base (listing order); 60 jobs, crawl delay 100 ms, run budget 2150 ms, 4 runs; job-5 disappears from the listing after run 1
run 1: fetched 21 (job-1 … job-21), completeness aborted, lifecycle {"incremented":0,"skippedIncrementReason":"aborted"}; distinct jobs fetched so far 21/60; job-5 missed_polls=0
run 2: fetched 19 (job-1 … job-20), completeness aborted, lifecycle {"incremented":0,"skippedIncrementReason":"aborted"}; distinct jobs fetched so far 21/60; job-5 missed_polls=0
run 3: fetched 20 (job-1 … job-21), completeness aborted, lifecycle {"incremented":0,"skippedIncrementReason":"aborted"}; distinct jobs fetched so far 21/60; job-5 missed_polls=0
run 4: fetched 20 (job-1 … job-21), completeness aborted, lifecycle {"incremented":0,"skippedIncrementReason":"aborted"}; distinct jobs fetched so far 21/60; job-5 missed_polls=0
```

### PR7

```
tree: PR7 (resume-order lookup); 60 jobs, crawl delay 100 ms, run budget 2150 ms, 4 runs; job-5 disappears from the listing after run 1
run 1: fetched 21 (job-1 … job-21), completeness aborted, lifecycle {"incremented":0,"skippedIncrementReason":null}; distinct jobs fetched so far 21/60; job-5 missed_polls=0
run 2: fetched 19 (job-22 … job-40), completeness aborted, lifecycle {"incremented":1,"skippedIncrementReason":null}; distinct jobs fetched so far 40/60; job-5 missed_polls=1
run 3: fetched 20 (job-41 … job-60), completeness aborted, lifecycle {"incremented":1,"skippedIncrementReason":null}; distinct jobs fetched so far 60/60; job-5 missed_polls=2
run 4: fetched 20 (job-1 … job-21), completeness aborted, lifecycle {"incremented":1,"skippedIncrementReason":null}; distinct jobs fetched so far 60/60; job-5 missed_polls=3
```

## Reading

| | base | PR7 |
|---|---|---|
| distinct jobs fetched after 4 budget-cut runs | **21 / 60**: every run re-fetches the head | **60 / 60** after 3 runs, then the oldest are refreshed first |
| closure for a job gone from a fully discovered listing | never: every run is `aborted` → `skippedIncrementReason: "aborted"` | counted each run: `missed_polls` 1 → 2 → 3 (stale at the threshold of 3) |

The run is still recorded as `aborted` / `budget_exhausted` (fetch completeness).
Only closure and fetch order changed.

## Not changed (finding)

If the budget fires in the short window after a detail fetch returned and before
its raw-object write, the run fails with `RAW_STORE_WRITE_FAILED` instead of
stopping cleanly. This is deliberate since CTP-490 ("persistence abort is never
benign") and is pinned by the cohort specs, so PR7 leaves it alone. With PR7 the
next run still resumes from the items that run never reached.
