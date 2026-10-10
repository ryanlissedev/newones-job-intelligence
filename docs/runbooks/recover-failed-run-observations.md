# Recover observations from a failed or cancelled run (CTP-625)

## Why this exists

`curateScrapeRun` curates only observations whose `scrape_run` is `succeeded`.
That is the right default for the poll path: a run that is still `running`
has not finished recording, and a run that failed per record cannot say which
of its rows are sound. It has one blind spot. A run that recorded valid
observations and then died at a later step (discovery of the next page, the
checkpoint write, the completion write, a cancellation) leaves those rows in
`staging.aanvraag_observation` as `awaiting_curation` forever: valid raw in
the object store, valid payload, no path into `curated.aanvraag`, invisible in
search.

`tools/backfill/recover-failed-run-observations.ts` runs the ordinary
curation pass over exactly one such run. It adds no second curation
implementation: `curateScrapeRun` gained two options, `eligibleRunStatuses`
(default `["succeeded"]`, unchanged for the poller) and `scopeToRun` (default
`false`), and the tool sets them to the run's own status and `true`.
Identity ordering, dominated-duplicate supersession, cleared fields, missing
raw deferral and `curation_failed` parking are therefore the runtime's.

## Eligibility

Decided per run before any observation is read, by `classifyRunEligibility`:

| Run                                                                                  | Verdict                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `cancelled`                                                                          | eligible                                       |
| `failed`, `fouten = 0`                                                               | eligible                                       |
| `failed`, code in `DISCOVER_FAILED`, `CHECKPOINT_WRITE_FAILED`, `COMPLETE_WRITE_FAILED`, `UNEXPECTED_FAILURE`, `LEGACY_FAILURE` | eligible (run-level failure)                   |
| `failed`, `fouten > 0`, code `FETCH_FAILED` / `RAW_STORE_WRITE_FAILED` / `OBSERVATION_WRITE_FAILED` | ineligible, `per_record_failure`               |
| `succeeded`, `running`                                                               | ineligible, the poll path owns them            |

An ineligible run exits with code 2 and mutates nothing.

Per observation the pass then applies the same rules as a poll: status in the
recoverable set, payload passes the contract check, raw present (a missing
raw defers the row, it is not lost), pointer order against committed history.

What the tool never does: change `scrape_run.status`, `fouten` or any
completeness counter. The run stays `failed`/`cancelled`, so lifecycle
reconciliation keeps treating it as an incomplete scan and no record can be
marked disappeared because of a recovery.

## Procedure

Both commands need `DATABASE_URL` and the raw object store variables the
worker uses (`RAW_S3_*`, or `RAW_OBJECT_STORE_PATH` for the filesystem
store). Run them from the repo root on the box, as the worker user.

1. Report (read-only, default):

   ```sh
   bun tools/backfill/recover-failed-run-observations.ts --run <scrapeRunId> --limit 100
   ```

   Read `eligibility`, `byStatus`, `recoverable`, `parseInvalid` and
   `missingRawInSample`. `parseInvalid > 0` means rows the pass will mark
   malformed; `missingRawInSample > 0` means rows it will defer.

2. Apply, only when ingest for that bron is quiesced (paused in the poller or
   the bron `actief = false`), so the pass does not race a live poll on the
   same identities:

   ```sh
   bun tools/backfill/recover-failed-run-observations.ts --run <scrapeRunId> --apply --ingest-quiesced --limit 100
   ```

   The receipt carries the `CurateScrapeRunResult` (`curated`, `unchanged`,
   `superseded`, `failed`, `pending`, `remaining`). Redirect stdout to a file
   and attach it to the release or incident record.

3. Repeat step 2 until `remaining` is `0`. The observation status marker is
   the resume cursor: a row that curated, superseded, deferred or parked has
   left the recoverable set, so a rerun continues where the last pass
   stopped, and a run with nothing left reports `curated: 0`.

`--limit` is bounded by the runtime's `attemptLimit` ceiling of 500 so a
recovery cannot starve current ingest; keep it at 100 while polls are
paused for one bron only.

## Failure behaviour

- Object store unreachable or a transient Postgres error: the pass throws,
  exit code 1, every row keeps its previous status. Fix the outage and rerun.
- A candidate whose normalisation throws is parked as `curation_failed`, the
  same as in a poll; see `curation-recovery.md` for the repair path.
- Wrong `--run`: an unknown id is an error; a `succeeded` id exits 2 with
  `run_succeeded`.

## Rollback

The tool writes through the normal curation store, so a recovered record is
an ordinary `curated.aanvraag` row with `aanvraag_versie` history pointing at
the failed run's observation. There is no separate undo: treat an unwanted
recovery as a normal curated record and use the lifecycle correction path.
Reverting the code change restores the previous behaviour immediately, since
both new options default to the old values.

## Evidence

`tools/backfill/recover-failed-run-observations.integration.spec.ts` seeds a
`failed` (`DISCOVER_FAILED`, `fouten = 0`) run, a `cancelled` run, a
per-record `FETCH_FAILED` run and two cancelled runs side by side, and
asserts: the default pass leaves them untouched, report mode mutates
nothing, apply curates exactly the named run's rows once, a second apply
converges to `curated: 0`, the per-record run is refused, and an object-store
outage aborts without parking.
