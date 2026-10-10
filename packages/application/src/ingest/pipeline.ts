import type { ObjectStore } from "@ji/connectors";
import type { BronId } from "@ji/domain";

import { processObservation } from "../identity";
import type { CurateStore } from "../identity/curate";
import type { SupportedBronSlug } from "../sources";

/** Minimal observation shape for draining recorded connector runs into curate. */
export interface RecordedObservation {
  contentHash: string;
  observedAt: string;
  rawPayloadRef: string;
  scrapeRunId: string;
}

export interface ProcessRecordedObservationsInput {
  bronId: BronId;
  bronSlug: SupportedBronSlug;
  curateStore: CurateStore;
  objectStore: ObjectStore;
  observationRecorder: { observations: readonly RecordedObservation[] };
}

/**
 * Drains recorded connector observations through the curate path.
 * Extracted from ingest/read-path.spec.ts for native + Effect dual-path (CTP-468).
 */
export const processRecordedObservations = async (
  input: ProcessRecordedObservationsInput
): Promise<void> => {
  /* oxlint-disable no-await-in-loop -- curate pipeline must stay deterministic */
  for (const observation of input.observationRecorder.observations) {
    const stored = await input.objectStore.get(observation.rawPayloadRef);
    if (!stored) {
      continue;
    }
    await processObservation(input.curateStore, {
      body: stored.body,
      bronId: input.bronId,
      bronSlug: input.bronSlug,
      contentHash: observation.contentHash,
      observedAt: new Date(observation.observedAt),
      rawPayloadRef: observation.rawPayloadRef,
      scrapeRunId: observation.scrapeRunId,
    });
  }
  /* oxlint-enable no-await-in-loop */
};
