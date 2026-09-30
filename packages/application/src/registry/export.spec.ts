import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
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

const seedAanvragenForSnapshot = (
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
  seedAanvragenForSnapshot(bundle, selectedIds);
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

const approveSnapshot = async (
  bundle: ReturnType<typeof createTestSliceARegistry>,
  snapshotId: string
) => {
  const invoker = bundle.registry.createInvoker({
    capabilityId: "approve_snapshot",
    operation: "POST /v1/snapshots/{id}/approval",
    transport: "rest",
  });
  const result = await invoker(
    {
      expiresAt: "2027-12-31T00:00:00.000Z",
      id: snapshotId,
      motivatie: "Handmatig gecontroleerd",
    },
    { principal: approverPrincipal, requestId: "approve" }
  );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected approval to succeed");
  }
  return result.value;
};

describe("commit_export", () => {
  it("creates once and skips on replay for the same approved snapshot", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(2));
    await approveSnapshot(bundle, snapshot.id);

    const commit = bundle.registry.createInvoker({
      capabilityId: "commit_export",
      operation: "POST /v1/exports",
      transport: "rest",
    });

    const first = await commit(
      { snapshotId: snapshot.id },
      { principal: approverPrincipal, requestId: "export-1" }
    );
    const second = await commit(
      { snapshotId: snapshot.id },
      { principal: approverPrincipal, requestId: "export-2" }
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.value.summary).toEqual({ created: 2, failed: 0, skipped: 0 });
    expect(second.value.summary).toEqual({ created: 0, failed: 0, skipped: 2 });
    expect(bundle.deps.stores.exportAttempts.list()).toHaveLength(4);
    expect(bundle.deps.stores.externalReceipts.list()).toHaveLength(4);
  });

  it("refuses export without approval", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(1));

    const commit = bundle.registry.createInvoker({
      capabilityId: "commit_export",
      operation: "commit_export",
      transport: "mcp",
    });
    const result = await commit(
      { snapshotId: snapshot.id },
      { principal: approverPrincipal, requestId: "export-no-approval" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APPROVAL_NOT_FOUND");
    }
  });

  it("does not reuse approval from another snapshot", async () => {
    const bundle = createTestSliceARegistry();
    const snapshotA = await createSnapshot(bundle, snapshotSelection(1));
    await approveSnapshot(bundle, snapshotA.id);

    const snapshotB = await createSnapshot(bundle, snapshotSelection(1, 1));

    const commit = bundle.registry.createInvoker({
      capabilityId: "commit_export",
      operation: "commit_export",
      transport: "mcp",
    });
    const result = await commit(
      { snapshotId: snapshotB.id },
      { principal: approverPrincipal, requestId: "export-other-snapshot" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APPROVAL_NOT_FOUND");
    }
  });

  it("denies recruiters without export permission", async () => {
    const bundle = createTestSliceARegistry();
    const snapshot = await createSnapshot(bundle, snapshotSelection(1));
    await approveSnapshot(bundle, snapshot.id);

    const commit = bundle.registry.createInvoker({
      capabilityId: "commit_export",
      operation: "commit_export",
      transport: "mcp",
    });
    const result = await commit(
      { snapshotId: snapshot.id },
      { principal: recruiterPrincipal, requestId: "export-forbidden" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });
});
