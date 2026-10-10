import type {
  AanvraagMarkering,
  AuditActorType,
  AuditStore,
  MarkeringStore,
} from "../types";
import { MutationKeyQueue } from "./mutation-queue";

const markeringKey = (
  aanvraagId: string,
  userId: string,
  scopeId: string
): string => `${scopeId}:${userId}:${aanvraagId}`;

type StoredMarkering = AanvraagMarkering & { readonly clearedAt: Date | null };

const publicMarkering = (record: StoredMarkering): AanvraagMarkering => {
  const { clearedAt: _clearedAt, ...markering } = record;
  return structuredClone(markering);
};

export class MemoryMarkeringStore implements MarkeringStore {
  private readonly records = new Map<string, StoredMarkering>();
  /** Last successfully audited state; rollback target for failures. */
  private readonly committed = new Map<string, StoredMarkering>();
  private readonly queue = new MutationKeyQueue();
  private readonly audit: AuditStore;

  constructor(audit: AuditStore) {
    this.audit = audit;
  }

  get(
    aanvraagId: string,
    userId: string,
    scopeId: string
  ): Promise<AanvraagMarkering | null> {
    const record = this.records.get(markeringKey(aanvraagId, userId, scopeId));
    return Promise.resolve(
      record && record.clearedAt === null ? publicMarkering(record) : null
    );
  }

  setWithAudit(
    markering: Omit<AanvraagMarkering, "createdAt" | "revision" | "updatedAt">,
    actorType: AuditActorType
  ): Promise<{
    readonly auditEvent: Awaited<ReturnType<AuditStore["append"]>>;
    readonly markering: AanvraagMarkering;
  }> {
    const key = markeringKey(
      markering.aanvraagId,
      markering.userId,
      markering.scopeId
    );
    return this.queue.run(key, () =>
      this.setWithAuditExclusive(key, markering, actorType)
    );
  }

  private async setWithAuditExclusive(
    key: string,
    markering: Omit<AanvraagMarkering, "createdAt" | "revision" | "updatedAt">,
    actorType: AuditActorType
  ): Promise<{
    readonly auditEvent: Awaited<ReturnType<AuditStore["append"]>>;
    readonly markering: AanvraagMarkering;
  }> {
    const baseline = this.committed.get(key);
    const previous = this.records.get(key);
    const now = Date.now();
    const updatedAt = new Date(
      Math.max(now, (previous?.updatedAt.getTime() ?? now - 1) + 1)
    );
    const saved: StoredMarkering = {
      ...markering,
      clearedAt: null,
      createdAt: previous?.createdAt ?? baseline?.createdAt ?? updatedAt,
      revision: (previous?.revision ?? baseline?.revision ?? 0) + 1,
      updatedAt,
    };
    this.records.set(key, saved);

    try {
      const auditEvent = await this.audit.append({
        action: "markeer_aanvraag",
        actorId: markering.userId,
        actorType,
        auditClass: "effect",
        entityId: markering.aanvraagId,
        entityType: "aanvraag",
        metadata: {
          reden: markering.reden,
          status: markering.status,
        },
        scopeId: markering.scopeId,
      });
      this.committed.set(key, structuredClone(saved));
      return {
        auditEvent,
        markering: publicMarkering(saved),
      };
    } catch (error) {
      this.rollback(key);
      throw error;
    }
  }

  clearWithAudit(
    aanvraagId: string,
    userId: string,
    scopeId: string,
    actorType: AuditActorType
  ) {
    const key = markeringKey(aanvraagId, userId, scopeId);
    return this.queue.run(key, () =>
      this.clearWithAuditExclusive(key, aanvraagId, userId, scopeId, actorType)
    );
  }

  private async clearWithAuditExclusive(
    key: string,
    aanvraagId: string,
    userId: string,
    scopeId: string,
    actorType: AuditActorType
  ) {
    const cleared = this.records.get(key) ?? this.committed.get(key);
    if (!cleared || cleared.clearedAt !== null) {
      return null;
    }
    this.records.set(key, { ...cleared, clearedAt: new Date() });
    try {
      const auditEvent = await this.audit.append({
        action: "clear_markering",
        actorId: userId,
        actorType,
        auditClass: "effect",
        entityId: aanvraagId,
        entityType: "aanvraag",
        metadata: {
          cleared: true,
          reden: cleared.reden,
          revision: cleared.revision,
          status: cleared.status,
        },
        scopeId,
      });
      this.committed.set(key, {
        ...cleared,
        clearedAt: this.records.get(key)?.clearedAt ?? new Date(),
      });
      return { auditEvent, cleared: publicMarkering(cleared) };
    } catch (error) {
      this.rollback(key);
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
