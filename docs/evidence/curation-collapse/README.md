# Evidence: drain unchanged re-observation chains through their newest link

Branch `perf/curation-collapse-unchanged-chains`, base `main`. Harness: [`evidence-harness.ts`](./evidence-harness.ts).
Ran 2026-10-09 against a scratch Postgres DB (`ji_evidence_c`, all migrations applied). There was no prod access.

## Why

Prod measurement (2026-10-09):
- ~757k observations are awaiting curation, 684k of them `unchanged`.
- Randstad has 208k, Techniekwerkt 210k and ZZP 126k.
- 6 sources curated 0 in 7 days.

The dominated-unchanged sweep (`markDominatedUnchangedObservations`) joined every awaiting `unchanged` row with
**every** later same-hash sibling. A chain of N re-observations of one listing gives ~N²/2 pairs, so the 5000-pair
sweep covered only a handful of rows per pass. The rest fell through to one-by-one curation: ≤100 attempts per pass,
each with a raw read.

## Change

The sweep is now `SELECT DISTINCT ON (dominated id)`. Each row is paired with its **best** dominator: an already-applied one
first, else the newest. The 5000-row sweep then covers 5000 rows, and their dominators collapse to the chain head:
one raw check per identity.

All existing safety rules are unchanged, because the same `resolveDominatedPairs` and `markSuppressedBehindApplied` logic runs:
- A row is superseded only behind an applied dominator, or behind a dominator whose raw is readable. Such a row is
  suppressed until that dominator applies.
- A missing, malformed or failing dominator supersedes nothing. The RJC-433/RJC-621 tests in
  `curation-history-recovery.spec.ts` cover this, and they all pass.

There is no schema change and no new write path.

(An earlier draft superseded behind awaiting heads with no raw proof. The gate's RJC-621 tests rejected it, rightly:
a head with missing raw would lose the refresh. It was replaced before any push.)

## Result (2 identities, N later succeeded runs each re-observing both unchanged)

| chain length N | main a4ff669 | this PR |
|---|---|---|
| 100 (200 rows) | 2 passes, 0.4 s, 22 curated one-by-one | 1 pass, 0.1 s, 2 curated |
| 500 (1,000 rows) | 24 passes, 8.2 s, 412 curated one-by-one | 1 pass, 1.7 s, 2 curated |
| 2000 (4,000 rows) | 35 passes, 53.2 s, 522 curated one-by-one | 1 pass, 34.2 s, 2 curated |

Each case reaches the same end state:
- one row per identity applied, the rest superseded;
- `laatst_gezien_op` equals the newest run;
- no new version.

At N=2000 the DISTINCT ON sort over the N² join dominates the wall time. Prod chains are about 4 runs/day × the backlog
age. The `aanvraag_observation (bron_id, status, created_at)` index in PR-I also helps here.

### main (baseline)
```
=== main a4ff669, CHAIN_RUNS=100 ===
run 1 (recorded Hero fixtures): curated=2
synthetic backlog: 100 later runs x 2 identities = 200 unchanged rows awaiting curation
result: passes=2 wall=0.4s remaining=0 superseded=178 curated-unchanged=22
observation statuses: curated=2 superseded=178 unchanged=22
laatst_gezien_op reached the newest run on every aanvraag: true
=== main a4ff669, CHAIN_RUNS=500 ===
run 1 (recorded Hero fixtures): curated=2
synthetic backlog: 500 later runs x 2 identities = 1000 unchanged rows awaiting curation
result: passes=24 wall=8.2s remaining=0 superseded=588 curated-unchanged=412
observation statuses: curated=2 superseded=588 unchanged=412
laatst_gezien_op reached the newest run on every aanvraag: true
=== main a4ff669, CHAIN_RUNS=2000 (earlier run) ===
result: passes=35 wall=53.2s remaining=0 superseded=3478 curated-unchanged=522
```

### this PR
```
=== this PR, CHAIN_RUNS=100 ===
run 1 (recorded Hero fixtures): curated=2
synthetic backlog: 100 later runs x 2 identities = 200 unchanged rows awaiting curation
result: passes=1 wall=0.1s remaining=0 superseded=198 curated-unchanged=2
observation statuses: curated=2 superseded=198 unchanged=2
laatst_gezien_op reached the newest run on every aanvraag: true
=== this PR, CHAIN_RUNS=500 ===
run 1 (recorded Hero fixtures): curated=2
synthetic backlog: 500 later runs x 2 identities = 1000 unchanged rows awaiting curation
result: passes=1 wall=1.7s remaining=0 superseded=998 curated-unchanged=2
observation statuses: curated=2 superseded=998 unchanged=2
laatst_gezien_op reached the newest run on every aanvraag: true
run 1 (recorded Hero fixtures): curated=2
synthetic backlog: 2000 later runs x 2 identities = 4000 unchanged rows awaiting curation
  pass 1: superseded=3998 unchanged=2 remaining=0
result: passes=1 wall=34.2s remaining=0 superseded=3998 curated-unchanged=2
observation statuses: curated=2 superseded=3998 unchanged=2
laatst_gezien_op reached the newest run on every aanvraag: true
```

## Tests

- `apps/worker/src/curation-recovery.spec.ts`: "drains a chain of unchanged re-observations through its newest link in one pass,
  losing nothing". Three poll runs fail on raw reads and pile up a chain. One drain pass then supersedes every older link and
  applies the head. `laatst_gezien_op` ≥ the newest run, and there is no new version.
- `packages/db/src/curation-history-recovery.spec.ts` (69 incl. curate specs) passes. This includes the dominator-raw-missing,
  malformed-dominator and dominator-fails cases.
