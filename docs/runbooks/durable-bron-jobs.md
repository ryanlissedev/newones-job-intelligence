# Durable bron jobs (CTP-622)

## Why this exists

The inline poller runs a due source in the process that noticed it was due. If
that process dies mid-run, the row it left behind is only repaired by the
six-hour `POLLER_ABANDON_RUN_AFTER_MS` sweeper, and the next poll starts a new
`scrape_run` rather than finishing the one that was interrupted. CTP-622 makes
the dispatch itself durable for one source at a time — Striive first — so a
worker crash anywhere between "source is due" and "result committed" produces
exactly one domain result after any restart.

The mechanism is Effect `PersistedQueue` (`effect@4.0.0-rc.112`) over a
postgres-js backed store, `packages/db/src/persisted-queue-store.ts`. The
bundled `makeStoreSql` was deliberately not used: it runs DDL at startup to
create its table, and the worker must never hold DDL privileges. The table
comes from migration `0029_durable_job_queue.sql`, applied through the
operator lane like every other migration. No Workflow or Cluster machinery is
involved — the job is a plain durable queue item.

## How a job flows

1. The scheduler finds Striive due. Because `striive` is listed in
   `POLLER_DURABLE_BRONNEN`, `main.ts` offers a `BronIngestJob`
   `{bronId, bronSlug, scrapeRunId}` to the `bron-ingest` queue instead of
   running it inline, and logs `poller_source_queued`.
2. The job's queue identity **is** its `scrapeRunId`. Re-offering the same job
   is a no-op on `durable_job_id_queue_uidx`, and
   `durable_job_open_bron_uidx` — a partial unique index on
   `(queue_name, element->>'bronId') WHERE completed = false` — makes a second
   offer of a bron that still has an open job a no-op as well. That index is
   the business idempotency; the queue's own dedup is only transport.
3. The consumer takes one job at a time (single executor per bron) and calls
   `runBronIngestPipeline` with the job's `scrapeRunId`. The pipeline's
   existing behaviour does the exactly-once work: a fresh `scrapeRunId`
   starts a `reset` run; a replayed job finds the same row `running` or
   `failed` and resumes it under a bumped fence token from its stored
   checkpoint, or finds it `succeeded` and replays without a second domain
   mutation. The domain commit and the outbox intent stay in the pipeline's
   single transaction — the queue ack only happens after that commit
   succeeds.
4. On success the row flips `completed = true` and `last_failure` is cleared.
   On a thrown error the store's scope finalizer spends one attempt
   (`attempts + 1`, `last_failure` recorded, claim released) and the row
   becomes claimable again — until the attempt that reaches `maxAttempts`,
   which closes the row instead.

## Retry semantics (CTP-643)

Attempt N fails → the connector has already recorded `scrape_run.status =
'failed'` with its last checkpoint → the queue releases the row with
`attempts + 1` → the retake resumes the **same** `scrapeRunId`: `store.start`
reopens the failed row (`running`, failure columns cleared, `fence_token + 1`,
checkpoint kept, `gestart` moved to this attempt so `abandonStaleRuns` does not
immediately re-fail it) and the connector refetches only from that checkpoint.
A page-2 failure therefore costs one page, not a crawl. At `maxAttempts` the
row closes (`completed = true`, `last_failure` kept): the bron is free for the
scheduler's next due evaluation, and the closed row is never re-run
automatically. A `succeeded` run is never reopened.

## The restart matrix

| Event | What happens |
|---|---|
| Kill before the domain commit | The claim lease expires (`acquired_at` older than `lockExpiration`, 2 min default). A successor claims the same job; the pipeline resumes the same `scrape_run` under a new fence. |
| Kill after the commit, before the queue ack | The replayed take finds `scrape_run.status = 'succeeded'` and returns immediately — the ack lands with no second mutation. |
| Connector failure recorded as `failed` | The failing take spends one attempt. The retake's `store.start(resume)` reopens the failed row under a new fence and resumes from its checkpoint, so only the failed page is refetched and exactly one domain result lands. A `running` row that `abandonStaleRuns` flipped to `failed` is reopened the same way. |
| Database outage during claim | The claim loop logs a warning and keeps polling; a `take` never settles as a failure, so no job is stranded or dead-lettered by a transient outage. A shutdown interrupt is the one cause the loop does not swallow — it ends the take so the worker can stop. |
| Lease expiry / fencing | `acquired_by` is a per-worker UUID refreshed by a background fiber; a claim older than `lockExpiration` is reclaimable. Domain-side, the successor's `store.start` bumps `fence_token`, so the stale worker can never commit again. |
| Exhausted attempts | The attempt that reaches `DURABLE_JOB_MAX_ATTEMPTS` (5) closes the row: `completed = true` with `last_failure` kept. It is an inspectable dead letter, never silently dropped, and because it is closed `durable_job_open_bron_uidx` lets the scheduler offer a fresh job for the bron. |

