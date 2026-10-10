import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import type { InvocationPrincipal } from "@ji/application/registry";
import { z } from "zod";

const owner = {
  kind: "user" as const,
  permissions: permissionsForRole("admin"),
  subjectId: "saved-search-owner",
};
const other = { ...owner, subjectId: "other-user" };
const createdResourceSchema = z.object({ id: z.string().uuid() }).passthrough();
const exportStatusValueSchema = z
  .object({
    attempts: z.array(
      z
        .object({
          receipt: z
            .object({ id: z.string(), responseHash: z.string() })
            .strict()
            .nullable(),
        })
        .passthrough()
    ),
  })
  .passthrough();

const invoke = (
  bundle: ReturnType<typeof createTestSliceARegistry>,
  capabilityId: string,
  operation: string,
  transport: "mcp" | "rest",
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The registry boundary deliberately receives untrusted transport input in parity tests.
  input: unknown,
  principal: InvocationPrincipal = owner
) =>
  bundle.registry.createInvoker({ capabilityId, operation, transport })(input, {
    principal,
    requestId: `${transport}-${capabilityId}`,
  });

describe("user-owned resource CRUD parity (RJC-444)", () => {
  it("syncs one actor's marker between agent and UI reads without audit duplication (RJC-445)", async () => {
    const bundle = createTestSliceARegistry();
    const aanvraagId = "00000000-0000-4000-8000-000000000046";
    bundle.deps.stores.aanvragen.seed({
      beschrijving: "Synthetic sync resource",
      bronId: "00000000-0000-4000-8000-000000000001",
      bronReferentie: "RJC-445",
      id: aanvraagId,
      rawPayloadRef: "raw/rjc-445.json",
      scrapeRunId: "00000000-0000-4000-8000-000000000020",
      status: "active",
      titel: "Synthetic sync job",
      versies: [],
    });
    const sameActorAgent = {
      kind: "agent" as const,
      permissions: permissionsForRole("recruiter"),
      subjectId: "rjc-445-actor",
    };
    const sameActorUi = { ...sameActorAgent, kind: "user" as const };
    const otherActorUi = { ...sameActorUi, subjectId: "rjc-445-other" };

    const markedByAgent = await invoke(
      bundle,
      "markeer_aanvraag",
      "markeer_aanvraag",
      "mcp",
      { aanvraagId, status: "relevant" },
      sameActorAgent
    );
    expect(markedByAgent).toMatchObject({
      ok: true,
      value: { revision: 1, status: "relevant" },
    });

    const uiRead = () =>
      invoke(
        bundle,
        "get_markering",
        "GET /v1/aanvragen/{id}/markering",
        "rest",
        { aanvraagId },
        sameActorUi
      );
    const firstUiRead = await uiRead();
    const repeatedUiRead = await uiRead();
    expect(firstUiRead).toMatchObject({
      ok: true,
      value: { revision: 1, status: "relevant" },
    });
    expect(repeatedUiRead).toEqual(firstUiRead);
    expect(
      await invoke(
        bundle,
        "get_markering",
        "get_markering",
        "mcp",
        { aanvraagId },
        otherActorUi
      )
    ).toMatchObject({ error: { code: "NOT_FOUND" }, ok: false });

    const auditAfterAgentCommit = await bundle.deps.stores.audit.listByActorId(
      sameActorAgent.subjectId,
      bundle.deps.scopeId
    );
    expect(auditAfterAgentCommit).toHaveLength(1);

    const uiCommit = await invoke(
      bundle,
      "markeer_aanvraag",
      "POST /v1/aanvragen/{id}/markering",
      "rest",
      { aanvraagId, status: "gevolgd" },
      sameActorUi
    );
    expect(uiCommit).toMatchObject({
      ok: true,
      value: { revision: 2, status: "gevolgd" },
    });
    const agentRead = await invoke(
      bundle,
      "get_markering",
      "get_markering",
      "mcp",
      { aanvraagId },
      sameActorAgent
    );
    expect(agentRead).toMatchObject({
      ok: true,
      value: { revision: 2, status: "gevolgd" },
    });
    expect(
      await bundle.deps.stores.audit.listByActorId(
        sameActorAgent.subjectId,
        bundle.deps.scopeId
      )
    ).toHaveLength(2);
  });

  it("keeps saved-search CRUD owner-scoped across REST and MCP", async () => {
    const bundle = createTestSliceARegistry();
    const created = await invoke(
      bundle,
      "create_saved_search",
      "POST /v1/saved-searches",
      "rest",
      { naam: "Azure", query: "Azure AND engineer" }
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const createdValue = createdResourceSchema.parse(created.value);
    expect(created.value).toMatchObject({ parserVersion: "1" });

    const denied = await invoke(
      bundle,
      "get_saved_search",
      "get_saved_search",
      "mcp",
      { id: createdValue.id },
      other
    );
    expect(denied).toMatchObject({ error: { code: "NOT_FOUND" }, ok: false });

    const updated = await invoke(
      bundle,
      "update_saved_search",
      "update_saved_search",
      "mcp",
      { id: createdValue.id, naam: "Azure NL" }
    );
    expect(updated).toMatchObject({ ok: true, value: { naam: "Azure NL" } });

    const listed = await invoke(
      bundle,
      "list_saved_searches",
      "GET /v1/saved-searches",
      "rest",
      {}
    );
    expect(listed).toMatchObject({ ok: true, value: [{ naam: "Azure NL" }] });

    const removed = await invoke(
      bundle,
      "remove_saved_search",
      "remove_saved_search",
      "mcp",
      { id: createdValue.id }
    );
    expect(removed).toMatchObject({ ok: true, value: { removed: true } });
    const afterRemove = await invoke(
      bundle,
      "get_saved_search",
      "GET /v1/saved-searches/{id}",
      "rest",
      { id: createdValue.id }
    );
    expect(afterRemove).toMatchObject({
      error: { code: "NOT_FOUND" },
      ok: false,
    });

    const audit = await bundle.deps.stores.audit.listByActorId(
      owner.subjectId,
      bundle.deps.scopeId
    );
    expect(audit.map((event) => event.action)).toEqual([
      "create_saved_search",
      "update_saved_search",
      "remove_saved_search",
    ]);
  });

  it("rejects malformed saved-search queries without persistence; empty browse is allowed", async () => {
    const bundle = createTestSliceARegistry();
    const malformed = await invoke(
      bundle,
      "create_saved_search",
      "create_saved_search",
      "mcp",
      { naam: "Malformed", query: "Azure AND" }
    );
    const empty = await invoke(
      bundle,
      "create_saved_search",
      "POST /v1/saved-searches",
      "rest",
      { naam: "Empty", query: "" }
    );

    expect(malformed).toMatchObject({
      error: { code: "SYNTAX_ERROR" },
      ok: false,
    });
    expect(empty).toMatchObject({
      ok: true,
      value: { parserVersion: "1", queryText: "" },
    });
    expect(
      await bundle.deps.stores.savedSearches.list(
        owner.subjectId,
        bundle.deps.scopeId
      )
    ).toHaveLength(1);
    expect(
      await bundle.deps.stores.audit.listByActorId(
        owner.subjectId,
        bundle.deps.scopeId
      )
    ).toHaveLength(1);
  });

  it("reads and clears only the caller's markering while retaining audit", async () => {
    const bundle = createTestSliceARegistry();
    const aanvraagId = "00000000-0000-4000-8000-000000000044";
    bundle.deps.stores.aanvragen.seed({
      beschrijving: "Synthetic",
      bronId: "00000000-0000-4000-8000-000000000001",
      bronReferentie: "RJC-444",
      id: aanvraagId,
      rawPayloadRef: "raw/rjc-444.json",
      scrapeRunId: "00000000-0000-4000-8000-000000000020",
      status: "active",
      titel: "Synthetic vacature",
      versies: [],
    });
    await invoke(
      bundle,
      "markeer_aanvraag",
      "POST /v1/aanvragen/{id}/markering",
      "rest",
      { aanvraagId, status: "relevant" }
    );
    const otherRead = await invoke(
      bundle,
      "get_markering",
      "get_markering",
      "mcp",
      { aanvraagId },
      other
    );
    expect(otherRead).toMatchObject({
      error: { code: "NOT_FOUND" },
      ok: false,
    });
    const cleared = await invoke(
      bundle,
      "clear_markering",
      "clear_markering",
      "mcp",
      { aanvraagId }
    );
    expect(cleared).toMatchObject({ ok: true, value: { cleared: true } });
    expect(
      await bundle.deps.stores.markeringen.get(
        aanvraagId,
        owner.subjectId,
        bundle.deps.scopeId
      )
    ).toBeNull();
    const recreated = await invoke(
      bundle,
      "markeer_aanvraag",
      "POST /v1/aanvragen/{id}/markering",
      "rest",
      { aanvraagId, status: "gevolgd" }
    );
    expect(recreated).toMatchObject({
      ok: true,
      value: { revision: 2, status: "gevolgd" },
    });
    const audit = await bundle.deps.stores.audit.listByActorId(
      owner.subjectId,
      bundle.deps.scopeId
    );
    expect(audit.map((event) => event.action)).toEqual([
      "markeer_aanvraag",
      "clear_markering",
      "markeer_aanvraag",
    ]);
  });

  it("returns immutable snapshot evidence and never upgrades fixture receipts to confirmed", async () => {
    const bundle = createTestSliceARegistry();
    const aanvraagId = "00000000-0000-4000-8000-000000000045";
    bundle.deps.stores.aanvragen.seed({
      beschrijving: "Synthetic",
      bronId: "00000000-0000-4000-8000-000000000001",
      bronReferentie: "RJC-444-export",
      id: aanvraagId,
      rawPayloadRef: "raw/rjc-444-export.json",
      scrapeRunId: "00000000-0000-4000-8000-000000000020",
      status: "active",
      titel: "Synthetic export",
      versies: [],
    });
    const created = await invoke(
      bundle,
      "create_snapshot",
      "POST /v1/snapshots",
      "rest",
      { query: "Azure", selectedIds: [aanvraagId] }
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const createdValue = createdResourceSchema.parse(created.value);

    const readback = await invoke(
      bundle,
      "get_snapshot",
      "get_snapshot",
      "mcp",
      { id: createdValue.id }
    );
    expect(readback).toMatchObject({
      ok: true,
      value: {
        approval: null,
        provenance: { parserVersion: "1", schemaVersion: "slice-a-v1" },
        resultIds: [aanvraagId],
      },
    });

    const emptyStatus = await invoke(
      bundle,
      "get_export_status",
      "GET /v1/exports/{snapshotId}",
      "rest",
      { snapshotId: createdValue.id }
    );
    expect(emptyStatus).toMatchObject({
      ok: true,
      value: { status: "no_attempt" },
    });

    const attempt = await bundle.deps.stores.exportAttempts.create({
      actionType: "create",
      approvalId: "00000000-0000-4000-8000-000000000099",
      canonicalVacancyId: aanvraagId,
      errorMessage: null,
      externalId: "fixture-123",
      idempotencyKey: "spott:create:fixture",
      scopeId: bundle.deps.scopeId,
      snapshotId: createdValue.id,
      status: "created",
      target: "spott",
    });
    await bundle.deps.stores.externalReceipts.create({
      canonicalVacancyId: aanvraagId,
      confirmedEffect: true,
      exportAttemptId: attempt.id,
      responseHash: "a".repeat(64),
      scopeId: bundle.deps.scopeId,
      spottVacancyId: "fixture-123",
    });
    const status = await invoke(
      bundle,
      "get_export_status",
      "get_export_status",
      "mcp",
      { snapshotId: createdValue.id }
    );
    expect(status).toMatchObject({
      ok: true,
      value: { liveConfirmationAvailable: false, status: "unknown" },
    });
    if (!status.ok) {
      return;
    }
    const statusValue = exportStatusValueSchema.parse(status.value);
    expect(statusValue.attempts[0]?.receipt).toMatchObject({
      id: expect.any(String),
      responseHash: "a".repeat(64),
    });
  });

  it("fails closed for contradictory receipts across mixed export retries", async () => {
    const bundle = createTestSliceARegistry();
    const aanvraagId = "00000000-0000-4000-8000-000000000046";
    bundle.deps.stores.aanvragen.seed({
      beschrijving: "Synthetic",
      bronId: "00000000-0000-4000-8000-000000000001",
      bronReferentie: "RJC-444-export-retry",
      id: aanvraagId,
      rawPayloadRef: "raw/rjc-444-export-retry.json",
      scrapeRunId: "00000000-0000-4000-8000-000000000020",
      status: "active",
      titel: "Synthetic export retry",
      versies: [],
    });
    const created = await invoke(
      bundle,
      "create_snapshot",
      "POST /v1/snapshots",
      "rest",
      { query: "Azure", selectedIds: [aanvraagId] }
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const createdValue = createdResourceSchema.parse(created.value);

    const failedAttempt = await bundle.deps.stores.exportAttempts.create({
      actionType: "create",
      approvalId: "00000000-0000-4000-8000-000000000099",
      canonicalVacancyId: aanvraagId,
      errorMessage: "confirmation timed out",
      externalId: "fixture-confirmed-after-timeout",
      idempotencyKey: "spott:create:fixture:retry-1",
      scopeId: bundle.deps.scopeId,
      snapshotId: createdValue.id,
      status: "failed",
      target: "spott",
    });
    await bundle.deps.stores.externalReceipts.create({
      canonicalVacancyId: aanvraagId,
      confirmedEffect: true,
      exportAttemptId: failedAttempt.id,
      responseHash: "b".repeat(64),
      scopeId: bundle.deps.scopeId,
      spottVacancyId: "fixture-confirmed-after-timeout",
    });

    const retryAttempt = await bundle.deps.stores.exportAttempts.create({
      actionType: "create",
      approvalId: "00000000-0000-4000-8000-000000000099",
      canonicalVacancyId: aanvraagId,
      errorMessage: "confirmation unavailable",
      externalId: "fixture-retry",
      idempotencyKey: "spott:create:fixture:retry-2",
      scopeId: bundle.deps.scopeId,
      snapshotId: createdValue.id,
      status: "failed",
      target: "spott",
    });
    await bundle.deps.stores.externalReceipts.create({
      canonicalVacancyId: aanvraagId,
      confirmedEffect: false,
      exportAttemptId: retryAttempt.id,
      responseHash: "c".repeat(64),
      scopeId: bundle.deps.scopeId,
      spottVacancyId: "fixture-retry",
    });

    const status = await invoke(
      bundle,
      "get_export_status",
      "GET /v1/exports/{snapshotId}",
      "rest",
      { snapshotId: createdValue.id }
    );
    expect(status).toMatchObject({
      ok: true,
      value: { liveConfirmationAvailable: false, status: "unknown" },
    });
    if (!status.ok) {
      return;
    }
    const statusValue = exportStatusValueSchema.parse(status.value);
    expect(statusValue.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: failedAttempt.id, status: "unknown" }),
        expect.objectContaining({ id: retryAttempt.id, status: "failed" }),
      ])
    );
  });
});
