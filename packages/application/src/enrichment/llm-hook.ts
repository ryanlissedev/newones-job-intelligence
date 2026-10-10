import type { EnrichmentField, EnrichmentProposal } from "./types";

export interface LlmResidualInput {
  readonly beschrijving: string;
  readonly fields: readonly EnrichmentField[];
  readonly rawHtml?: string | null;
}

/** LLM residual extraction is off by default in Slice 1. */
export const extractLlmResidualEnrichment = (
  _input: LlmResidualInput
): Promise<readonly EnrichmentProposal[]> => Promise.resolve([]);
