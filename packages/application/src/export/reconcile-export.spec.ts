import { describe, expect, it } from "bun:test";

import {
  SpottExportReconciliationError,
  hashExportApprovalMotivation,
  hashOrderedExportResultIds,
  hashSpottExportReconciliationPlan,
  reconcileSpottExportInputSchema,
  requireSpottExportReconciliationPrincipal,
} from "./reconcile-export";
import type { SpottExportReconciliationPlan } from "./reconcile-export";

const input = {
  approvalId: "00000000-0000-4000-8000-000000000002",
  authorizationRef: "change:RJC-435",
  canonicalVacancyId: "00000000-0000-4000-8000-000000000001",
  evidenceRef: "provider-case:verified-id",
  externalId: "spott-vacancy-1",
  scopeId: "catapulze",
  snapshotId: "00000000-0000-4000-8000-000000000003",
};

const plan: SpottExportReconciliationPlan = {
  actionType: "create",
  actorId: "admin-1",
  actorType: "user",
  approval: {
    actorId: "approver-1",
    createdAt: "2026-09-05T10:00:00.000Z",
    expiresAt: "2026-09-06T10:00:00.000Z",
    id: input.approvalId,
    motivationHash: "a".repeat(64),
    resultCount: 1,
    resultIdsHash: "b".repeat(64),
    snapshotId: input.snapshotId,
  },
  authorizationRef: input.authorizationRef,
  canonicalVacancyId: input.canonicalVacancyId,
  effect: {
    createdAt: "2026-09-05T10:01:00.000Z",
    id: "00000000-0000-4000-8000-000000000004",
    status: "reserved",
    updatedAt: "2026-09-05T10:01:00.000Z",
  },
  evidenceRef: input.evidenceRef,
  externalId: input.externalId,
  scopeId: input.scopeId,
  snapshot: {
    createdAt: "2026-09-05T09:59:00.000Z",
    id: input.snapshotId,
    resultCount: 1,
    resultIdsHash: "b".repeat(64),
  },
  target: "spott",
};

describe("reconcileSpottExportInputSchema", () => {
  it("defaults to dry-run and normalizes bounded text", () => {
    expect(
      reconcileSpottExportInputSchema.parse({
        ...input,
        evidenceRef: ` ${input.evidenceRef} `,
      })
    ).toMatchObject({ apply: false, evidenceRef: input.evidenceRef });
  });

  it("rejects control characters and malformed plan hashes", () => {
    expect(
      reconcileSpottExportInputSchema.safeParse({
        ...input,
        evidenceRef: "provider-case\nsecret",
      }).success
    ).toBe(false);
    expect(
      reconcileSpottExportInputSchema.safeParse({
        ...input,
        evidenceRef: "https://provider.invalid/case/123",
      }).success
    ).toBe(false);
    expect(
      reconcileSpottExportInputSchema.safeParse({
        ...input,
        authorizationRef: "linear:RJC-435?token=secret",
      }).success
    ).toBe(false);
    expect(
      reconcileSpottExportInputSchema.safeParse({
        ...input,
        apply: true,
        planHash: "not-a-plan-hash",
      }).success
    ).toBe(false);
  });
});

describe("requireSpottExportReconciliationPrincipal", () => {
  it("requires both operator and export permissions", () => {
    expect(() =>
      requireSpottExportReconciliationPrincipal({
        actorId: "operator-1",
        actorType: "user",
        permissions: new Set(["operator"]),
      })
    ).toThrow(SpottExportReconciliationError);

    expect(() =>
      requireSpottExportReconciliationPrincipal({
        actorId: "admin-1",
        actorType: "user",
        permissions: new Set(["operator", "export"]),
      })
    ).not.toThrow();
  });
});

describe("hashSpottExportReconciliationPlan", () => {
  it("is deterministic and binds the authenticated actor", async () => {
    const first = await hashSpottExportReconciliationPlan(plan);
    const second = await hashSpottExportReconciliationPlan(plan);
    const otherActor = await hashSpottExportReconciliationPlan({
      ...plan,
      actorId: "admin-2",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(otherActor).not.toBe(first);
  });

  it("preserves result ordering and does not expose approval motivation", async () => {
    const forward = await hashOrderedExportResultIds(["a", "b"]);
    const reversed = await hashOrderedExportResultIds(["b", "a"]);
    const motivation = "Sensitive operator justification";
    const motivationHash = await hashExportApprovalMotivation(motivation);

    expect(forward).not.toBe(reversed);
    expect(motivationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(motivationHash).not.toContain(motivation);
  });
});
