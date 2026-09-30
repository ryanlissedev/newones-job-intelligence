import { describe, expect, it } from "bun:test";

import {
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
  offset: number,
  query: string
) => {
  const selectedIds = snapshotSelection(1, offset);
  seedAanvragen(bundle, selectedIds);
  const invoker = bundle.registry.createInvoker({
    capabilityId: "create_snapshot",
    operation: "POST /v1/snapshots",
    transport: "rest",
  });
  const created = await invoker(
    { query, selectedIds: [...selectedIds] },
    { principal: recruiterPrincipal, requestId: `create-${offset}` }
  );
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error("Expected snapshot creation to succeed");
  }
  return created.value;
};

const approve = async (
  bundle: ReturnType<typeof createTestSliceARegistry>,
  snapshotId: string,
  resultIds: readonly string[],
  expiresAt: string
) => {
  const result = await bundle.deps.stores.approvals.createWithAudit(
    {
      actorId: approverPrincipal.subjectId,
      expiresAt: new Date(expiresAt),
      motivatie: "Gecontroleerd",
      resultIds: [...resultIds],
      scopeId: TEST_DEPLOYMENT_SCOPE_ID,
      snapshotId,
    },
    "user"
  );
  expect(result.ok).toBe(true);
};

const recordAttempt = (
  bundle: ReturnType<typeof createTestSliceARegistry>,
  snapshotId: string,
  approvalId: string,
  status: "created" | "failed" | "skipped",
  externalId: string | null = null
) =>
  bundle.deps.stores.exportAttempts.create({
    actionType: "create",
    approvalId,
    canonicalVacancyId: "00000000-0000-4000-8000-000000000901",
    errorMessage: status === "failed" ? "Spott refused" : null,
    externalId,
    idempotencyKey: `idem-${snapshotId}-${status}`,
    scopeId: TEST_DEPLOYMENT_SCOPE_ID,
    snapshotId,
    status,
    target: "spott",
  });

const list = (bundle: ReturnType<typeof createTestSliceARegistry>) =>
  bundle.registry.createInvoker({
    capabilityId: "list_snapshots",
    operation: "GET /v1/snapshots",
    transport: "rest",
  });

const listSnapshots = async (
  bundle: ReturnType<typeof createTestSliceARegistry>,
  input: Record<string, never> | { cursor?: string; limit?: number } = {}
) => {
  const result = await list(bundle)(input, {
    principal: recruiterPrincipal,
    requestId: "list",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected list_snapshots to succeed");
  }
  return result.value;
};

describe("list_snapshots (CTP-652)", () => {
  it("derives pending, approved, committed and failed from approval and attempts", async () => {
    const bundle = createTestSliceARegistry();

    const pending = await createSnapshot(bundle, 0, "query pending");
    const approved = await createSnapshot(bundle, 10, "query approved");
    const failed = await createSnapshot(bundle, 20, "query failed");
    const committed = await createSnapshot(bundle, 30, "query committed");

    // Expired approval alone never produces "approved".
    await approve(
      bundle,
      pending.id,
      pending.resultIds,
      "2026-09-01T00:00:00.000Z"
    );
    await approve(
      bundle,
      approved.id,
      approved.resultIds,
      "2099-01-01T00:00:00.000Z"
    );
    await approve(
      bundle,
      failed.id,
      failed.resultIds,
      "2099-01-01T00:00:00.000Z"
    );
    await approve(
      bundle,
      committed.id,
      committed.resultIds,
      "2099-01-01T00:00:00.000Z"
    );

    const failedApproval = await bundle.deps.stores.approvals.getBySnapshotId(
      failed.id,
      TEST_DEPLOYMENT_SCOPE_ID
    );
    const committedApproval =
      await bundle.deps.stores.approvals.getBySnapshotId(
        committed.id,
        TEST_DEPLOYMENT_SCOPE_ID
      );
    if (!failedApproval || !committedApproval) {
      throw new Error("Expected approvals to be stored");
    }
    await recordAttempt(bundle, failed.id, failedApproval.id, "failed");
    await recordAttempt(
      bundle,
      committed.id,
      committedApproval.id,
      "created",
      "spott-42"
    );

    const page = await listSnapshots(bundle);
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).toBeNull();

    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(pending.id)?.status).toBe("pending");
    expect(byId.get(approved.id)?.status).toBe("approved");
    expect(byId.get(failed.id)?.status).toBe("failed");
    expect(byId.get(committed.id)?.status).toBe("committed");

    expect(byId.get(committed.id)?.export).toEqual({
      externalIdCount: 1,
      lastAttemptAt: expect.any(String),
      status: "created",
    });
    expect(byId.get(approved.id)?.approval?.actorId).toBe(
      approverPrincipal.subjectId
    );
    expect(byId.get(pending.id)?.approval).not.toBeNull();
  });

  it("pages by keyset cursor without duplicates", async () => {
    const bundle = createTestSliceARegistry();
    const ids = await Promise.all([
      createSnapshot(bundle, 40, "q1"),
      createSnapshot(bundle, 41, "q2"),
      createSnapshot(bundle, 42, "q3"),
      createSnapshot(bundle, 43, "q4"),
    ]);

    const first = await listSnapshots(bundle, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listSnapshots(bundle, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const pagedIds = [
      ...first.items.map((item) => item.id),
      ...second.items.map((item) => item.id),
    ];
    expect(new Set(pagedIds).size).toBe(4);
    expect(pagedIds.toSorted()).toEqual(ids.map((item) => item.id).toSorted());
    // Keyset order: createdAt desc, id desc.
    const keys = [...first.items, ...second.items].map(
      (item) => [item.createdAt, item.id] as const
    );
    const sortedKeys = [...keys].toSorted((left, right) =>
      right[0].localeCompare(left[0]) === 0
        ? right[1].localeCompare(left[1])
        : right[0].localeCompare(left[0])
    );
    expect(keys).toEqual(sortedKeys);
  });

  it("rejects a malformed cursor", async () => {
    const bundle = createTestSliceARegistry();
    const result = await list(bundle)(
      { cursor: "not-a-cursor" },
      { principal: recruiterPrincipal, requestId: "bad-cursor" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("is readable by an approver (slice-a:read) and only lists own snapshots", async () => {
    const bundle = createTestSliceARegistry();
    await createSnapshot(bundle, 50, "recruiter snapshot");

    const approverView = await list(bundle)(
      {},
      { principal: approverPrincipal, requestId: "list-approver" }
    );
    expect(approverView.ok).toBe(true);
    if (approverView.ok) {
      // Owner-scoped: the approver sees its own (empty) list, not the
      // recruiter's snapshot.
      expect(approverView.value.items).toHaveLength(0);
    }
  });
});
