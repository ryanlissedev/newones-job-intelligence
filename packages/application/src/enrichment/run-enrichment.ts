import { extractDeterministicEnrichment } from "./deterministic";
import { listMissingEnrichmentFields } from "./incomplete";
import { extractLlmResidualEnrichment } from "./llm-hook";
import { ENRICHMENT_APPLY_MIN_CONFIDENCE } from "./types";
import type {
  EnrichmentProposal,
  EnrichmentRunInput,
  EnrichmentRunResult,
} from "./types";

const meetsApplyThreshold = (proposal: EnrichmentProposal): boolean =>
  proposal.confidence >= ENRICHMENT_APPLY_MIN_CONFIDENCE;

export const runEnrichment = async (
  input: EnrichmentRunInput
): Promise<EnrichmentRunResult> => {
  const missingFields = listMissingEnrichmentFields({
    beschrijving: input.beschrijving,
    bronSpecifiek: input.bronSpecifiek,
    contracttype: input.contracttype ?? null,
    eindDatum: input.eindDatum ?? null,
    locatieTekst: input.locatieTekst ?? null,
    opdrachtgeverNaam: input.opdrachtgeverNaam ?? null,
    publicatiedatum: input.publicatiedatum ?? null,
    sluitingsdatum: input.sluitingsdatum ?? null,
    startDatum: input.startDatum ?? null,
    tariefEenheid: input.tariefEenheid ?? null,
    tariefMax: input.tariefMax ?? null,
    tariefMin: input.tariefMin ?? null,
    titleFallbackParts: input.titleFallbackParts,
    urenPerWeek: input.urenPerWeek ?? null,
    werkvorm: input.werkvorm ?? null,
  });

  if (missingFields.length === 0) {
    return { aanvraagId: input.aanvraagId, proposals: [] };
  }

  const fieldsToExtract = missingFields;

  const deterministic = extractDeterministicEnrichment({
    beschrijving: input.beschrijving,
    fields: fieldsToExtract,
    rawHtml: input.rawHtml,
    titleFallbackParts: input.titleFallbackParts,
  });

  const llm =
    input.enableLlmResidual === true
      ? await extractLlmResidualEnrichment({
          beschrijving: input.beschrijving,
          fields: fieldsToExtract,
          rawHtml: input.rawHtml,
        })
      : [];

  const byField = new Map<EnrichmentProposal["field"], EnrichmentProposal>();
  for (const proposal of [...deterministic, ...llm]) {
    if (!meetsApplyThreshold(proposal)) {
      continue;
    }
    const existing = byField.get(proposal.field);
    if (!existing || proposal.confidence > existing.confidence) {
      byField.set(proposal.field, proposal);
    }
  }

  return {
    aanvraagId: input.aanvraagId,
    proposals: [...byField.values()],
  };
};
