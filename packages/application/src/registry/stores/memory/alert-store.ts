import type { AlertRecord, AlertStore } from "../types";

export class MemoryAlertStore implements AlertStore {
  private readonly records = new Map<string, AlertRecord>();

  seed(record: AlertRecord): void {
    this.records.set(record.id, structuredClone(record));
  }

  getById(alertId: string): Promise<AlertRecord | null> {
    const record = this.records.get(alertId);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  create(
    record: Omit<AlertRecord, "ackedAt" | "ackedBy" | "createdAt" | "id"> & {
      readonly id?: string;
    }
  ): Promise<AlertRecord> {
    const created: AlertRecord = {
      ...structuredClone(record),
      ackedAt: null,
      ackedBy: null,
      createdAt: new Date(),
      id: record.id ?? crypto.randomUUID(),
    };
    this.records.set(created.id, created);
    return Promise.resolve(structuredClone(created));
  }

  findOpenByDedupeKey(dedupeKey: string): Promise<AlertRecord | null> {
    const match = [...this.records.values()].find(
      (record) => record.dedupeKey === dedupeKey && record.ackedAt === null
    );
    return Promise.resolve(match ? structuredClone(match) : null);
  }

  listOpen(): Promise<readonly AlertRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((record) => record.ackedAt === null)
        .map((record) => structuredClone(record))
    );
  }

  ack(alertId: string, actorId: string): Promise<AlertRecord | null> {
    const record = this.records.get(alertId);
    if (!record) {
      return Promise.resolve(null);
    }
    if (record.ackedAt !== null) {
      return Promise.resolve(null);
    }
    const updated: AlertRecord = {
      ...record,
      ackedAt: new Date(),
      ackedBy: actorId,
    };
    this.records.set(alertId, updated);
    return Promise.resolve(structuredClone(updated));
  }
}
