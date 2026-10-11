# Enrichment schedule (`schedule-enrich-incomplete`)

CTP-487: a continuous deterministic enrichment loop.

> **2026-10-11: moving on-box.** The hourly run moves to a **Coolify Scheduled Task on the poller app**.
> It runs the same `runEnrichIncomplete` code inside the poller container, against the internal DB.
> See [On-box: Coolify Scheduled Task](#on-box-coolify-scheduled-task).
> The Trigger tasks below stay in code until the on-box run is verified; their queues are paused in the Trigger dashboard.
> See [Retiring the Trigger schedule](#retiring-the-trigger-schedule).

## Tasks

| Id | Kind | Notes |
|----|------|-------|
| `schedule-enrich-incomplete` | `schedules.task` | Cron `5 * * * *` `Europe/Amsterdam`. Triggers `enrich-incomplete`. |
| `enrich-incomplete` | `schemaTask` | Queue concurrency 1. Defaults: `dryRun: true`, `enableLlmResidual: false`, `batchSize: 25`. |

Staggered from the per-bron poll cadence (`curated.bron.interval`, today `*/15 * * * *` Europe/Amsterdam) that the on-box poller follows (`docs/runbooks/onbox-poller.md`).

## Safe defaults

The scheduled payload always starts as:

```json
{
  "dryRun": true,
  "enableLlmResidual": false,
  "batchSize": 25
}
```

Dry runs count proposals without writing curated columns or outbox events.

## Ops flip: `dryRun` → `false`

**Do not flip in code without CoS/Ryan clearance.**

1. Confirm Trigger dryRun runs look healthy (processed > 0 when incomplete rows exist; curatedPersisted stays 0).
2. Prefer a one-shot manual live trigger first:

   ```json
   {
     "dryRun": false,
     "enableLlmResidual": false,
     "batchSize": 25
   }
   ```

3. Only after a cleared live sample, change `scheduleEnrichIncompletePayload.dryRun` in
   `apps/worker/src/tasks/schedule-enrich-incomplete.ts` to `false` and redeploy `apps/worker`.
4. Leave `enableLlmResidual: false` unless there is an explicit paid LLM decision.

## Motian / overview

- Motian backfill paths are out of scope for this schedule.
- `/bronnen/overview` unshadow is a separate lane — not part of Slice 5.

## On-box: Coolify Scheduled Task

### What runs

| Piece | Path |
|---|---|
| Run body (no Trigger SDK) | `apps/worker/src/enrich-incomplete-run.ts`. The Trigger task `enrich-incomplete` calls the same `runEnrichIncomplete`. |
| Env → payload (fail closed) | `apps/worker/src/oneshot-enrich-incomplete.ts` |
| Entrypoint | `apps/worker/scripts/oneshot-enrich-incomplete.ts` (`bun run enrich:oneshot` in `apps/worker`) |
| Coolify wrapper (flock) | `apps/worker/scripts/scheduled-oneshot-enrich-incomplete.sh` |

The poller image (`apps/worker/Dockerfile.poller`) already contains the whole repo at `/app` plus `bun`. The task needs no image change; it only needs the release that contains these files.

### Coolify settings (poller application → Scheduled Tasks → Add)

| Field | Value |
|---|---|
| Name | `enrich-incomplete` |
| Command | `bash /app/apps/worker/scripts/scheduled-oneshot-enrich-incomplete.sh` |
| Frequency | `5 * * * *` (hourly at :05, the same minute as the Trigger cron; independent of the Coolify server timezone) |
| Container name | empty (single-container poller app) |
| Timeout | 900 s if the Coolify version offers the field (matches the Trigger `maxDuration`) |

**Database.** The task runs inside the poller container. It inherits the poller's `DATABASE_URL`, which points at the internal Postgres on the Coolify Docker network. No external port is involved; port 55432 stays closed. Raw bodies come from the same object store the poller writes to.

**Overlap.** `flock -n` on `/tmp/oneshot-enrich-incomplete.lock`. A tick that finds the previous run still going logs `{"status":"skipped","reason":"lock_held"}` and exits 0. This replaces the Trigger queue `concurrencyLimit: 1`. Check once that `flock` exists in the container (`command -v flock`; util-linux is part of the Debian-based `oven/bun` image).

### Payload via env (defaults = the Trigger defaults)

| Env | Default | Meaning |
|---|---|---|
| `ENRICH_DRY_RUN` | `true` | Counts proposals; writes no curated columns, proposals or outbox events. |
| `ENRICH_BATCH_SIZE` | `25` | 1..500 |
| `ENRICH_ENABLE_LLM_RESIDUAL` | `false` | Never `true` without a paid-spend decision. |
| `ENRICH_APPLY_STORED_PROPOSALS` | `false` | Only applies stored proposals. |
| `ENRICHMENT_DURABLE` | unset | `1` routes live (non-dry) runs through the durable `aanvraag-enrichment` queue. |

Booleans accept `true/false/1/0/yes/no`; an empty value counts as unset. Anything else exits 2 with `status: config_invalid` before a DB connection is opened.

**Where to set them.** Preferably inline in the scheduled-task command, so a flip is visible in the task and needs no poller redeploy. For example:
`ENRICH_DRY_RUN=false bash /app/apps/worker/scripts/scheduled-oneshot-enrich-incomplete.sh`.
Coolify application env vars also work, but they only reach the container after a redeploy or restart.

### Output and exit codes

Each run prints JSON lines with `task: "enrich-incomplete-oneshot"`:
- `starting`, with the effective payload;
- then `succeeded`, with the same result object the Trigger task returned (`processed`, `proposals`, `skipped`, `enriched`, `curatedPersisted`, `outboxEnqueued`, `durable`, `stale`, `nothingToFill`), or `failed` with the error.

| Exit | Meaning |
|---|---|
| 0 | succeeded, or skipped because the lock was held |
| 1 | the run failed |
| 2 | invalid env config |

Coolify keeps the output under Scheduled Tasks → Executions.

### Manual run (verification)

From Coolify → poller app → Terminal, or as a "run now" of the task:
`bash /app/apps/worker/scripts/scheduled-oneshot-enrich-incomplete.sh`.
With nothing set this is a dry run and writes nothing.

### Rollout (each step needs a GO)

1. Merge + deploy the poller release that contains this change. The poller loop itself is unchanged.
2. Add the Scheduled Task above **without** `ENRICH_DRY_RUN`, so it runs dry.
3. Verify at least 3 hourly executions:
   - `succeeded`, `dryRun: true`, `curatedPersisted: 0`, `outboxEnqueued: 0`;
   - `processed > 0` while incomplete rows exist;
   - no `lock_held` pile-up;
   - poller health unaffected.
4. Live flip (CoS/Ryan clearance):
   - first one manual run with `ENRICH_DRY_RUN=false`, then check the curated fields and the outbox;
   - then put `ENRICH_DRY_RUN=false` in the task command;
   - keep `ENRICH_ENABLE_LLM_RESIDUAL` off.
5. Rollback at any point: disable or delete the Scheduled Task (or set `ENRICH_DRY_RUN=true`). Nothing else depends on it.

## Retiring the Trigger schedule

Today the `enrich-incomplete` and `schedule-enrich-incomplete` queues are **paused** in the Trigger dashboard (since 2026-10-10 17:33). The Trigger prod `DATABASE_URL` pointed at the now-closed external port, so Trigger runs could not reach the DB anyway.

**Proposal: keep the queues paused until step 3 above passes. Then remove the schedule in code and deploy to Trigger.**
- `schedules.task` is declarative: the next `trigger deploy` registers whatever is in `src/tasks`.
- Pausing alone is dashboard state that a later deploy or an accidental resume can undo. It would bring back a second writer next to the on-box task; with `concurrencyLimit: 1` per platform, two platforms can run concurrently.

Follow-up PR, after verification:
1. Delete `apps/worker/src/tasks/schedule-enrich-incomplete.ts`, its export in `tasks/index.ts`, and the `effect.spec.ts` source assertion.
2. Either keep `enrich-incomplete` (schemaTask, manual trigger only) or remove it as well. Recommendation: remove it in the same PR. The on-box entrypoint covers manual runs, and a Trigger task without a working DB URL is only a trap.
3. `trigger deploy` (prod). The schedule disappears from the dashboard; check under Schedules.
4. Resume nothing. The paused queues can stay until the tasks are gone.
