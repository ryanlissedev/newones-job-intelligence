# Enrichment schedule (`schedule-enrich-incomplete`)

CTP-487 — continuous deterministic enrichment loop via Trigger.dev.

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
