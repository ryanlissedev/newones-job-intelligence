import { describe, expect, it } from "bun:test";

import {
  createSliceARegistry,
  getOperatorContextOutputSchema,
  OPERATOR_CONTEXT_CONTRACT_VERSION,
  permissionsForRole,
  ROLE_OPERATOR,
} from "@ji/application/registry";

import { createTestSliceADeps } from "./test-fixtures";

const actorA = "operator-a";
const actorB = "operator-b";
const resultId = "30000000-0000-4000-8000-000000000001";
const missingId = "40000000-0000-4000-8000-000000000001";

const invokeOperatorContext = (
  bundle: ReturnType<typeof createSliceARegistry>,
  subjectId: string,
  input: { readonly savedSearchId?: string; readonly snapshotId?: string },
  permissions: ReadonlySet<string> = permissionsForRole(ROLE_OPERATOR)
) =>
  bundle.registry.createInvoker({
    capabilityId: "get_operator_context",
    operation: "POST /v1/agent/context",
    transport: "rest",
  })(input, {
    principal: { kind: "agent", permissions, subjectId },
    requestId: `operator-context-${subjectId}`,
  });

describe("get_operator_context", () => {
  it("rejects a session after its operator permission is revoked", async () => {
    const deps = createTestSliceADeps();
    const bundle = createSliceARegistry(deps);
    const sessionPermissions = new Set(permissionsForRole(ROLE_OPERATOR));
    sessionPermissions.delete(ROLE_OPERATOR);

    const result = await invokeOperatorContext(
      bundle,
      actorA,
      {},
      sessionPermissions
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("does not disclose explicit selections across actors or scopes", async () => {
    const deps = createTestSliceADeps("scope-a");
    const { savedSearch } = await deps.stores.savedSearches.createWithAudit(
      {
        deletedAt: null,
        filters: {},
        naam: "Mijn zoekopdracht",
        parserVersion: "1",
        queryText: "private-query",
        schemaVersion: "slice-a-v1",
        scopeId: "scope-a",
        userId: actorA,
      },
      "user"
    );
    const snapshot = await deps.stores.snapshots.create({
      filters: {},
      indexVersion: 7,
      parserVersion: "1",
      queryText: "private-query",
      resultIds: [resultId],
      savedSearchId: savedSearch.id,
      schemaVersion: "slice-a-v1",
      scope: "active",
      scopeId: "scope-a",
      searchVersion: { appliedSequence: 7n, generation: 1 },
      userId: actorA,
    });
    const scopeABundle = createSliceARegistry(deps);
    const scopeBBundle = createSliceARegistry({ ...deps, scopeId: "scope-b" });

    const foreignActor = await invokeOperatorContext(scopeABundle, actorB, {
      savedSearchId: savedSearch.id,
    });
    const missingActor = await invokeOperatorContext(scopeABundle, actorB, {
      savedSearchId: missingId,
    });
    const foreignSnapshot = await invokeOperatorContext(scopeABundle, actorB, {
      snapshotId: snapshot.id,
    });
    const foreignScope = await invokeOperatorContext(scopeBBundle, actorA, {
      snapshotId: snapshot.id,
    });

    for (const result of [
      foreignActor,
      missingActor,
      foreignSnapshot,
      foreignScope,
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    }
    if (!(foreignActor.ok || missingActor.ok)) {
      expect(foreignActor.error.message).toBe(missingActor.error.message);
    }
  });

  it("returns a stable, minimal digest that changes with relevant safe state", async () => {
    const unavailable = new Set<string>();
    let now = new Date("2026-09-05T10:00:00.000Z");
    const deps = createTestSliceADeps();
    const bundle = createSliceARegistry({
      ...deps,
      capabilityAvailability: {
        unavailableCapabilityIds: () => unavailable,
      },
      now: () => now,
    });
    const { savedSearch } = await deps.stores.savedSearches.createWithAudit(
      {
        deletedAt: null,
        filters: { locatie: ["secret-filter-value"] },
        naam: "Veilige naam",
        parserVersion: "1",
        queryText: "secret-query-value",
        schemaVersion: "slice-a-v1",
        scopeId: deps.scopeId,
        userId: actorA,
      },
      "user"
    );
    const snapshot = await deps.stores.snapshots.create({
      filters: { locatie: ["secret-filter-value"] },
      indexVersion: 9,
      parserVersion: "1",
      queryText: "secret-query-value",
      resultIds: [resultId],
      savedSearchId: savedSearch.id,
      schemaVersion: "slice-a-v1",
      scope: "active",
      scopeId: deps.scopeId,
      searchVersion: { appliedSequence: 9n, generation: 2 },
      userId: actorA,
    });
    const input = {
      savedSearchId: savedSearch.id,
      snapshotId: snapshot.id,
    };

    const first = await invokeOperatorContext(bundle, actorA, input);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.error.message);
    }
    expect(getOperatorContextOutputSchema.safeParse(first.value).success).toBe(
      true
    );
    expect(first.value.contract.version).toBe(
      OPERATOR_CONTEXT_CONTRACT_VERSION
    );
    expect(first.value.freshness.savedSearch.state).toBe("present");
    expect(first.value.freshness.snapshot.state).toBe("present");
    expect(first.value.provenance.capabilities).toBe(
      "permission-filtered-capability-registry"
    );
    expect(
      first.value.capabilities.items.every((item) =>
        permissionsForRole(ROLE_OPERATOR).has(
          bundle.registry.catalog.find((entry) => entry.id === item.id)
            ?.authorization.permission ?? ""
        )
      )
    ).toBe(true);
    const serialized = JSON.stringify(first.value);
    expect(serialized).not.toContain("secret-query-value");
    expect(serialized).not.toContain("secret-filter-value");
    expect(serialized).not.toContain(resultId);
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).not.toContain("secretRef");

    now = new Date("2026-09-05T11:00:00.000Z");
    const laterRead = await invokeOperatorContext(bundle, actorA, input);
    expect(laterRead.ok).toBe(true);
    if (!laterRead.ok) {
      throw new Error(laterRead.error.message);
    }
    expect(laterRead.value.freshness.readAt).not.toBe(
      first.value.freshness.readAt
    );
    expect(laterRead.value.contract.digest).toBe(first.value.contract.digest);

    await deps.stores.audit.append({
      action: "markeer_aanvraag",
      actorId: actorA,
      actorType: "agent",
      auditClass: "effect",
      entityId: "private-entity-id",
      entityType: "aanvraag",
      metadata: { reden: null, status: "relevant" },
      scopeId: deps.scopeId,
    });
    const afterAudit = await invokeOperatorContext(bundle, actorA, input);
    expect(afterAudit.ok).toBe(true);
    if (!afterAudit.ok) {
      throw new Error(afterAudit.error.message);
    }
    expect(afterAudit.value.contract.digest).not.toBe(
      laterRead.value.contract.digest
    );
    expect(JSON.stringify(afterAudit.value)).not.toContain("private-entity-id");

    const { savedSearch: anotherSavedSearch } =
      await deps.stores.savedSearches.createWithAudit(
        {
          deletedAt: null,
          filters: {},
          naam: "Andere veilige naam",
          parserVersion: "1",
          queryText: "another-private-query",
          schemaVersion: "slice-a-v1",
          scopeId: deps.scopeId,
          userId: actorA,
        },
        "user"
      );
    const afterResource = await invokeOperatorContext(bundle, actorA, {
      savedSearchId: anotherSavedSearch.id,
      snapshotId: snapshot.id,
    });
    expect(afterResource.ok).toBe(true);
    if (!afterResource.ok) {
      throw new Error(afterResource.error.message);
    }
    expect(afterResource.value.contract.digest).not.toBe(
      afterAudit.value.contract.digest
    );

    unavailable.add("list_alerts");
    const afterAvailability = await invokeOperatorContext(bundle, actorA, {
      savedSearchId: anotherSavedSearch.id,
      snapshotId: snapshot.id,
    });
    expect(afterAvailability.ok).toBe(true);
    if (!afterAvailability.ok) {
      throw new Error(afterAvailability.error.message);
    }
    expect(afterAvailability.value.contract.digest).not.toBe(
      afterResource.value.contract.digest
    );
    expect(
      afterAvailability.value.capabilities.items.find(
        (item) => item.id === "list_alerts"
      )?.availability
    ).toBe("unavailable");
  });

  it("reads only the bounded recent audit window before applying safe filters", async () => {
    const deps = createTestSliceADeps();
    const { audit } = deps.stores;
    const requestedLimits = new Array<number>();
    const recentEvents = Array.from({ length: 12 }, (_, index) => ({
      action: index === 0 ? "untrusted-action" : "markeer_aanvraag",
      actorId: index === 1 ? actorB : actorA,
      actorType: "agent" as const,
      auditClass: "effect" as const,
      createdAt: new Date(
        `2026-09-05T10:${String(59 - index).padStart(2, "0")}:00.000Z`
      ),
      entityId: `private-${index}`,
      entityType: "untrusted-entity-type",
      id: `audit-${index}`,
      metadata: { reden: null, status: "relevant" as const },
      scopeId: index === 2 ? "foreign-scope" : deps.scopeId,
    }));
    const bundle = createSliceARegistry({
      ...deps,
      stores: {
        ...deps.stores,
        audit: {
          append: audit.append.bind(audit),
          listByActorId: () => {
            throw new Error("unbounded audit read must not be used");
          },
          listRecentByActorId: (_actorId, _scopeId, limit) => {
            requestedLimits.push(limit);
            return Promise.resolve(recentEvents.slice(0, limit));
          },
        },
      },
    });

    const result = await invokeOperatorContext(bundle, actorA, {});

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(requestedLimits).toEqual([10]);
    expect(result.value.activity.items).toHaveLength(7);
    expect(result.value.activity.items[0]?.createdAt).toBe(
      "2026-09-05T10:56:00.000Z"
    );
    expect(result.value.freshness.activity).toEqual({
      observedAt: "2026-09-05T10:56:00.000Z",
      state: "present",
    });
    expect(
      result.value.activity.items.every(
        (event) =>
          event.action === "markeer_aanvraag" && event.entityType === "aanvraag"
      )
    ).toBe(true);
    expect(JSON.stringify(result.value.activity)).not.toContain("private-");
    expect(JSON.stringify(result.value.activity)).not.toContain("untrusted");
  });

  it("reports unsupported inventories as unknown and absent selections honestly", async () => {
    const deps = createTestSliceADeps();
    const emptyBundle = createSliceARegistry(deps);
    const empty = await invokeOperatorContext(emptyBundle, actorA, {});
    expect(empty.ok).toBe(true);
    if (!empty.ok) {
      throw new Error(empty.error.message);
    }
    expect(empty.value.resources).toEqual({
      inventory: { state: "unknown" },
      selected: {
        savedSearch: { state: "not_applicable" },
        snapshot: { state: "not_applicable" },
      },
    });
    expect(empty.value.preferences.state).toBe("unknown");
    expect(empty.value.freshness.activity.state).toBe("unknown");
    expect(empty.value.freshness.resourceInventory.state).toBe("unknown");
    expect(empty.value.selected.savedSearch.state).toBe("not_applicable");
    expect(empty.value.selected.snapshot.state).toBe("not_applicable");
    expect(
      empty.value.capabilities.items.every(
        (item) => item.availability === "unknown"
      )
    ).toBe(true);

    const unavailablePolicyBundle = createSliceARegistry({
      ...deps,
      capabilityAvailability: {
        unavailableCapabilityIds: () =>
          Promise.reject(new Error("availability policy unavailable")),
      },
    });
    const unavailablePolicy = await invokeOperatorContext(
      unavailablePolicyBundle,
      actorA,
      {}
    );
    expect(unavailablePolicy.ok).toBe(false);
    if (unavailablePolicy.ok) {
      throw new Error("Expected unavailable policy to fail closed");
    }
    expect(unavailablePolicy.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(unavailablePolicy.error)).not.toContain(
      "availability policy unavailable"
    );
  });
});
