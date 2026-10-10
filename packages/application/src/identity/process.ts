import type { BronId } from "@ji/domain";
import {
  recordCriticalPathPhaseSync,
  timeCriticalPathPhase,
} from "@ji/performance";

import { validateNormalisedDraft } from "../normalise";
import { SOURCES } from "../sources";
import type { SupportedBronSlug } from "../sources";
import { curateObservation } from "./curate";
import type {
  CurateObservationInput,
  CurateObservationResult,
  CurateStore,
  ObservationProcessingStatus,
} from "./curate";

export type { SupportedBronSlug } from "../sources";

export interface ProcessObservationInput {
  body: Uint8Array;
  bronId: BronId;
  bronSlug: SupportedBronSlug;
  contentHash: string;
  observedAt: Date;
  rawPayloadRef: string;
  scrapeRunId: CurateObservationInput["scrapeRunId"];
}

export interface ProcessObservationResult extends CurateObservationResult {
  parserVersion?: string;
  validationIssues?: { field: string; message: string }[];
}

export const processObservation = async (
  store: CurateStore,
  input: ProcessObservationInput
): Promise<ProcessObservationResult> => {
  const draft = recordCriticalPathPhaseSync("ingest-normalisation", () => {
    const normalised = SOURCES[input.bronSlug].normalise(
      input.body,
      input.contentHash,
      { observedAt: input.observedAt }
    );
    const issues = validateNormalisedDraft(normalised);
    return { draft: normalised, validationIssues: issues };
  });
  if (draft.validationIssues.length > 0) {
    const status: ObservationProcessingStatus = "quarantined";
    return {
      parserVersion: draft.draft.parserVersion,
      reason: draft.validationIssues.map((issue) => issue.message).join("; "),
      status,
      validationIssues: draft.validationIssues,
    };
  }

  const result = await timeCriticalPathPhase("ingest-commit", () =>
    curateObservation(store, {
      bronId: input.bronId,
      draft: draft.draft,
      observedAt: input.observedAt,
      rawPayloadRef: input.rawPayloadRef,
      scrapeRunId: input.scrapeRunId,
    })
  );
  return {
    ...result,
    parserVersion: draft.draft.parserVersion,
  };
};