State is inspectable from SQL:

```sql
SELECT id, completed, attempts, last_failure, acquired_by, acquired_at
FROM curated.durable_job
WHERE queue_name = 'bron-ingest'
ORDER BY sequence;
```

Dead letters are the closed rows that still carry a failure:

```sql
SELECT id, attempts, last_failure, updated_at
FROM curated.durable_job
WHERE queue_name = 'bron-ingest'
  AND completed
  AND last_failure IS NOT NULL
ORDER BY sequence;
```

## Backup/restore interplay (CTP-632)

Open `curated.durable_job` rows are plain table data: a `pg_dump` restore
carries them — including `attempts` and `last_failure` — into the target, so
an unfinished job at backup time comes back claimable, not lost. The
post-restore retake goes through the normal resume path: `store.start`
reopens the restored `failed` `scrape_run` under a bumped `fence_token` and
the connector refetches only from its persisted checkpoint.

`tools/backfill/restore-drill.ts` exercises exactly this end to end on
disposable databases: backup taken with a failed run and an open job,
commits between backup and loss are gone from the restore (the receipt lists
them as lost writes), and the retaken job completes the same `scrape_run`
with no duplicate `aanvraag` or `source_record` rows. See
[postgres-restore-v1.md](postgres-restore-v1.md#ingest-chain-restore-drill-ctp-632)
for how to run it and what its receipt records.

## Cutover, rollback, single executor

`POLLER_DURABLE_BRONNEN` is a comma-separated slug list; unset or empty means
everything runs inline — the synchronous path is untouched. Unknown slugs fail
closed at startup. If the flag names a durable bron but
`curated.durable_job` does not exist, the worker refuses to start with an
explicit message rather than silently falling back: dispatch must not run on
a table that was never provisioned.

When the flag is removed (rollback), the consumer still starts whenever the
table exists, so jobs queued before the rollback drain instead of stranding.
New dispatch simply goes inline again. During cutover there is at most one
active executor per bron: the open-bron index admits one open job per bron,
and the scrape-run fence plus the per-bron advisory lock inside
`PostgresRunStore.start` reject any second executor that somehow did run.

## Enrichment queue (CTP-626)

The same `curated.durable_job` table carries a second queue,
`aanvraag-enrichment`, used by the `enrich-incomplete` task when
`ENRICHMENT_DURABLE=1` is set (or the payload passes `durable: true`) and
`dryRun` is false. A dry run never touches the queue.

- Job element: `{ aanvraagId, expectedUpdatedAt }`, where `expectedUpdatedAt`
  is `aanvraag.updated_at` with its full microsecond precision (UTC text) as
  read when the candidate was selected — a millisecond `Date` cannot tell two
  writes inside one millisecond apart. Job id is
  `${aanvraagId}:${expectedUpdatedAt}`, so the same candidate state re-offered
  is a no-op and a newer row state is a new job. The element has no `bronId`,
  so the bron-ingest open-job index does not apply.
- Apply: `PostgresEnrichmentStore.applyEnrichmentAtomically` re-reads the row
  `FOR UPDATE`, compares `updated_at` with the token and re-plans the patch
  against the current facts. Outcomes: `applied` (proposals, curated patch and
  one `aanvraag.enriched` outbox event in a single transaction), `stale` (the
  row changed since selection: a user edit, a curation write, or an earlier
  attempt that committed before its ack) and `nothing_to_fill` (a manual
  `CLEARED` or a value filled meanwhile). `stale` and `nothing_to_fill` write
  nothing and are successful job completions.
- Drain: the task offers one job per candidate and then drains up to
  `batchSize` jobs (`ENRICHMENT_JOB_MAX_ATTEMPTS = 3`), stopping when the
  queue has nothing claimable. Jobs left by a run that died mid-way are
  drained by the next flagged run.
- Rollback: unset `ENRICHMENT_DURABLE`; the inline path resumes and queued
  rows wait until a flagged run drains them. The Trigger.dev schedule for
  `enrich-incomplete` remains the owner of when a run happens until T6.

## Release gate

`apps/worker`, `packages/db/src/schema` and `packages/db/src/migrations` are
blocked release paths, and migration number `0029` is a shared root-owned
resource — serialize it through the root lane if a parallel branch also needs
a migration. This change does **not** autodeploy: the `Deploy production`
gate stays red until an operator runs the migration and ships the worker per
`docs/runbooks/hetzner-deploy.md`. Rollout order:

1. Apply `0029_durable_job_queue.sql` through the operator migration lane.
2. Deploy the worker with `POLLER_DURABLE_BRONNEN` unset — the consumer is
   inert, everything stays inline.
3. Set `POLLER_DURABLE_BRONNEN=striive` to move Striive dispatch onto the
   durable queue. Rollback is removing the flag; queued jobs still drain.
