import type { RawPayloadRecord, RawPayloadStore } from "../types";

export class MemoryRawPayloadStore implements RawPayloadStore {
  private readonly records = new Map<string, RawPayloadRecord>();

  seed(record: RawPayloadRecord): void {
    this.records.set(record.ref, record);
  }

  getByRef(ref: string): Promise<RawPayloadRecord | null> {
    const record = this.records.get(ref);
    return Promise.resolve(record ? structuredClone(record) : null);
  }
}
