import { schemaTask } from "@trigger.dev/sdk";

import { runEnrichIncomplete } from "../enrich-incomplete-run";
import { enrichIncompletePayload } from "./enrich-incomplete-schema";

/** Dequeues incomplete curated aanvragen and applies deterministic enrichment. */
export const enrichIncompleteTask = schemaTask({
  id: "enrich-incomplete",
  queue: {
    concurrencyLimit: 1,
  },
  retry: {
    maxAttempts: 2,
  },
  run: (payload) => runEnrichIncomplete(payload),
  schema: enrichIncompletePayload,
});

export type { EnrichIncompletePayload } from "./enrich-incomplete-schema";
export type { EnrichIncompleteResult } from "../enrich-incomplete-run";
export { runEnrichIncomplete } from "../enrich-incomplete-run";
