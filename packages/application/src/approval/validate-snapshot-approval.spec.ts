import { describe, expect, it } from "bun:test";

import type {
  ApprovalRecord,
  QuerySnapshotRecord,
} from "../registry/stores/types";
import { validateSnapshotApproval } from "./validate-snapshot-approval";

const scopeId = "catapulze-test";

const snapshot = (
  overrides: Partial<QuerySnapshotRecord> = {}
): QuerySnapshotRecord => ({
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  filters: {},
  id: "00000000-0000-4000-8000-000000000001",
  indexVersion: 1,
  parserVersion: "1",
  queryText: "Azure",
  resultIds: ["hit-1", "hit-2"],
  savedSearchId: null,
  schemaVersion: "slice-a-v1",
  scope: "active",
  scopeId,
  searchVersion: { appliedSequence: 1n, generation: 1 },
  userId: "recruiter-1",
  ...overrides,
});

const approval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  actorId: "approver-1",
  createdAt: new Date("2026-08-30T10:05:00.000Z"),
  expiresAt: new Date("2026-08-31T10:05:00.000Z"),
  id: "00000000-0000-4000-8000-000000000099",
  motivatie: "Kwaliteit gecontroleerd",
  resultIds: ["hit-1", "hit-2"],
  scopeId,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  ...overrides,
});

describe("validateSnapshotApproval", () => {
  it("accepts a matching unexpired approval for the snapshot", () => {
    const record = snapshot();
    const result = validateSnapshotApproval({
      approval: approval(),
      now: new Date("2026-08-30T12:00:00.000Z"),
      scopeId,
      snapshot: record,
      snapshotId: record.id,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when the snapshot is missing", () => {
    const result = validateSnapshotApproval({
      approval: approval(),
      scopeId,
      snapshot: null,
      snapshotId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects expired approvals", () => {
    const record = snapshot();
    const result = validateSnapshotApproval({
      approval: approval({
        expiresAt: new Date("2026-08-30T11:00:00.000Z"),
      }),
      now: new Date("2026-08-30T12:00:00.000Z"),
      scopeId,
      snapshot: record,
      snapshotId: record.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APPROVAL_EXPIRED");
    }
  });

  it("rejects when result ids differ from the bound snapshot", () => {
    const record = snapshot({ resultIds: ["hit-1", "hit-3"] });
    const result = validateSnapshotApproval({
      approval: approval(),
      scopeId,
      snapshot: record,
      snapshotId: record.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APPROVAL_MISMATCH");
    }
  });

  it("rejects when validating against a different snapshot id", () => {
    const record = snapshot({
      id: "00000000-0000-4000-8000-000000000002",
      resultIds: ["hit-1", "hit-2"],
    });
    const result = validateSnapshotApproval({
      approval: approval(),
      scopeId,
      snapshot: record,
      snapshotId: record.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APPROVAL_MISMATCH");
    }
  });

  it("fails closed when an approval belongs to another deployment scope", () => {
    const record = snapshot();
    const result = validateSnapshotApproval({
      approval: approval({ scopeId: "other-scope" }),
      scopeId,
      snapshot: record,
      snapshotId: record.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
