import type { CheckpointKey } from "./checkpoint";
import type { ConnectorObservation } from "./contract";
import type {
  SourceRecordPointer,
  SourceRecordWriteResult,
} from "./object-store";
import { RunOwnershipLostError } from "./run-lifecycle";

export interface ObservationRecordInput {
  fenceToken: number;
  key: CheckpointKey;
  observation: Omit<ConnectorObservation, "sourceRecordId">;
  sourceRecord: SourceRecordPointer;
}

/** Atomically classifies a source record and appends its immutable observation. */
export interface ObservationRecorder {
  record: (input: ObservationRecordInput) => Promise<SourceRecordWriteResult>;
}

const observationReplayKey = (record: SourceRecordPointer): string =>
  `${record.scrapeRunId}\0${record.bronId}\0${record.bronReferentie}\0${record.contentHash}`;

export class InMemoryObservationRecorder implements ObservationRecorder {
  readonly observations: ConnectorObservation[] = [];
  readonly records: SourceRecordPointer[] = [];
  private readonly replayResults = new Map<string, SourceRecordWriteResult>();
  private readonly fenceTokenByRun = new Map<string, number>();

  record(input: ObservationRecordInput): Promise<SourceRecordWriteResult> {
    const runKey = `${input.key.bronId}\0${input.key.scrapeRunId}`;
    const currentFenceToken = this.fenceTokenByRun.get(runKey) ?? 0;
    if (
      !Number.isSafeInteger(input.fenceToken) ||
      input.fenceToken < 1 ||
      input.fenceToken < currentFenceToken
    ) {
      return Promise.reject(new RunOwnershipLostError());
    }
    if (
      input.key.bronId !== input.sourceRecord.bronId ||
      input.key.scrapeRunId !== input.sourceRecord.scrapeRunId ||
      input.key.bronId !== input.observation.bronId ||
      input.key.scrapeRunId !== input.observation.scrapeRunId
    ) {
      return Promise.reject(
        new Error("Observation run key does not match payload")
      );
    }
    this.fenceTokenByRun.set(runKey, input.fenceToken);
    const replayKey = observationReplayKey(input.sourceRecord);
    const replay = this.replayResults.get(replayKey);
    if (replay) {
      return Promise.resolve(structuredClone(replay));
    }

    const { sourceRecord } = input;
    const existingIndex = this.records.findIndex(
      (record) =>
        record.bronId === sourceRecord.bronId &&
        record.bronReferentie === sourceRecord.bronReferentie
    );
    const sourceRecordId = `${sourceRecord.bronId}:${sourceRecord.bronReferentie}`;
    let result: SourceRecordWriteResult;

    if (existingIndex === -1) {
      this.records.push(structuredClone(sourceRecord));
      result = { outcome: "new", sourceRecordId };
    } else if (
      this.records[existingIndex]?.contentHash === sourceRecord.contentHash
    ) {
      this.records[existingIndex] = structuredClone(sourceRecord);
      result = { outcome: "unchanged", sourceRecordId };
    } else {
      this.records[existingIndex] = structuredClone(sourceRecord);
      result = { outcome: "changed", sourceRecordId };
    }

    this.observations.push({
      ...structuredClone(input.observation),
      sourceRecordId: result.sourceRecordId,
    });
    this.replayResults.set(replayKey, structuredClone(result));
    return Promise.resolve(result);
  }
}
