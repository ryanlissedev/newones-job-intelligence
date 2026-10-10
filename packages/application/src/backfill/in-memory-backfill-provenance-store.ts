import type {
  BackfillProvenanceRecord,
  BackfillProvenanceStore,
  BackfillSnapshotWindow,
  BackfillTargetProvenanceRecord,
} from "./neon-v1-types";

export class InMemoryBackfillProvenanceStore implements BackfillProvenanceStore {
  private readonly byV1Id = new Map<string, BackfillProvenanceRecord>();

  async consumeReconciliationSnapshot(
    bronIds: readonly string[],
    batchSize: number,
    consume: (batch: readonly BackfillTargetProvenanceRecord[]) => Promise<void>
  ): Promise<BackfillSnapshotWindow> {
    const startedAt = new Date().toISOString();
    const requested = new Set(bronIds);
    const records = [...this.byV1Id.values()]
      .filter((record) => requested.has(record.bronId))
      .map(({ bronId, bronReferentie, contentHash, rawPayloadRef, v1Id }) => ({
        bronId,
        bronReferentie,
        contentHash,
        rawPayloadRef,
        v1Id,
      }))
      .toSorted(
        (left, right) =>
          left.v1Id.localeCompare(right.v1Id) ||
          left.bronId.localeCompare(right.bronId)
      );
    const size = Math.max(1, batchSize);
    for (let offset = 0; offset < records.length; offset += size) {
      /* oxlint-disable no-await-in-loop -- models bounded sequential snapshot batches */
      await consume(records.slice(offset, offset + size));
      /* oxlint-enable no-await-in-loop */
    }
    return { completedAt: new Date().toISOString(), startedAt };
  }

  findByAanvraagId(
    aanvraagId: string
  ): Promise<BackfillProvenanceRecord | null> {
    const record = [...this.byV1Id.values()].find(
      (candidate) => candidate.aanvraagId === aanvraagId
    );
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  findByV1Id(v1Id: string): Promise<BackfillProvenanceRecord | null> {
    const record = this.byV1Id.get(v1Id);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  /** Mirrors the Postgres adapter's one-v1-id-per-aanvraag guard so fixture
   * runs reject the same collision production rejects. */
  registerV1Id(
    record: BackfillProvenanceRecord
  ): Promise<BackfillProvenanceRecord> {
    const bound = [...this.byV1Id.values()].find(
      (candidate) =>
        candidate.aanvraagId === record.aanvraagId &&
        candidate.v1Id !== record.v1Id
    );
    if (bound) {
      return Promise.reject(
        new Error(
          `Refusing to register v1_id ${record.v1Id} on aanvraag ${record.aanvraagId}: aanvraag is already bound to v1_id ${bound.v1Id}; overwriting would break provenance`
        )
      );
    }
    const registered = structuredClone(record);
    this.byV1Id.set(record.v1Id, registered);
    return Promise.resolve(structuredClone(registered));
  }
}
