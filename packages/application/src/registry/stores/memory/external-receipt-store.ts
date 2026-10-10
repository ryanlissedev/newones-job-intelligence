import type { ExternalReceiptRecord, ExternalReceiptStore } from "../types";
import { randomId } from "./random-id";

export class MemoryExternalReceiptStore implements ExternalReceiptStore {
  private readonly records: ExternalReceiptRecord[] = [];

  create(
    record: Omit<ExternalReceiptRecord, "createdAt" | "id">
  ): Promise<ExternalReceiptRecord> {
    const stored = MemoryExternalReceiptStore.prepare(record);
    this.commitPrepared(stored);
    return Promise.resolve({ ...stored });
  }

  static prepare(
    record: Omit<ExternalReceiptRecord, "createdAt" | "id">
  ): ExternalReceiptRecord {
    if (!record.responseHash.trim()) {
      throw new Error("External receipt response hash must not be empty");
    }
    return {
      ...record,
      createdAt: new Date(),
      id: randomId(),
    };
  }

  commitPrepared(stored: ExternalReceiptRecord): void {
    this.records.push(stored);
  }

  getByExportAttemptId(
    exportAttemptId: string,
    scopeId: string
  ): Promise<ExternalReceiptRecord | null> {
    const record = this.records.find(
      (entry) =>
        entry.exportAttemptId === exportAttemptId && entry.scopeId === scopeId
    );
    return Promise.resolve(record ? { ...record } : null);
  }

  listByCanonicalVacancyId(
    canonicalVacancyId: string,
    scopeId: string
  ): Promise<readonly ExternalReceiptRecord[]> {
    return Promise.resolve(
      this.records
        .filter(
          (entry) =>
            entry.canonicalVacancyId === canonicalVacancyId &&
            entry.scopeId === scopeId
        )
        .map((entry) => ({ ...entry }))
    );
  }

  list(): readonly ExternalReceiptRecord[] {
    return [...this.records];
  }
}
