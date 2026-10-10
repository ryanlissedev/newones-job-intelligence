import type {
  AanvraagRecord,
  AanvraagStore,
  AanvraagVersieRecord,
} from "../types";

export class MemoryAanvraagStore implements AanvraagStore {
  private readonly records = new Map<string, AanvraagRecord>();

  seed(record: AanvraagRecord): void {
    this.records.set(record.id, {
      ...record,
      versies: Object.freeze(record.versies.map((versie) => ({ ...versie }))),
    });
  }

  getById(id: string): Promise<AanvraagRecord | null> {
    const record = this.records.get(id);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  getByIds(ids: readonly string[]): Promise<readonly AanvraagRecord[]> {
    const records: AanvraagRecord[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (record) {
        records.push(structuredClone(record));
      }
    }
    return Promise.resolve(records);
  }

  listVersies(aanvraagId: string): Promise<readonly AanvraagVersieRecord[]> {
    const record = this.records.get(aanvraagId);
    if (!record) {
      return Promise.resolve([]);
    }
    return Promise.resolve(structuredClone(record.versies));
  }
}
