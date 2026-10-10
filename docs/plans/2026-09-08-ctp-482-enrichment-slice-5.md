# CTP-482 / CTP-487 Slice 5 — Trigger schedule for enrich-incomplete

Date: 2026-09-08  
Linear: [CTP-487](https://linear.app/rcjt-studio/issue/CTP-487/enrichment-slice-5-trigger-schedule-for-enrich-incomplete) (child of CTP-482)  
Base: `aa9b4da6` (#217)

## Landed

- Trigger `schedules.task` `schedule-enrich-incomplete` mirroring `schedule-slice-a-polls`
- Cron `5 * * * *` Europe/Amsterdam (hourly at :05, staggered from Slice A polls)
- Payload defaults: `dryRun: true`, `enableLlmResidual: false`, `batchSize: 25`
- Triggers existing `enrich-incomplete` with `concurrencyKey: "enrich-incomplete"` (task queue already `concurrencyLimit: 1`)
- Motian untouched; `/bronnen/overview` unshadow not in this slice

## Ops flip (document only — do not live-flip in this PR)

Keep the schedule on `dryRun: true` until CoS/Ryan clears a live batch:

1. After deploy, capture Trigger run evidence: processed / proposals / skipped / curatedPersisted (=0 while dry).
2. Optionally one-shot manual trigger:  
   `enrich-incomplete` with `{ "dryRun": true, "enableLlmResidual": false, "batchSize": 25 }`.
3. When cleared for live writes, either:
   - change `scheduleEnrichIncompletePayload.dryRun` to `false` and redeploy the worker, **or**
   - manually trigger once with `{ "dryRun": false, "enableLlmResidual": false, "batchSize": 25 }`.
4. Never set `enableLlmResidual: true` without an explicit paid-spend decision.

See also `docs/runbooks/enrichment-schedule.md`.

## Verify

```bash
bun test apps/worker/src/tasks/schedule-enrich-incomplete.spec.ts \
  apps/worker/src/tasks/enrich-incomplete.spec.ts \
  apps/worker/src/effect/effect.spec.ts
bun run gate
```
