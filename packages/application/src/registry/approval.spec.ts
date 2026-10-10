import { describe, expect, it } from "bun:test";

import {
  createSliceARegistry,
  createTestSliceARegistry,
  permissionsForRole,
  TEST_DEPLOYMENT_SCOPE_ID,
} from "@ji/application/registry";

const recruiterPrincipal = {
  kind: "user" as const,
  permissions: permissionsForRole("recruiter"),
  subjectId: "recruiter-1",
};

const approverPrincipal = {
  kind: "user" as const,
  permissions: permissionsForRole("approver"),
  subjectId: "approver-1",
};

const snapshotSelection = (count: number, offset = 0): string[] =>
  Array.from(
    { length: count },
    (_, index) =>
      `00000000-0000-4000-8000-${String(index + offset).padStart(12, "0")}`
  );

const seedAanvragen = (
  bundle: ReturnType<typeof createTestSliceARegistry>,
  ids: readonly string[]
) => {
  for (const [index, id] of ids.entries()) {
    bundle.deps.stores.aanvragen.seed({
      beschrijving: `Azure platform engineer beschrijving ${index}`,
      bronId: "00000000-0000-4000-8000-000000000001",
      bronReferentie: `TN-${index}`,
      id,
      rawPayloadRef: `raw/${id}.json`,
      scrapeRunId: "00000000-0000-4000-8000-000000000020",
      status: "active",
      titel: `Azure engineer ${index}`,
      versies: [],
    });
  }
};

const createSnapshot = async (
  bundle: ReturnType<typeof createTestSliceARegistry>,
  selectedIds: readonly string[],
  query = "Azure"
) => {
  seedAanvragen(bundle, selectedIds);
  const invoker = bundle.registry.createInvoker({
    capabilityId: "create_snapshot",
    operation: "POST /v1/snapshots",
    transport: "rest",
  });
  const created = await invoker(
    { query, selectedIds: [...selectedIds] },
    { principal: recruiterPrincipal, requestId: "snapshot-create" }
  );
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error("Expected snapshot creation to succeed");
  }
  return created.value;
};

