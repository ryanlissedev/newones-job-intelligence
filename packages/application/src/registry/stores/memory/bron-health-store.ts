import type { BronHealthRecord, BronHealthStore } from "../types";

export class MemoryBronHealthStore implements BronHealthStore {
  private readonly records = new Map<string, BronHealthRecord>();

  seed(record: BronHealthRecord): void {
    this.records.set(record.bronId, structuredClone(record));
  }

  getByBronId(bronId: string): Promise<BronHealthRecord | null> {
    return Promise.resolve(structuredClone(this.records.get(bronId) ?? null));
  }

  list(): Promise<readonly BronHealthRecord[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => structuredClone(record))
    );
  }

  upsert(record: BronHealthRecord): Promise<BronHealthRecord> {
    this.records.set(record.bronId, structuredClone(record));
    return Promise.resolve(structuredClone(record));
  }
}
