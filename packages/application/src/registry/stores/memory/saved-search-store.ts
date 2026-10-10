import type {
  AuditActorType,
  AuditStore,
  SavedSearchRecord,
  SavedSearchStore,
} from "../types";
import { MutationKeyQueue } from "./mutation-queue";
import { randomId } from "./random-id";

type SavedSearchPatch = Pick<
  SavedSearchRecord,
  "filters" | "naam" | "parserVersion" | "queryText" | "schemaVersion"
>;

const isOwnedActive = (
  record: SavedSearchRecord | undefined,
  userId: string,
  scopeId: string
): record is SavedSearchRecord =>
  record?.userId === userId &&
  record.scopeId === scopeId &&
  record.deletedAt === null;

export class MemorySavedSearchStore implements SavedSearchStore {
  private readonly audit: AuditStore;
  private readonly records = new Map<string, SavedSearchRecord>();
  /** Last successfully audited state; rollback target for failures. */
  private readonly committed = new Map<string, SavedSearchRecord>();
  private readonly queue = new MutationKeyQueue();

  constructor(audit: AuditStore) {
    this.audit = audit;
  }

  createWithAudit(
    record: Omit<SavedSearchRecord, "createdAt" | "id" | "updatedAt">,
    actorType: AuditActorType
  ) {
    const now = new Date();
    const savedSearch: SavedSearchRecord = {
      ...record,
      createdAt: now,
      id: randomId(),
      updatedAt: now,
    };
    const key = savedSearch.id;
    return this.queue.run(key, async () => {
      this.records.set(key, savedSearch);
      try {
        const auditEvent = await this.audit.append({
          action: "create_saved_search",
          actorId: record.userId,
          actorType,
          auditClass: "effect",
          entityId: savedSearch.id,
          entityType: "saved_search",
          metadata: {
            deleted: false,
            naam: savedSearch.naam,
            queryText: savedSearch.queryText,
          },
          scopeId: record.scopeId,
        });
        this.committed.set(key, structuredClone(savedSearch));
        return { auditEvent, savedSearch: structuredClone(savedSearch) };
      } catch (error) {
        this.rollback(key);
        throw error;
      }
    });
  }

  getById(id: string, userId: string, scopeId: string) {
    const record = this.records.get(id);
    return Promise.resolve(
      record?.userId === userId &&
        record.scopeId === scopeId &&
        record.deletedAt === null
        ? structuredClone(record)
        : null
    );
  }

  list(userId: string, scopeId: string) {
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (record) =>
            record.userId === userId &&
            record.scopeId === scopeId &&
            record.deletedAt === null
        )
        .map((record) => structuredClone(record))
    );
  }

  removeWithAudit(
    id: string,
    userId: string,
    scopeId: string,
    actorType: AuditActorType
  ) {
    return this.queue.run(id, () =>
      this.removeWithAuditExclusive(id, userId, scopeId, actorType)
    );
  }

  private async removeWithAuditExclusive(
    id: string,
    userId: string,
    scopeId: string,
    actorType: AuditActorType
  ) {
    const previous = this.records.get(id) ?? this.committed.get(id);
    if (!isOwnedActive(previous, userId, scopeId)) {
      return null;
    }
    const now = new Date();
    const removed: SavedSearchRecord = {
      ...previous,
      deletedAt: now,
      updatedAt: now,
    };
    this.records.set(id, removed);
    try {
      const auditEvent = await this.audit.append({
        action: "remove_saved_search",
        actorId: userId,
        actorType,
        auditClass: "effect",
        entityId: id,
        entityType: "saved_search",
        metadata: {
          deleted: true,
          naam: removed.naam,
          queryText: removed.queryText,
        },
        scopeId,
      });
      this.committed.set(id, structuredClone(removed));
      return { auditEvent, savedSearch: structuredClone(removed) };
    } catch (error) {
      this.rollback(id);
      throw error;
    }
  }

  updateWithAudit(
    id: string,
    userId: string,
    scopeId: string,
    patch: SavedSearchPatch,
    actorType: AuditActorType
  ) {
    return this.queue.run(id, () =>
      this.updateWithAuditExclusive(id, userId, scopeId, patch, actorType)
    );
  }

  private async updateWithAuditExclusive(
    id: string,
    userId: string,
    scopeId: string,
    patch: SavedSearchPatch,
    actorType: AuditActorType
  ) {
    const previous = this.records.get(id) ?? this.committed.get(id);
    if (!isOwnedActive(previous, userId, scopeId)) {
      return null;
    }
    const updated: SavedSearchRecord = {
      ...previous,
      ...patch,
      updatedAt: new Date(),
    };
    this.records.set(id, updated);
    try {
      const auditEvent = await this.audit.append({
        action: "update_saved_search",
        actorId: userId,
        actorType,
        auditClass: "effect",
        entityId: id,
        entityType: "saved_search",
        metadata: {
          deleted: false,
          naam: updated.naam,
          queryText: updated.queryText,
        },
        scopeId,
      });
      this.committed.set(id, structuredClone(updated));
      return { auditEvent, savedSearch: structuredClone(updated) };
    } catch (error) {
      this.rollback(id);
      throw error;
    }
  }

  private rollback(key: string): void {
    const baseline = this.committed.get(key);
    if (baseline) {
      this.records.set(key, structuredClone(baseline));
    } else {
      this.records.delete(key);
    }
  }
}