describe("approve_snapshot", () => {
  it("allows a same-deployment approver to approve another user's snapshot and writes audit", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(3));
    expect(snapshot.userId).toBe(recruiterPrincipal.subjectId);
    expect(approverPrincipal.subjectId).not.toBe(snapshot.userId);
    const auditBeforeApproval = await bundle.deps.stores.audit.listByActorId(
      approverPrincipal.subjectId,
      TEST_DEPLOYMENT_SCOPE_ID
    );
    const beforeAudit = auditBeforeApproval.length;

    const approve = bundle.registry.createInvoker({
      capabilityId: "approve_snapshot",
      operation: "POST /v1/snapshots/{id}/approval",
      transport: "rest",
    });
    const result = await approve(
      {
        expiresAt: "2027-12-31T00:00:00.000Z",
        id: snapshot.id,
        motivatie: "Resultaten handmatig gecontroleerd",
      },
      { principal: approverPrincipal, requestId: "approve" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.snapshotId).toBe(snapshot.id);
    expect(result.value.actorId).toBe(approverPrincipal.subjectId);
    expect(result.value.resultIds).toEqual(snapshot.resultIds);
    expect(
      await bundle.deps.stores.audit.listByActorId(
        approverPrincipal.subjectId,
        TEST_DEPLOYMENT_SCOPE_ID
      )
    ).toHaveLength(beforeAudit + 1);
  });

  it("rejects approval when the snapshot does not exist", async () => {
    const bundle = createTestSliceARegistry();
    const approve = bundle.registry.createInvoker({
      capabilityId: "approve_snapshot",
      operation: "approve_snapshot",
      transport: "mcp",
    });
    const result = await approve(
      {
        expiresAt: "2027-12-31T00:00:00.000Z",
        id: "00000000-0000-4000-8000-000000000777",
        motivatie: "Onbekende snapshot",
      },
      { principal: approverPrincipal, requestId: "approve-missing" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns the same approval for an exact retry and rejects divergent retries", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(1));
    const approve = bundle.registry.createInvoker({
      capabilityId: "approve_snapshot",
      operation: "approve_snapshot",
      transport: "mcp",
    });
    const input = {
      expiresAt: "2027-12-31T00:00:00.000Z",
      id: snapshot.id,
      motivatie: "Idempotent approval",
    };

    const first = await approve(input, {
      principal: approverPrincipal,
      requestId: "approve-first",
    });
    const retry = await approve(input, {
      principal: approverPrincipal,
      requestId: "approve-retry",
    });
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) {
      return;
    }
    expect(retry.value.id).toBe(first.value.id);
    expect(retry.value.auditEventId).toBe(first.value.auditEventId);

    const divergent = await approve(
      { ...input, motivatie: "Different retry" },
      { principal: approverPrincipal, requestId: "approve-divergent" }
    );
    expect(divergent.ok).toBe(false);
    if (!divergent.ok) {
      expect(divergent.error.code).toBe("ALREADY_APPROVED");
    }

    const actorTypeConflict = await approve(input, {
      principal: { ...approverPrincipal, kind: "service" },
      requestId: "approve-actor-type-conflict",
    });
    expect(actorTypeConflict.ok).toBe(false);
    if (!actorTypeConflict.ok) {
      expect(actorTypeConflict.error.code).toBe("ALREADY_APPROVED");
    }

    const audit = await bundle.deps.stores.audit.listByActorId(
      approverPrincipal.subjectId,
      TEST_DEPLOYMENT_SCOPE_ID
    );
    expect(audit).toHaveLength(1);
  });

  it("denies recruiters without approval permission", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(1));
    const approve = bundle.registry.createInvoker({
      capabilityId: "approve_snapshot",
      operation: "approve_snapshot",
      transport: "mcp",
    });
    const result = await approve(
      {
        expiresAt: "2027-12-31T00:00:00.000Z",
        id: snapshot.id,
        motivatie: "Recruiter mag niet goedkeuren",
      },
      { principal: recruiterPrincipal, requestId: "approve-denied" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result.error) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("hides snapshots and approvals from another deployment scope", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(1));
    const otherScopeRegistry = createSliceARegistry({
      ...bundle.deps,
      scopeId: "other-deployment",
    }).registry;

    const crossScopeApprove = otherScopeRegistry.createInvoker({
      capabilityId: "approve_snapshot",
      operation: "approve_snapshot",
      transport: "mcp",
    });
    const approveResult = await crossScopeApprove(
      {
        expiresAt: "2027-12-31T00:00:00.000Z",
        id: snapshot.id,
        motivatie: "Must remain invisible",
      },
      { principal: approverPrincipal, requestId: "cross-scope-approve" }
    );
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe("NOT_FOUND");
    }

    const sameScopeApprove = bundle.registry.createInvoker({
      capabilityId: "approve_snapshot",
      operation: "approve_snapshot",
      transport: "mcp",
    });
    const sameScopeResult = await sameScopeApprove(
      {
        expiresAt: "2027-12-31T00:00:00.000Z",
        id: snapshot.id,
        motivatie: "Visible only in the owning deployment",
      },
      { principal: approverPrincipal, requestId: "same-scope-approve" }
    );
    expect(sameScopeResult.ok).toBe(true);

    const crossScopeGet = otherScopeRegistry.createInvoker({
      capabilityId: "get_snapshot_approval",
      operation: "get_snapshot_approval",
      transport: "mcp",
    });
    const getResult = await crossScopeGet(
      { id: snapshot.id },
      { principal: approverPrincipal, requestId: "cross-scope-get" }
    );
    expect(getResult.ok).toBe(false);
    if (!getResult.ok) {
      expect(getResult.error.code).toBe("NOT_FOUND");
    }

    const crossScopeValidate = otherScopeRegistry.createInvoker({
      capabilityId: "validate_snapshot_approval",
      operation: "validate_snapshot_approval",
      transport: "mcp",
    });
    const validateResult = await crossScopeValidate(
      { id: snapshot.id },
      { principal: approverPrincipal, requestId: "cross-scope-validate" }
    );
    expect(validateResult.ok).toBe(false);
    if (!validateResult.ok) {
      expect(validateResult.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("validate_snapshot_approval", () => {
  it("accepts a valid unexpired approval for the same snapshot", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(2));
    const approve = bundle.registry.createInvoker({
      capabilityId: "approve_snapshot",
      operation: "approve_snapshot",
      transport: "mcp",
    });
    await approve(
      {
        expiresAt: "2027-12-31T00:00:00.000Z",
        id: snapshot.id,
        motivatie: "OK voor exportvoorbereiding",
      },
      { principal: approverPrincipal, requestId: "approve-valid" }
    );

    const validate = bundle.registry.createInvoker({
      capabilityId: "validate_snapshot_approval",
      operation: "validate_snapshot_approval",
      transport: "mcp",
    });
    const result = await validate(
      { id: snapshot.id },
      { principal: approverPrincipal, requestId: "validate-ok" }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(true);
      expect(result.value.snapshotId).toBe(snapshot.id);
    }
  });

  it("rejects expired approvals", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(2));
    await bundle.deps.stores.approvals.createWithAudit(
      {
        actorId: approverPrincipal.subjectId,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        motivatie: "Verlopen",
        resultIds: [...snapshot.resultIds],
        scopeId: TEST_DEPLOYMENT_SCOPE_ID,
        snapshotId: snapshot.id,
      },
      "user"
    );

    const validate = bundle.registry.createInvoker({
      capabilityId: "validate_snapshot_approval",
      operation: "validate_snapshot_approval",
      transport: "mcp",
    });
    const result = await validate(
      { id: snapshot.id },
      { principal: approverPrincipal, requestId: "validate-expired" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APPROVAL_EXPIRED");
    }
  });

  it("does not reuse an approval from another snapshot with different result ids", async () => {
    const bundle = createTestSliceARegistry();
    const firstSnapshot = await createSnapshot(bundle, snapshotSelection(2));
    const secondSnapshot = await createSnapshot(bundle, snapshotSelection(3));
    expect(secondSnapshot.resultIds).not.toEqual(firstSnapshot.resultIds);

    await bundle.deps.stores.approvals.createWithAudit(
      {
        actorId: approverPrincipal.subjectId,
        expiresAt: new Date("2027-12-31T00:00:00.000Z"),
        motivatie: "Alleen eerste snapshot",
        resultIds: [...firstSnapshot.resultIds],
        scopeId: TEST_DEPLOYMENT_SCOPE_ID,
        snapshotId: firstSnapshot.id,
      },
      "user"
    );

    const validate = bundle.registry.createInvoker({
      capabilityId: "validate_snapshot_approval",
      operation: "validate_snapshot_approval",
      transport: "mcp",
    });
    const secondResult = await validate(
      { id: secondSnapshot.id },
      { principal: approverPrincipal, requestId: "validate-second" }
    );
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.error.code).toBe("APPROVAL_NOT_FOUND");
    }
  });
});
