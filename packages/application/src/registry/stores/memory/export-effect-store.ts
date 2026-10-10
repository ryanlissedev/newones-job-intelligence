import type {
  ExportEffectKey,
  ExportEffectRecord,
  ExportEffectStore,
  ExportExternalIdSource,
  FinalizeConfirmedExportResult,
} from "../types";
import { MemoryExportAttemptStore } from "./export-attempt-store";
import type { MemoryExternalIdCrosswalkStore } from "./external-crosswalk-store";
import { MemoryExternalReceiptStore } from "./external-receipt-store";

const effectKey = (input: ExportEffectKey): string =>
  JSON.stringify([
    input.scopeId,
    input.target,
    input.canonicalVacancyId,
    input.actionType,
  ]);

const requireExternalId = (externalId: string): string => {
  const value = externalId.trim();
  if (!value) {
    throw new Error("Export effect external ID must not be empty");
  }
  return value;
};

const requireResponseHash = (responseHash: string): string => {
  if (!responseHash.trim()) {
    throw new Error("Export effect response hash must not be empty");
  }
  return responseHash;
};

export class MemoryExportEffectStore implements ExportEffectStore {
  private readonly attempts: MemoryExportAttemptStore;
  private readonly crosswalks: MemoryExternalIdCrosswalkStore;
  private readonly effects = new Map<string, ExportEffectRecord>();
  private readonly finalizationTails = new Map<string, Promise<unknown>>();
  private readonly receipts: MemoryExternalReceiptStore;

  constructor(
    crosswalks: MemoryExternalIdCrosswalkStore,
    attempts: MemoryExportAttemptStore,
    receipts: MemoryExternalReceiptStore
  ) {
    this.crosswalks = crosswalks;
    this.attempts = attempts;
    this.receipts = receipts;
  }

  reserve(key: ExportEffectKey): Promise<{
    readonly acquired: boolean;
    readonly effect: ExportEffectRecord;
  }> {
    const storageKey = effectKey(key);
    const existing = this.effects.get(storageKey);
    if (existing) {
      return Promise.resolve({ acquired: false, effect: { ...existing } });
    }

    const now = new Date();
    const effect: ExportEffectRecord = {
      ...key,
      createdAt: now,
      externalId: null,
      externalIdSource: null,
      status: "reserved",
      updatedAt: now,
    };
    this.effects.set(storageKey, effect);
    return Promise.resolve({ acquired: true, effect: { ...effect } });
  }

  recordExternalId(
    input: ExportEffectKey & {
      readonly externalId: string;
      readonly source: ExportExternalIdSource;
    }
  ): Promise<ExportEffectRecord> {
    const storageKey = effectKey(input);
    const existing = this.effects.get(storageKey);
    if (!existing) {
      return Promise.reject(new Error("Export effect reservation not found"));
    }

    const externalId = requireExternalId(input.externalId);
    if (existing.externalId && existing.externalId !== externalId) {
      return Promise.reject(
        new Error("Export effect already has a different external ID")
      );
    }
    if (!input.source) {
      return Promise.reject(
        new Error("Export effect external ID source missing")
      );
    }

    const updated: ExportEffectRecord = {
      ...existing,
      externalId,
      externalIdSource: existing.externalIdSource ?? input.source,
      status:
        existing.status === "confirmed" ? "confirmed" : "external_id_acquired",
      updatedAt: new Date(),
    };
    this.effects.set(storageKey, updated);
    return Promise.resolve({ ...updated });
  }

  async finalizeConfirmed(
    input: ExportEffectKey & {
      readonly approvalId: string;
      readonly externalId: string;
      readonly idempotencyKey: string;
      readonly responseHash: string;
      readonly snapshotId: string;
    }
  ): Promise<FinalizeConfirmedExportResult> {
    const storageKey = effectKey(input);
    const previous =
      this.finalizationTails.get(storageKey) ?? Promise.resolve();
    const { promise: current, resolve: release } =
      Promise.withResolvers<boolean>();
    this.finalizationTails.set(storageKey, current);
    await previous;
    try {
      return this.finalizeUnlocked(input);
    } finally {
      release(true);
      if (this.finalizationTails.get(storageKey) === current) {
        this.finalizationTails.delete(storageKey);
      }
    }
  }

  private finalizeUnlocked(
    input: ExportEffectKey & {
      readonly approvalId: string;
      readonly externalId: string;
      readonly idempotencyKey: string;
      readonly responseHash: string;
      readonly snapshotId: string;
    }
  ): FinalizeConfirmedExportResult {
    const storageKey = effectKey(input);
    const existing = this.effects.get(storageKey);
    const externalId = requireExternalId(input.externalId);
    const responseHash = requireResponseHash(input.responseHash);
    if (!existing?.externalId) {
      throw new Error("Export effect has no durable external ID");
    }
    if (existing.externalId !== externalId) {
      throw new Error("Export effect external ID does not match confirmation");
    }
    if (existing.status === "confirmed") {
      return { created: false, externalId };
    }

    const crosswalk = this.crosswalks.prepare({
      actionType: input.actionType,
      canonicalVacancyId: input.canonicalVacancyId,
      externalId,
      scopeId: input.scopeId,
      target: input.target,
    });
    const attempt = MemoryExportAttemptStore.prepare({
      actionType: input.actionType,
      approvalId: input.approvalId,
      canonicalVacancyId: input.canonicalVacancyId,
      errorMessage: null,
      externalId,
      idempotencyKey: input.idempotencyKey,
      scopeId: input.scopeId,
      snapshotId: input.snapshotId,
      status: "created",
      target: input.target,
    });
    const receipt = MemoryExternalReceiptStore.prepare({
      canonicalVacancyId: input.canonicalVacancyId,
      confirmedEffect: true,
      exportAttemptId: attempt.id,
      responseHash,
      scopeId: input.scopeId,
      spottVacancyId: externalId,
    });

    // All validation and record construction happens above. These commits are
    // synchronous, so no other memory operation can observe a partial set.
    this.crosswalks.commitPrepared(crosswalk);
    this.attempts.commitPrepared(attempt);
    this.receipts.commitPrepared(receipt);
    this.effects.set(storageKey, {
      ...existing,
      status: "confirmed",
      updatedAt: new Date(),
    });
    return { attempt, created: true, externalId, receipt };
  }
}
