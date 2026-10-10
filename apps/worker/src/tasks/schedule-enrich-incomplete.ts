import { schedules } from "@trigger.dev/sdk";

import { enrichIncompleteTask } from "./enrich-incomplete";
import { enrichIncompleteDefaults } from "./enrich-incomplete-schema";
import type { EnrichIncompletePayload } from "./enrich-incomplete-schema";

/**
 * Safe scheduled payload for continuous enrichment (CTP-487).
 *
 * Ops flip for live writes (NOT done in this slice — document only):
 * 1. Capture dryRun evidence from Trigger runs (processed/proposals/skipped).
 * 2. CoS/Ryan clears a live batch.
 * 3. Change `dryRun` below to `false` (keep `enableLlmResidual: false`) and
 *    redeploy the worker — or trigger `enrich-incomplete` once manually with
 *    `{ dryRun: false, enableLlmResidual: false, batchSize: 25 }`.
 * Never flip LLM residual without a paid-spend decision.
 */
export const scheduleEnrichIncompletePayload = {
  batchSize: enrichIncompleteDefaults.batchSize,
  dryRun: enrichIncompleteDefaults.dryRun,
  enableLlmResidual: enrichIncompleteDefaults.enableLlmResidual,
} as const satisfies EnrichIncompletePayload;

// Hourly at :05 Europe/Amsterdam — staggered from schedule-slice-a-polls (every 15m).
export const scheduleEnrichIncompleteTask = schedules.task({
  cron: {
    pattern: "5 * * * *",
    timezone: "Europe/Amsterdam",
  },
  id: "schedule-enrich-incomplete",
  run: async () => {
    const payload: EnrichIncompletePayload = {
      ...scheduleEnrichIncompletePayload,
    };
    const handle = await enrichIncompleteTask.trigger(payload, {
      concurrencyKey: "enrich-incomplete",
    });
    return {
      batchSize: payload.batchSize,
      dryRun: payload.dryRun,
      enableLlmResidual: payload.enableLlmResidual,
      runId: handle.id,
      triggered: true,
    };
  },
});
