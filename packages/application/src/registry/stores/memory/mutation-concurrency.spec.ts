import { describe, expect, it } from "bun:test";

import type { AuditEventRecord, AuditStore } from "../types";
import { MemoryAuditStore } from "./audit-store";
import { MemoryMarkeringStore } from "./markering-store";
import { MemorySavedSearchStore } from "./saved-search-store";

interface AuditGate {
  readonly fail: () => void;
  readonly pass: () => void;
}

interface GatedAuditHarness {
  readonly audit: AuditStore;
  readonly gates: AuditGate[];
}

const createGatedAudit = (): GatedAuditHarness => {
  const gates: AuditGate[] = [];
  const audit: AuditStore = {
    append(event) {
      const pending = Promise.withResolvers<AuditEventRecord>();
      gates.push({
        fail: () => {
          pending.reject(new Error("injected audit failure"));
        },
        pass: () => {
          void new MemoryAuditStore()
            .append(event)
            .then(pending.resolve, pending.reject);
        },
      });
      return pending.promise;
    },
    listByActorId() {
      return Promise.resolve([]);
    },
    listRecentByActorId() {
      return Promise.resolve([]);
    },
  };
  return { audit, gates };
};

const requireGate = (gates: readonly AuditGate[], index: number): AuditGate => {
  const gate = gates[index];
  if (!gate) {
    throw new Error(`expected audit gate at index ${index}`);
  }
  return gate;
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("memory store mutation recoverability (RJC-444 / RJC-462)", () => {
  it("marker clear→set both audits fail restores committed markering", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemoryMarkeringStore(audit);

    const seedPromise = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "seed",
        scopeId: "scope-1",
        status: "relevant",
        userId: "user-1",
      },
      "user"
    );
    expect(gates.length).toBe(1);
    requireGate(gates, 0).pass();
    await seedPromise;
    expect(await store.get("aanvraag-1", "user-1", "scope-1")).toMatchObject({
      reden: "seed",
      status: "relevant",
    });

    const clearPromise = store.clearWithAudit(
      "aanvraag-1",
      "user-1",
      "scope-1",
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);
    const setPromise = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "replacement",
        scopeId: "scope-1",
        status: "gevolgd",
        userId: "user-1",
      },
      "user"
    );
    // Per-key queue: successor waits until predecessor audit settles.
    await flush();
    expect(gates.length).toBe(2);

    requireGate(gates, 1).fail();
    await expect(clearPromise).rejects.toThrow("injected audit failure");
    await flush();
    expect(gates.length).toBe(3);
    requireGate(gates, 2).fail();
    await expect(setPromise).rejects.toThrow("injected audit failure");

    expect(await store.get("aanvraag-1", "user-1", "scope-1")).toMatchObject({
      reden: "seed",
      status: "relevant",
    });
  });

  it("marker predecessor succeeds and failing successor keeps predecessor (RJC-462)", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemoryMarkeringStore(audit);

    const seedPromise = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "seed",
        scopeId: "scope-1",
        status: "relevant",
        userId: "user-1",
      },
      "user"
    );
    requireGate(gates, 0).pass();
    await seedPromise;

    const predecessor = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "kept",
        scopeId: "scope-1",
        status: "gevolgd",
        userId: "user-1",
      },
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);
    const successor = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "lost-if-bug",
        scopeId: "scope-1",
        status: "niet_relevant",
        userId: "user-1",
      },
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);

    requireGate(gates, 1).pass();
    await predecessor;
    await flush();
    expect(gates.length).toBe(3);
    requireGate(gates, 2).fail();
    await expect(successor).rejects.toThrow("injected audit failure");

    expect(await store.get("aanvraag-1", "user-1", "scope-1")).toMatchObject({
      reden: "kept",
      status: "gevolgd",
    });
  });

  it("marker successful successor wins after predecessor audit", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemoryMarkeringStore(audit);

    const seedPromise = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "seed",
        scopeId: "scope-1",
        status: "relevant",
        userId: "user-1",
      },
      "user"
    );
    requireGate(gates, 0).pass();
    await seedPromise;

    const predecessor = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "first",
        scopeId: "scope-1",
        status: "gevolgd",
        userId: "user-1",
      },
      "user"
    );
    await flush();
    const successor = store.setWithAudit(
      {
        aanvraagId: "aanvraag-1",
        reden: "second",
        scopeId: "scope-1",
        status: "niet_relevant",
        userId: "user-1",
      },
      "user"
    );
    await flush();
    requireGate(gates, 1).pass();
    await predecessor;
    await flush();
    requireGate(gates, 2).pass();
    await successor;

    expect(await store.get("aanvraag-1", "user-1", "scope-1")).toMatchObject({
      reden: "second",
      status: "niet_relevant",
    });
  });

  it("marker independent keys stay concurrent", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemoryMarkeringStore(audit);

    const a = store.setWithAudit(
      {
        aanvraagId: "aanvraag-a",
        reden: "a",
        scopeId: "scope-1",
        status: "relevant",
        userId: "user-1",
      },
      "user"
    );
    const b = store.setWithAudit(
      {
        aanvraagId: "aanvraag-b",
        reden: "b",
        scopeId: "scope-1",
        status: "gevolgd",
        userId: "user-1",
      },
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);
    requireGate(gates, 0).pass();
    requireGate(gates, 1).pass();
    await Promise.all([a, b]);
    expect(await store.get("aanvraag-a", "user-1", "scope-1")).toMatchObject({
      reden: "a",
    });
    expect(await store.get("aanvraag-b", "user-1", "scope-1")).toMatchObject({
      reden: "b",
    });
  });

  it("saved-search update→update both fail restores committed record", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemorySavedSearchStore(audit);
    const createPromise = store.createWithAudit(
      {
        deletedAt: null,
        filters: {},
        naam: "seed",
        parserVersion: "1",
        queryText: "Azure",
        schemaVersion: "1",
        scopeId: "scope-1",
        userId: "user-1",
      },
      "user"
    );
    requireGate(gates, 0).pass();
    const { savedSearch } = await createPromise;
    const { id } = savedSearch;

    const firstUpdate = store.updateWithAudit(
      id,
      "user-1",
      "scope-1",
      {
        filters: {},
        naam: "first",
        parserVersion: "1",
        queryText: "Azure AND first",
        schemaVersion: "1",
      },
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);
    const secondUpdate = store.updateWithAudit(
      id,
      "user-1",
      "scope-1",
      {
        filters: {},
        naam: "second",
        parserVersion: "1",
        queryText: "Azure AND second",
        schemaVersion: "1",
      },
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);

    requireGate(gates, 1).fail();
    await expect(firstUpdate).rejects.toThrow("injected audit failure");
    await flush();
    expect(gates.length).toBe(3);
    requireGate(gates, 2).fail();
    await expect(secondUpdate).rejects.toThrow("injected audit failure");

    expect(await store.getById(id, "user-1", "scope-1")).toMatchObject({
      naam: "seed",
      queryText: "Azure",
    });
  });

  it("saved-search update→remove both fail restores committed record", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemorySavedSearchStore(audit);
    const createPromise = store.createWithAudit(
      {
        deletedAt: null,
        filters: {},
        naam: "seed",
        parserVersion: "1",
        queryText: "Azure",
        schemaVersion: "1",
        scopeId: "scope-1",
        userId: "user-1",
      },
      "user"
    );
    requireGate(gates, 0).pass();
    const { savedSearch } = await createPromise;
    const { id } = savedSearch;

    const updatePromise = store.updateWithAudit(
      id,
      "user-1",
      "scope-1",
      {
        filters: {},
        naam: "updated",
        parserVersion: "1",
        queryText: "Azure AND updated",
        schemaVersion: "1",
      },
      "user"
    );
    await flush();
    const removePromise = store.removeWithAudit(
      id,
      "user-1",
      "scope-1",
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);

    requireGate(gates, 1).fail();
    await expect(updatePromise).rejects.toThrow("injected audit failure");
    await flush();
    expect(gates.length).toBe(3);
    requireGate(gates, 2).fail();
    await expect(removePromise).rejects.toThrow("injected audit failure");

    expect(await store.getById(id, "user-1", "scope-1")).toMatchObject({
      naam: "seed",
      queryText: "Azure",
    });
  });

  it("saved-search predecessor succeeds and failing successor keeps predecessor (RJC-462)", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemorySavedSearchStore(audit);
    const createPromise = store.createWithAudit(
      {
        deletedAt: null,
        filters: {},
        naam: "seed",
        parserVersion: "1",
        queryText: "Azure",
        schemaVersion: "1",
        scopeId: "scope-1",
        userId: "user-1",
      },
      "user"
    );
    requireGate(gates, 0).pass();
    const { savedSearch } = await createPromise;
    const { id } = savedSearch;

    const predecessor = store.updateWithAudit(
      id,
      "user-1",
      "scope-1",
      {
        filters: {},
        naam: "kept",
        parserVersion: "1",
        queryText: "Azure AND kept",
        schemaVersion: "1",
      },
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);
    const successor = store.updateWithAudit(
      id,
      "user-1",
      "scope-1",
      {
        filters: {},
        naam: "lost-if-bug",
        parserVersion: "1",
        queryText: "Azure AND lost",
        schemaVersion: "1",
      },
      "user"
    );
    await flush();
    expect(gates.length).toBe(2);

    requireGate(gates, 1).pass();
    await predecessor;
    await flush();
    expect(gates.length).toBe(3);
    requireGate(gates, 2).fail();
    await expect(successor).rejects.toThrow("injected audit failure");

    expect(await store.getById(id, "user-1", "scope-1")).toMatchObject({
      naam: "kept",
      queryText: "Azure AND kept",
    });
  });

  it("saved-search successful successor wins after predecessor audit", async () => {
    const { audit, gates } = createGatedAudit();
    const store = new MemorySavedSearchStore(audit);
    const createPromise = store.createWithAudit(
      {
        deletedAt: null,
        filters: {},
        naam: "seed",
        parserVersion: "1",
        queryText: "Azure",
        schemaVersion: "1",
        scopeId: "scope-1",
        userId: "user-1",
      },
      "user"
    );
    requireGate(gates, 0).pass();
    const { savedSearch } = await createPromise;
    const { id } = savedSearch;

    const predecessor = store.updateWithAudit(
      id,
      "user-1",
      "scope-1",
      {
        filters: {},
        naam: "first",
        parserVersion: "1",
        queryText: "Azure AND first",
        schemaVersion: "1",
      },
      "user"
    );
    await flush();
    const successor = store.updateWithAudit(
      id,
      "user-1",
      "scope-1",
      {
        filters: {},
        naam: "second",
        parserVersion: "1",
        queryText: "Azure AND second",
        schemaVersion: "1",
      },
      "user"
    );
    await flush();
    requireGate(gates, 1).pass();
    await predecessor;
    await flush();
    requireGate(gates, 2).pass();
    await successor;

    expect(await store.getById(id, "user-1", "scope-1")).toMatchObject({
      naam: "second",
      queryText: "Azure AND second",
    });
  });
});
