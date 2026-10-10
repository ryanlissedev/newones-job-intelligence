import { buildExportIdempotencyKey } from "../../../export/idempotency";
import type {
  ExternalIdCrosswalkRecord,
  ExternalIdCrosswalkStore,
} from "../types";

interface PreparedExternalIdCrosswalk {
  readonly key: string;
  readonly record: ExternalIdCrosswalkRecord;
}

type CrosswalkIdentity = Pick<
  ExternalIdCrosswalkRecord,
  "actionType" | "canonicalVacancyId" | "scopeId" | "target"
>;

const keyFor = (identity: CrosswalkIdentity): string =>
  JSON.stringify([
    identity.scopeId,
    buildExportIdempotencyKey(
      identity.target,
      identity.canonicalVacancyId,
      identity.actionType
    ),
  ]);

export class MemoryExternalIdCrosswalkStore implements ExternalIdCrosswalkStore {
  private readonly byKey = new Map<string, ExternalIdCrosswalkRecord>();

  get(input: CrosswalkIdentity): Promise<ExternalIdCrosswalkRecord | null> {
    const record = this.byKey.get(keyFor(input));
    return Promise.resolve(record ? { ...record } : null);
  }

  create(
    record: Omit<ExternalIdCrosswalkRecord, "createdAt">
  ): Promise<ExternalIdCrosswalkRecord> {
    const prepared = this.prepare(record);
    this.commitPrepared(prepared);
    return Promise.resolve({ ...prepared.record });
  }

  prepare(
    record: Omit<ExternalIdCrosswalkRecord, "createdAt">
  ): PreparedExternalIdCrosswalk {
    const key = keyFor(record);
    const existing = this.byKey.get(key);
    if (existing && existing.externalId !== record.externalId) {
      throw new Error("External ID crosswalk already has a different ID");
    }
    const stored: ExternalIdCrosswalkRecord = {
      ...record,
      createdAt: new Date(),
    };
    return { key, record: existing ?? stored };
  }

  commitPrepared(prepared: PreparedExternalIdCrosswalk): void {
    this.byKey.set(prepared.key, prepared.record);
  }
}
