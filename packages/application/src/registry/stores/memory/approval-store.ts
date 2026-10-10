import type {
  ApprovalRecord,
  ApprovalStore,
  ApprovalWriteResult,
  AuditActorType,
  AuditEventRecord,
  AuditStore,
} from "../types";
import { randomId } from "./random-id";

export class MemoryApprovalStore implements ApprovalStore {
  private readonly audit: AuditStore;
  private readonly auditBySnapshotId = new Map<string, AuditEventRecord>();
  private readonly bySnapshotId = new Map<string, ApprovalRecord>();

  constructor(audit: AuditStore) {
    this.audit = audit;
  }

  async createWithAudit(
    record: Omit<ApprovalRecord, "createdAt" | "id">,
    actorType: AuditActorType
  ): Promise<ApprovalWriteResult> {
    const existing = this.bySnapshotId.get(record.snapshotId);
    if (existing) {
      const existingAudit = this.auditBySnapshotId.get(record.snapshotId);
      const exactRetry =
        existing.actorId === record.actorId &&
        existing.expiresAt.getTime() === record.expiresAt.getTime() &&
        existing.motivatie === record.motivatie &&
        existing.scopeId === record.scopeId &&
        existing.resultIds.length === record.resultIds.length &&
        existing.resultIds.every((id, index) => id === record.resultIds[index]);
      if (
        !exactRetry ||
        !existingAudit ||
        existingAudit.actorType !== actorType ||
        existingAudit.auditClass !== "effect"
      ) {
        return { ok: false, reason: "snapshot_already_approved" };
      }
      return {
        approval: structuredClone(existing),
        auditEvent: structuredClone(existingAudit),
        created: false,
        ok: true,
      };
    }

    const approval: ApprovalRecord = {
      ...record,
      createdAt: new Date(),
      id: randomId(),
      resultIds: Object.freeze([...record.resultIds]),
    };
    this.bySnapshotId.set(approval.snapshotId, approval);
    try {
      const auditEvent = await this.audit.append({
        action: "approve_snapshot",
        actorId: record.actorId,
        actorType,
        auditClass: "effect",
        entityId: approval.id,
        entityType: "approval_record",
        metadata: {
          expiresAt: approval.expiresAt.toISOString(),
          motivatie: approval.motivatie,
          snapshotId: approval.snapshotId,
        },
        scopeId: record.scopeId,
      });
      this.auditBySnapshotId.set(approval.snapshotId, auditEvent);
      return {
        approval: structuredClone(approval),
        auditEvent: structuredClone(auditEvent),
        created: true,
        ok: true,
      };
    } catch (error) {
      this.bySnapshotId.delete(approval.snapshotId);
      throw error;
    }
  }

  getBySnapshotId(
    snapshotId: string,
    scopeId: string
  ): Promise<ApprovalRecord | null> {
    const record = this.bySnapshotId.get(snapshotId);
    if (!record || record.scopeId !== scopeId) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...record,
      resultIds: Object.freeze([...record.resultIds]),
    });
  }
}
