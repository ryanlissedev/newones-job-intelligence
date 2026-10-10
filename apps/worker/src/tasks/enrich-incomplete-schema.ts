import { z } from "zod";

export const enrichIncompletePayload = z.object({
  /** When true, skip live extraction and only apply stored high-confidence proposals. */
  applyStoredProposals: z.boolean().optional(),
  batchSize: z.number().int().positive().max(500).optional(),
  dryRun: z.boolean().optional(),
  /** CTP-626: route candidates through the durable `aanvraag-enrichment` queue. Falls back to `ENRICHMENT_DURABLE=1`. */
  durable: z.boolean().optional(),
  enableLlmResidual: z.boolean().optional(),
});

export type EnrichIncompletePayload = z.infer<typeof enrichIncompletePayload>;

export const enrichIncompleteDefaults = {
  applyStoredProposals: false,
  batchSize: 25,
  dryRun: true,
  enableLlmResidual: false,
} as const;
