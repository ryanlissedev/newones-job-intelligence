import { describe, expect, it } from "bun:test";

import { createMemorySliceAStores } from "../registry/stores/memory";
import { commitExport } from "./commit-export";
import { buildExportIdempotencyKey } from "./idempotency";
import { SpottApiError, createSpottWriteClient } from "./spott/client";
import type { SpottWriteClient } from "./spott/client";

const scopeId = "catapulze-test";

const seedAanvraag = (
  stores: ReturnType<typeof createMemorySliceAStores>,
  id: string,
  titel: string
) => {
  stores.aanvragen.seed({
    beschrijving: `${titel} beschrijving`,
    bronId: "00000000-0000-4000-8000-000000000001",
    bronReferentie: `TN-${id.slice(-4)}`,
    id,
    rawPayloadRef: `raw/${id}.json`,
    scrapeRunId: "00000000-0000-4000-8000-000000000020",
    status: "active",
    titel,
    versies: [],
  });
};

const seedApprovedSnapshot = async (
  stores: ReturnType<typeof createMemorySliceAStores>,
  aanvraagIds: readonly string[]
) => {
  const snapshot = await stores.snapshots.create({
    filters: {},
    indexVersion: 1,
    parserVersion: "1",
    queryText: "Azure",
    resultIds: [...aanvraagIds],
    savedSearchId: null,
    schemaVersion: "slice-a-v1",
    scope: "active",
    scopeId,
    searchVersion: { appliedSequence: 1n, generation: 1 },
    userId: "recruiter-1",
  });

  const written = await stores.approvals.createWithAudit(
    {
      actorId: "approver-1",
      expiresAt: new Date("2027-12-31T00:00:00.000Z"),
      motivatie: "Gecontroleerd",
      resultIds: [...snapshot.resultIds],
      scopeId,
      snapshotId: snapshot.id,
    },
    "user"
  );
  if (!written.ok) {
    throw new Error("Expected approval seed to succeed");
  }

  return { approval: written.approval, snapshot };
};

describe("buildExportIdempotencyKey", () => {
  it("combines target, canonical vacancy id and action type", () => {
    expect(
      buildExportIdempotencyKey(
        "spott",
        "00000000-0000-4000-8000-000000000001",
        "create"
      )
    ).toBe("spott:00000000-0000-4000-8000-000000000001:create");
  });
});

describe("commitExport", () => {
  it("derives a consistent created attempt during memory finalization", async () => {
    const stores = createMemorySliceAStores();
    const key = {
      actionType: "create",
      canonicalVacancyId: "00000000-0000-4000-8000-000000000021",
      scopeId,
      target: "spott",
    } as const;
    const externalId = "memory-finalization-id";
    await stores.exportEffects.reserve(key);
    await stores.exportEffects.recordExternalId({
      ...key,
      externalId,
      source: "provider_response",
    });

    const result = await stores.exportEffects.finalizeConfirmed({
      ...key,
      approvalId: "memory-approval-id",
      externalId,
      idempotencyKey: "memory-idempotency-key",
      responseHash: "memory-response-hash",
      snapshotId: "memory-snapshot-id",
    });

    expect(result.created).toBe(true);
    if (!result.created) {
      return;
    }
    expect(result.attempt).toMatchObject({
      ...key,
      approvalId: "memory-approval-id",
      errorMessage: null,
      externalId,
      idempotencyKey: "memory-idempotency-key",
      snapshotId: "memory-snapshot-id",
      status: "created",
    });
    expect(result.receipt).toMatchObject({
      canonicalVacancyId: key.canonicalVacancyId,
      confirmedEffect: true,
      exportAttemptId: result.attempt.id,
      responseHash: "memory-response-hash",
      scopeId,
      spottVacancyId: externalId,
    });
  });

  it("rejects a blank response hash before memory finalization writes", async () => {
    const stores = createMemorySliceAStores();
    const key = {
      actionType: "create",
      canonicalVacancyId: "00000000-0000-4000-8000-000000000022",
      scopeId,
      target: "spott",
    } as const;
    const externalId = "memory-blank-hash-id";
    await stores.exportEffects.reserve(key);
    await stores.exportEffects.recordExternalId({
      ...key,
      externalId,
      source: "provider_response",
    });

    await expect(
      stores.exportEffects.finalizeConfirmed({
        ...key,
        approvalId: "memory-approval-id",
        externalId,
        idempotencyKey: "memory-idempotency-key",
        responseHash: " ",
        snapshotId: "memory-snapshot-id",
      })
    ).rejects.toThrow("response hash must not be empty");

    expect(await stores.externalCrosswalk.get(key)).toBeNull();
    expect(stores.exportAttempts.list()).toHaveLength(0);
    expect(stores.externalReceipts.list()).toHaveLength(0);
    const existingReservation = await stores.exportEffects.reserve(key);
    expect(existingReservation.effect.status).toBe("external_id_acquired");
  });

  it("validates direct memory receipt hashes without normalizing them", async () => {
    const stores = createMemorySliceAStores();
    const receiptInput = {
      canonicalVacancyId: "00000000-0000-4000-8000-000000000023",
      confirmedEffect: true,
      exportAttemptId: "memory-attempt-id",
      scopeId,
      spottVacancyId: "memory-receipt-id",
    } as const;

    let blankHashError: unknown;
    try {
      await stores.externalReceipts.create({
        ...receiptInput,
        responseHash: " ",
      });
    } catch (error) {
      blankHashError = error;
    }
    expect(blankHashError).toBeInstanceOf(Error);
    expect(stores.externalReceipts.list()).toHaveLength(0);

    const receipt = await stores.externalReceipts.create({
      ...receiptInput,
      responseHash: " preserved-response-hash ",
    });
    expect(receipt.responseHash).toBe(" preserved-response-hash ");
  });

  it("creates each approved aanvraag once in fixture mode with confirmed receipts", async () => {
    const stores = createMemorySliceAStores();
    const spottWriteClient = createSpottWriteClient({ liveEnabled: false });
    const aanvraagIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ] as const;

    for (const [index, id] of aanvraagIds.entries()) {
      seedAanvraag(stores, id, `Azure engineer ${index}`);
    }

    const { approval, snapshot } = await seedApprovedSnapshot(stores, [
      ...aanvraagIds,
    ]);

    const result = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient, stores }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.summary).toEqual({ created: 2, failed: 0, skipped: 0 });
    expect(result.value.approvalId).toBe(approval.id);
    expect(
      result.value.results.every((item) => item.status === "created")
    ).toBe(true);
    expect(stores.exportAttempts.list()).toHaveLength(2);
    expect(stores.externalReceipts.list()).toHaveLength(2);

    await Promise.all(
      result.value.results.map(async (item) => {
        const attempt = stores.exportAttempts
          .list()
          .find(
            (entry) => entry.canonicalVacancyId === item.canonicalVacancyId
          );
        expect(attempt).toBeDefined();
        if (!attempt) {
          return;
        }

        const receipt = await stores.externalReceipts.getByExportAttemptId(
          attempt.id,
          scopeId
        );
        expect(receipt).toMatchObject({
          canonicalVacancyId: item.canonicalVacancyId,
          confirmedEffect: true,
          exportAttemptId: attempt.id,
          spottVacancyId: item.externalId,
        });
        expect(receipt?.responseHash).toMatch(/^[a-f0-9]{64}$/u);
        expect(receipt).toBeDefined();
        if (!receipt) {
          return;
        }
        expect(item.receiptId).toBe(receipt.id);
      })
    );
  });

  it("skips create on replay using the crosswalk and writes a skip receipt", async () => {
    const stores = createMemorySliceAStores();
    const spottWriteClient = createSpottWriteClient({ liveEnabled: false });
    const aanvraagId = "00000000-0000-4000-8000-000000000003";
    seedAanvraag(stores, aanvraagId, "Replay test");

    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);

    let createCalls = 0;
    const trackedClient: SpottWriteClient = {
      ...spottWriteClient,
      createVacancy: (input) => {
        createCalls += 1;
        return spottWriteClient.createVacancy(input);
      },
    };

    const first = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: trackedClient, stores }
    );
    const second = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: trackedClient, stores }
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(createCalls).toBe(1);
    expect(first.value.summary).toEqual({ created: 1, failed: 0, skipped: 0 });
    expect(second.value.summary).toEqual({ created: 0, failed: 0, skipped: 1 });
    expect(second.value.results[0]?.status).toBe("skipped");
    expect(stores.exportAttempts.list()).toHaveLength(2);
    expect(stores.externalReceipts.list()).toHaveLength(2);

    const firstExternalId = first.value.results[0]?.externalId;
    expect(second.value.results[0]?.externalId).toBe(firstExternalId);

    const skipReceipt = stores.externalReceipts
      .list()
      .find(
        (entry) =>
          entry.confirmedEffect && entry.spottVacancyId === firstExternalId
      );
    expect(skipReceipt).toBeDefined();
    expect(
      await stores.externalReceipts.listByCanonicalVacancyId(
        aanvraagId,
        scopeId
      )
    ).toHaveLength(2);
  });

  it("retries confirmation with the durable ID without another POST", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000006";
    seedAanvraag(stores, aanvraagId, "Unconfirmed create");

    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);

    let createCalls = 0;
    let confirmationCalls = 0;
    const unconfirmedClient: SpottWriteClient = {
      createVacancy: () => {
        createCalls += 1;
        return Promise.resolve({ id: "orphan-spott-id" });
      },
      getVacancy: () => {
        confirmationCalls += 1;
        if (confirmationCalls === 1) {
          return Promise.reject(
            new SpottApiError("Vacancy not found: orphan-spott-id", 404)
          );
        }
        return Promise.resolve({
          companyId: "company-fixture",
          description: "Recovered",
          id: "orphan-spott-id",
          name: "Recovered vacancy",
          restricted: false,
          stageId: "stage-fixture",
        });
      },
      listVacancies: () =>
        Promise.resolve({
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
    };

    const result = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: unconfirmedClient, stores }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.summary).toEqual({ created: 0, failed: 1, skipped: 0 });
    expect(result.value.results[0]?.status).toBe("failed");
    expect(
      await stores.externalCrosswalk.get({
        actionType: "create",
        canonicalVacancyId: aanvraagId,
        scopeId,
        target: "spott",
      })
    ).toBeNull();

    const [attempt] = stores.exportAttempts.list();
    expect(attempt?.status).toBe("failed");
    const receipt = attempt
      ? await stores.externalReceipts.getByExportAttemptId(attempt.id, scopeId)
      : null;
    expect(receipt).toMatchObject({
      canonicalVacancyId: aanvraagId,
      confirmedEffect: false,
      spottVacancyId: "orphan-spott-id",
    });
    expect(receipt?.responseHash).toMatch(/^[a-f0-9]{64}$/u);

    const retry = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: unconfirmedClient, stores }
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) {
      return;
    }
    expect(retry.value.summary).toEqual({ created: 1, failed: 0, skipped: 0 });
    expect(createCalls).toBe(1);
    expect(confirmationCalls).toBe(2);
    expect(
      await stores.externalCrosswalk.get({
        actionType: "create",
        canonicalVacancyId: aanvraagId,
        scopeId,
        target: "spott",
      })
    ).toMatchObject({ externalId: "orphan-spott-id" });
  });

  it("allows only one concurrent caller to start the provider create", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000008";
    seedAanvraag(stores, aanvraagId, "Concurrent create");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);

    const createStarted = Promise.withResolvers<boolean>();
    const createResponse = Promise.withResolvers<{ readonly id: string }>();
    let createCalls = 0;
    const client: SpottWriteClient = {
      createVacancy: () => {
        createCalls += 1;
        createStarted.resolve(true);
        return createResponse.promise;
      },
      getVacancy: (id) =>
        Promise.resolve({
          companyId: "company-fixture",
          description: "Concurrent",
          id,
          name: "Concurrent vacancy",
          restricted: false,
          stageId: "stage-fixture",
        }),
      listVacancies: () =>
        Promise.resolve({
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
    };

    const firstPromise = commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    await createStarted.promise;
    const second = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    createResponse.resolve({ id: "concurrent-spott-id" });
    const first = await firstPromise;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(createCalls).toBe(1);
    if (first.ok && second.ok) {
      expect(first.value.summary.created).toBe(1);
      expect(second.value.summary.failed).toBe(1);
      expect(second.value.results[0]?.externalId).toBeNull();
    }
    const blockedAttempt = stores.exportAttempts
      .list()
      .find((attempt) => attempt.status === "failed");
    expect(blockedAttempt?.errorMessage).toContain("pending or uncertain");
    const blockedReceipt = blockedAttempt
      ? await stores.externalReceipts.getByExportAttemptId(
          blockedAttempt.id,
          scopeId
        )
      : null;
    expect(blockedReceipt).toMatchObject({
      confirmedEffect: false,
      spottVacancyId: null,
    });
  });

  it("serializes three concurrent GET-only finalizations", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000014";
    seedAanvraag(stores, aanvraagId, "Concurrent reconciliation");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    const effectKey = {
      actionType: "create",
      canonicalVacancyId: aanvraagId,
      scopeId,
      target: "spott",
    } as const;
    await stores.exportEffects.reserve(effectKey);
    await stores.exportEffects.recordExternalId({
      ...effectKey,
      externalId: "concurrent-reconciliation-id",
      source: "manual_evidence",
    });

    const confirmations: (() => void)[] = [];
    let getCalls = 0;
    const allConfirmationsStarted = Promise.withResolvers<boolean>();
    const client: SpottWriteClient = {
      createVacancy: () =>
        Promise.reject(
          new Error("POST must not be called during reconciliation")
        ),
      getVacancy: (id) => {
        getCalls += 1;
        if (getCalls === 3) {
          allConfirmationsStarted.resolve(true);
        }
        const confirmation =
          Promise.withResolvers<
            Awaited<ReturnType<SpottWriteClient["getVacancy"]>>
          >();
        confirmations.push(() =>
          confirmation.resolve({
            companyId: "company-fixture",
            description: "Concurrent reconciliation",
            id,
            name: "Concurrent reconciliation",
            restricted: false,
            stageId: "stage-fixture",
          })
        );
        return confirmation.promise;
      },
      listVacancies: () =>
        Promise.resolve({
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
    };
    const calls = [1, 2, 3].map(() =>
      commitExport(
        { snapshotId: snapshot.id },
        { scopeId, spottWriteClient: client, stores }
      )
    );
    await allConfirmationsStarted.promise;
    for (const confirm of confirmations) {
      confirm();
    }
    const results = await Promise.all(calls);

    expect(getCalls).toBe(3);
    expect(results.every((result) => result.ok)).toBe(true);
    const statuses = results.flatMap((result) =>
      result.ok ? result.value.results.map((item) => item.status) : []
    );
    expect(statuses.filter((status) => status === "created")).toHaveLength(1);
    expect(statuses.filter((status) => status === "skipped")).toHaveLength(2);
    expect(stores.exportAttempts.list()).toHaveLength(3);
    expect(stores.externalReceipts.list()).toHaveLength(3);
  });

  it("keeps reservations isolated by deployment scope", async () => {
    const stores = createMemorySliceAStores();
    const shared = {
      actionType: "create",
      canonicalVacancyId: "00000000-0000-4000-8000-000000000015",
      target: "spott",
    } as const;
    const [scopeA, scopeB] = await Promise.all([
      stores.exportEffects.reserve({ ...shared, scopeId: "scope:a" }),
      stores.exportEffects.reserve({ ...shared, scopeId: "scope" }),
    ]);

    expect(scopeA.acquired).toBe(true);
    expect(scopeB.acquired).toBe(true);
    const repeatedScopeA = await stores.exportEffects.reserve({
      ...shared,
      scopeId: "scope:a",
    });
    expect(repeatedScopeA.acquired).toBe(false);
  });

  it("keeps a no-ID reservation blocked until explicit manual evidence is attached", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000009";
    seedAanvraag(stores, aanvraagId, "Manual reconciliation");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    const effectKey = {
      actionType: "create",
      canonicalVacancyId: aanvraagId,
      scopeId,
      target: "spott",
    } as const;
    await stores.exportEffects.reserve(effectKey);

    let createCalls = 0;
    const client: SpottWriteClient = {
      createVacancy: () => {
        createCalls += 1;
        return Promise.resolve({ id: "must-not-be-created" });
      },
      getVacancy: (id) =>
        Promise.resolve({
          companyId: "company-fixture",
          description: "Manually reconciled",
          id,
          name: "Manually reconciled vacancy",
          restricted: false,
          stageId: "stage-fixture",
        }),
      listVacancies: () =>
        Promise.resolve({
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
    };

    const blocked = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(blocked.value.summary.failed).toBe(1);
    }
    expect(createCalls).toBe(0);

    await stores.exportEffects.recordExternalId({
      ...effectKey,
      externalId: "manually-proven-spott-id",
      source: "manual_evidence",
    });
    const reconciled = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) {
      expect(reconciled.value.summary.created).toBe(1);
      expect(reconciled.value.results[0]?.externalId).toBe(
        "manually-proven-spott-id"
      );
    }
    expect(createCalls).toBe(0);
  });

  it("does not POST again after crashing immediately after durable ID persistence", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000010";
    seedAanvraag(stores, aanvraagId, "ID persistence crash");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    let createCalls = 0;
    let getCalls = 0;
    const client: SpottWriteClient = {
      createVacancy: () => {
        createCalls += 1;
        return Promise.resolve({ id: "persisted-before-crash" });
      },
      getVacancy: (id) => {
        getCalls += 1;
        return Promise.resolve({
          companyId: "company-fixture",
          description: "Recovered",
          id,
          name: "Recovered vacancy",
          restricted: false,
          stageId: "stage-fixture",
        });
      },
      listVacancies: () =>
        Promise.resolve({
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
    };
    let crash = true;
    const crashingStores = {
      ...stores,
      exportEffects: {
        finalizeConfirmed: stores.exportEffects.finalizeConfirmed.bind(
          stores.exportEffects
        ),
        recordExternalId: async (
          input: Parameters<typeof stores.exportEffects.recordExternalId>[0]
        ) => {
          const effect = await stores.exportEffects.recordExternalId(input);
          if (crash) {
            crash = false;
            throw new Error("simulated crash after ID persistence");
          }
          return effect;
        },
        reserve: stores.exportEffects.reserve.bind(stores.exportEffects),
      },
    };

    await expect(
      commitExport(
        { snapshotId: snapshot.id },
        { scopeId, spottWriteClient: client, stores: crashingStores }
      )
    ).rejects.toThrow("simulated crash after ID persistence");
    const retry = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(retry.ok).toBe(true);
    expect(createCalls).toBe(1);
    expect(getCalls).toBe(1);
  });

  it("blocks retry when persistence fails after POST but before storing the external ID", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000017";
    seedAanvraag(stores, aanvraagId, "Pre-ID persistence crash");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    let createCalls = 0;
    let getCalls = 0;
    const fixture = createSpottWriteClient({ liveEnabled: false });
    const client: SpottWriteClient = {
      ...fixture,
      createVacancy: (input) => {
        createCalls += 1;
        return fixture.createVacancy(input);
      },
      getVacancy: (id) => {
        getCalls += 1;
        return fixture.getVacancy(id);
      },
    };
    const crashingStores = {
      ...stores,
      exportEffects: {
        finalizeConfirmed: stores.exportEffects.finalizeConfirmed.bind(
          stores.exportEffects
        ),
        recordExternalId: () =>
          Promise.reject(new Error("external ID persistence failed")),
        reserve: stores.exportEffects.reserve.bind(stores.exportEffects),
      },
    };

    await expect(
      commitExport(
        { snapshotId: snapshot.id },
        { scopeId, spottWriteClient: client, stores: crashingStores }
      )
    ).rejects.toThrow("external ID persistence failed");
    const retry = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.summary.failed).toBe(1);
      expect(retry.value.results[0]?.externalId).toBeNull();
    }
    expect(createCalls).toBe(1);
    expect(getCalls).toBe(0);
  });

  it("retries GET-only reconciliation after finalization persistence fails", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000018";
    seedAanvraag(stores, aanvraagId, "Finalization persistence failure");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    const fixture = createSpottWriteClient({ liveEnabled: false });
    let createCalls = 0;
    let getCalls = 0;
    const client: SpottWriteClient = {
      ...fixture,
      createVacancy: (input) => {
        createCalls += 1;
        return fixture.createVacancy(input);
      },
      getVacancy: (id) => {
        getCalls += 1;
        return fixture.getVacancy(id);
      },
    };
    const failingStores = {
      ...stores,
      exportEffects: {
        finalizeConfirmed: () =>
          Promise.reject(new Error("finalization database down")),
        recordExternalId: stores.exportEffects.recordExternalId.bind(
          stores.exportEffects
        ),
        reserve: stores.exportEffects.reserve.bind(stores.exportEffects),
      },
    };

    await expect(
      commitExport(
        { snapshotId: snapshot.id },
        { scopeId, spottWriteClient: client, stores: failingStores }
      )
    ).rejects.toThrow("finalization database down");
    const retry = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.summary.created).toBe(1);
    }
    expect(createCalls).toBe(1);
    expect(getCalls).toBe(2);
  });

  it("does not POST again when the caller crashes after atomic finalization", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000011";
    seedAanvraag(stores, aanvraagId, "Finalization crash");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    const fixture = createSpottWriteClient({ liveEnabled: false });
    let createCalls = 0;
    const client: SpottWriteClient = {
      ...fixture,
      createVacancy: (input) => {
        createCalls += 1;
        return fixture.createVacancy(input);
      },
    };
    let crash = true;
    const crashingStores = {
      ...stores,
      exportEffects: {
        finalizeConfirmed: async (
          input: Parameters<typeof stores.exportEffects.finalizeConfirmed>[0]
        ) => {
          const result = await stores.exportEffects.finalizeConfirmed(input);
          if (crash) {
            crash = false;
            throw new Error("simulated crash after finalization");
          }
          return result;
        },
        recordExternalId: stores.exportEffects.recordExternalId.bind(
          stores.exportEffects
        ),
        reserve: stores.exportEffects.reserve.bind(stores.exportEffects),
      },
    };

    await expect(
      commitExport(
        { snapshotId: snapshot.id },
        { scopeId, spottWriteClient: client, stores: crashingStores }
      )
    ).rejects.toThrow("simulated crash after finalization");
    const retry = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.summary.skipped).toBe(1);
    }
    expect(createCalls).toBe(1);
    expect(stores.exportAttempts.list().map((item) => item.status)).toEqual([
      "created",
      "skipped",
    ]);
  });

  it("keeps a reservation blocked after an HTTP create error", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000012";
    seedAanvraag(stores, aanvraagId, "HTTP failure");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    let createCalls = 0;
    const client: SpottWriteClient = {
      createVacancy: () => {
        createCalls += 1;
        return Promise.reject(
          new SpottApiError("network outcome unknown", 503)
        );
      },
      getVacancy: () => Promise.reject(new Error("GET must not be called")),
      listVacancies: () =>
        Promise.resolve({
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
    };

    const first = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    const retry = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(createCalls).toBe(1);
    if (retry.ok) {
      expect(retry.value.summary.failed).toBe(1);
    }
  });

  it("blocks a malformed successful response without an external ID", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000016";
    seedAanvraag(stores, aanvraagId, "Malformed response");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    let createCalls = 0;
    const client: SpottWriteClient = {
      createVacancy: () => {
        createCalls += 1;
        return Promise.resolve({ id: "   " });
      },
      getVacancy: () => Promise.reject(new Error("GET must not be called")),
      listVacancies: () =>
        Promise.resolve({
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
    };

    const first = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    const retry = await commitExport(
      { snapshotId: snapshot.id },
      { scopeId, spottWriteClient: client, stores }
    );
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(createCalls).toBe(1);
    if (first.ok && retry.ok) {
      expect(first.value.summary.failed).toBe(1);
      expect(retry.value.summary.failed).toBe(1);
    }
  });

  it("fails before POST when durable reservation persistence fails", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000013";
    seedAanvraag(stores, aanvraagId, "Reservation DB failure");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    let createCalls = 0;
    const fixture = createSpottWriteClient({ liveEnabled: false });
    const client: SpottWriteClient = {
      ...fixture,
      createVacancy: (input) => {
        createCalls += 1;
        return fixture.createVacancy(input);
      },
    };
    const failingStores = {
      ...stores,
      exportEffects: {
        finalizeConfirmed: stores.exportEffects.finalizeConfirmed.bind(
          stores.exportEffects
        ),
        recordExternalId: stores.exportEffects.recordExternalId.bind(
          stores.exportEffects
        ),
        reserve: () => Promise.reject(new Error("reservation database down")),
      },
    };

    await expect(
      commitExport(
        { snapshotId: snapshot.id },
        { scopeId, spottWriteClient: client, stores: failingStores }
      )
    ).rejects.toThrow("reservation database down");
    expect(createCalls).toBe(0);
  });

  it("refuses export without approval", async () => {
    const stores = createMemorySliceAStores();
    const snapshot = await stores.snapshots.create({
      filters: {},
      indexVersion: 1,
      parserVersion: "1",
      queryText: "Azure",
      resultIds: ["00000000-0000-4000-8000-000000000004"],
      savedSearchId: null,
      schemaVersion: "slice-a-v1",
      scope: "active",
      scopeId,
      searchVersion: { appliedSequence: 1n, generation: 1 },
      userId: "recruiter-1",
    });

    const result = await commitExport(
      { snapshotId: snapshot.id },
      {
        scopeId,
        spottWriteClient: createSpottWriteClient({ liveEnabled: false }),
        stores,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("APPROVAL_NOT_FOUND");
  });

  it("refuses export when approval expired", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000005";
    seedAanvraag(stores, aanvraagId, "Expired approval");

    const snapshot = await stores.snapshots.create({
      filters: {},
      indexVersion: 1,
      parserVersion: "1",
      queryText: "Azure",
      resultIds: [aanvraagId],
      savedSearchId: null,
      schemaVersion: "slice-a-v1",
      scope: "active",
      scopeId,
      searchVersion: { appliedSequence: 1n, generation: 1 },
      userId: "recruiter-1",
    });

    await stores.approvals.createWithAudit(
      {
        actorId: "approver-1",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        motivatie: "Verlopen",
        resultIds: [...snapshot.resultIds],
        scopeId,
        snapshotId: snapshot.id,
      },
      "user"
    );

    const effectKey = {
      actionType: "create",
      canonicalVacancyId: aanvraagId,
      scopeId,
      target: "spott",
    } as const;
    await stores.exportEffects.reserve(effectKey);
    await stores.exportEffects.recordExternalId({
      ...effectKey,
      externalId: "expired-approval-external-id",
      source: "manual_evidence",
    });
    let getCalls = 0;
    const fixtureClient = createSpottWriteClient({ liveEnabled: false });
    const trackedClient: SpottWriteClient = {
      ...fixtureClient,
      getVacancy: (id) => {
        getCalls += 1;
        return fixtureClient.getVacancy(id);
      },
    };

    const result = await commitExport(
      { snapshotId: snapshot.id },
      {
        scopeId,
        spottWriteClient: trackedClient,
        stores,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("APPROVAL_EXPIRED");
    expect(getCalls).toBe(0);
  });

  it("returns NOT_FOUND without effects for a snapshot from another deployment scope", async () => {
    const stores = createMemorySliceAStores();
    const aanvraagId = "00000000-0000-4000-8000-000000000007";
    seedAanvraag(stores, aanvraagId, "Cross-scope export");
    const { snapshot } = await seedApprovedSnapshot(stores, [aanvraagId]);
    let createCalls = 0;
    const fixtureClient = createSpottWriteClient({ liveEnabled: false });
    const trackedClient: SpottWriteClient = {
      ...fixtureClient,
      createVacancy: (input) => {
        createCalls += 1;
        return fixtureClient.createVacancy(input);
      },
    };

    const result = await commitExport(
      { snapshotId: snapshot.id },
      {
        scopeId: "other-deployment",
        spottWriteClient: trackedClient,
        stores,
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    expect(createCalls).toBe(0);
    expect(stores.exportAttempts.list()).toHaveLength(0);
    expect(stores.externalReceipts.list()).toHaveLength(0);
  });
});
