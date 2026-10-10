import { describe, expect, it } from "bun:test";

import {
  InMemoryObservationRecorder,
  InMemoryObjectStore,
  InMemoryRunLifecycleStore,
  sleep,
} from "@ji/connectors";

import { executeBronRun as execute } from "./execute";
import * as bronnenApi from "./index";
import {
  activateBron,
  createBron,
  isPollableBron,
  listPublicBronnen,
  mapPublicBronnen,
  validateSecretRef,
} from "./register";
import type { BronPersistence, BronRegisterRecord } from "./register";

const tendernedBron = () => ({
  categorie: "overheidsportaal",
  crawlDelayMs: 1000,
  interval: "*/15 * * * *",
  loginVereist: false,
  mappingRef: "fixtures/connectors/tenderned/mapping.json",
  method: "json-api" as const,
  naam: "TenderNed",
  rateLimitPerMinute: 30,
  retentionDays: 90,
  secretRef: null,
  status: "deferred" as const,
  voorwaardenStatus: "toegestaan" as const,
});

const persistenceFor = (
  record: BronRegisterRecord | null
): BronPersistence => ({
  activate: () => Promise.reject(new Error("activation is not used")),
  create: (createdRecord) => Promise.resolve(createdRecord),
  findById: () => Promise.resolve(record),
  list: () => Promise.resolve(record ? [record] : []),
});

describe("bron register", () => {
  it("creates a deferred bron without scheduling polls", () => {
    const created = createBron(tendernedBron());
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(isPollableBron(created.record)).toBe(false);
  });

  it("always creates an inactive bron, even when runtime input requests activation", () => {
    const runtimeInput = {
      ...tendernedBron(),
      actief: true,
    };
    const created = createBron(runtimeInput);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(created.record.actief).toBe(false);
  });

  it("lists persisted bronnen without exposing secret values", async () => {
    const lastRun = {
      changed: 2,
      closed: 1,
      error: 0,
      failure: null,
      found: 24,
      geindigd: new Date("2026-08-29T10:01:00Z"),
      gestart: new Date("2026-08-29T10:00:00Z"),
      new: 3,
      rejected: 0,
      scrapeRunId: "run-latest",
      status: "succeeded",
    };
    const record: BronRegisterRecord = {
      ...tendernedBron(),
      actief: false,
      bronId: "bron-1",
      lastRun,
      secretRef: "trigger://tenderned/api-key",
      status: "deferred",
    };
    let listCalls = 0;
    const persistence: BronPersistence = {
      ...persistenceFor(record),
      list: () => {
        listCalls += 1;
        return Promise.resolve([record]);
      },
    };

    const [view] = await listPublicBronnen(persistence);
    expect(listCalls).toBe(1);
    expect(view?.hasSecretRef).toBe(true);
    expect(view?.status).toBe("deferred");
    expect(view?.lastRun).toEqual(lastRun);
    expect(JSON.stringify(view)).not.toContain("trigger://");
    expect(JSON.stringify(view)).not.toContain("secretRef");
  });

  it("keeps public mapping available as a pure helper", () => {
    const record: BronRegisterRecord = {
      ...tendernedBron(),
      actief: false,
      bronId: "bron-1",
      lastRun: null,
    };

    expect(mapPublicBronnen([record])).toEqual([
      expect.objectContaining({ bronId: "bron-1", hasSecretRef: false }),
    ]);
  });

  it("normalizes blank optional secret references before persistence", () => {
    const created = createBron({ ...tendernedBron(), secretRef: "   " });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(created.record.secretRef).toBeNull();
  });

  it("rejects non-positive and fractional retention periods", () => {
    for (const retentionDays of [0, -1, 1.5, Number.NaN]) {
      const created = createBron({ ...tendernedBron(), retentionDays });
      expect(created).toEqual({
        issues: [
          {
            field: "retentionDays",
            message: "retentionDays must be a positive integer",
          },
        ],
        ok: false,
      });
    }
  });

  it("rejects fractional rate limits and crawl delays", () => {
    expect(createBron({ ...tendernedBron(), rateLimitPerMinute: 1.5 })).toEqual(
      {
        issues: [
          {
            field: "rateLimitPerMinute",
            message: "rateLimitPerMinute must be a positive integer",
          },
        ],
        ok: false,
      }
    );
    expect(createBron({ ...tendernedBron(), crawlDelayMs: 0.5 })).toEqual({
      issues: [
        {
          field: "crawlDelayMs",
          message: "crawlDelayMs must be a nonnegative integer",
        },
      ],
      ok: false,
    });
  });

  it("accepts a zero crawl delay", () => {
    const created = createBron({ ...tendernedBron(), crawlDelayMs: 0 });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(created.record.crawlDelayMs).toBe(0);
  });

  it("does not expose boolean-only activation", () => {
    expect("activateBronInRegister" in bronnenApi).toBe(false);
  });

  it("delegates activation using an opaque test-import run id", async () => {
    const created = createBron(tendernedBron());
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    let activationInput: unknown;
    const persistence: BronPersistence = {
      ...persistenceFor(created.record),
      activate: (input) => {
        activationInput = input;
        return Promise.resolve({
          ...created.record,
          actief: true,
          status: "ready" as const,
        });
      },
    };
    const result = await activateBron(persistence, {
      bronId: created.record.bronId,
      minimumTestImportObservations: 5,
      testImportRunId: "test-run-1",
    });
    expect(result.ok).toBe(true);
    expect(activationInput).toEqual({
      bronId: created.record.bronId,
      minimumTestImportObservations: 5,
      testImportRunId: "test-run-1",
    });
  });

  it("accepts only opaque secret references", () => {
    expect(validateSecretRef("op://catapulze/prod/api-key")).toEqual([]);
    expect(validateSecretRef("vault://prod/api-key")).toEqual([]);
    expect(validateSecretRef("trigger://tenderned/api-key")).toEqual([]);
    expect(validateSecretRef("plaintext-secret")).toEqual([
      "secretRef must be an opaque op://, vault://, or trigger:// reference",
    ]);
  });

  it("rejects missing and non-pollable bronnen before connector calls", async () => {
    let calls = 0;
    const connector = {
      bronId: "bron-1",
      discover: () => {
        calls += 1;
        return Promise.resolve({ checkpoint: {}, hasMore: false, items: [] });
      },
      fetch: () => Promise.resolve(null),
    };
    const persistence = persistenceFor(null);
    await expect(
      execute(persistence, {
        bronId: "bron-1",
        bronSlug: "tenderned",
        connector,
        objectStore: new InMemoryObjectStore(),
        observationRecorder: new InMemoryObservationRecorder(),
        runLifecycleStore: new InMemoryRunLifecycleStore(),
        scrapeRunId: "run-1",
      })
    ).rejects.toThrow("bron not found");
    expect(calls).toBe(0);
  });

  it("composes persisted retention and limiter policy", async () => {
    const record = {
      ...tendernedBron(),
      actief: true,
      bronId: "bron-1",
      lastRun: null,
      status: "ready" as const,
    };
    const objectStore = new InMemoryObjectStore();
    const recorder = new InMemoryObservationRecorder();
    const persistence = persistenceFor(record);
    const connector = {
      bronId: "bron-1",
      discover: () =>
        Promise.resolve({
          checkpoint: {},
          hasMore: false,
          items: [{ bronReferentie: "r1", contentHash: "" }],
        }),
      fetch: () =>
        Promise.resolve({
          body: new Uint8Array([1]),
          bronReferentie: "r1",
          contentHash:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          contentType: "html" as const,
          status: "fetched" as const,
        }),
    };
    let now = 0;
    const waits: number[] = [];
    await execute(persistence, {
      bronId: "bron-1",
      bronSlug: "tenderned",
      connector,
      now: () => now,
      objectStore,
      observationRecorder: recorder,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-1",
      startedAt: new Date("2026-08-29T00:00:00Z"),
      wait: (ms) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
      writeNow: () => new Date("2026-08-29T00:00:00Z"),
    });
    const object = await objectStore.get(
      "raw/tenderned/2026/08/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.html"
    );
    expect(object?.expiresAt.getTime()).toBe(
      new Date("2026-11-27T00:00:00Z").getTime()
    );
    expect(waits).toEqual([2000]);
  });

  it("shares limiter windows across concurrent runs for the same bron", async () => {
    const record = {
      ...tendernedBron(),
      actief: true,
      bronId: "bron-concurrent",
      lastRun: null,
      status: "ready" as const,
    };
    let now = 0;
    const waits: number[] = [];
    const executeOnce = (scrapeRunId: string) =>
      execute(persistenceFor(record), {
        bronId: record.bronId,
        bronSlug: "tenderned",
        connector: {
          bronId: record.bronId,
          discover: () =>
            Promise.resolve({ checkpoint: {}, hasMore: false, items: [] }),
          fetch: () => Promise.resolve(null),
        },
        now: () => now,
        objectStore: new InMemoryObjectStore(),
        observationRecorder: new InMemoryObservationRecorder(),
        runLifecycleStore: new InMemoryRunLifecycleStore(),
        scrapeRunId,
        wait: (milliseconds) => {
          waits.push(milliseconds);
          now += milliseconds;
          return Promise.resolve();
        },
      });

    await Promise.all([executeOnce("run-1"), executeOnce("run-2")]);

    expect(waits).toEqual([2000]);
  });

  it("preserves limiter windows across sequential runs for the same bron", async () => {
    const record = {
      ...tendernedBron(),
      actief: true,
      bronId: "bron-sequential",
      lastRun: null,
      status: "ready" as const,
    };
    let now = 0;
    const waits: number[] = [];
    const wait = (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    };
    const executeOnce = (scrapeRunId: string) =>
      execute(persistenceFor(record), {
        bronId: record.bronId,
        bronSlug: "tenderned",
        connector: {
          bronId: record.bronId,
          discover: () =>
            Promise.resolve({ checkpoint: {}, hasMore: false, items: [] }),
          fetch: () => Promise.resolve(null),
        },
        now: () => now,
        objectStore: new InMemoryObjectStore(),
        observationRecorder: new InMemoryObservationRecorder(),
        runLifecycleStore: new InMemoryRunLifecycleStore(),
        scrapeRunId,
        wait,
      });

    await executeOnce("run-sequential-1");
    await executeOnce("run-sequential-2");

    expect(waits).toEqual([2000]);
  });

  it("refreshes idle limiter state when persisted policy changes", async () => {
    let now = 0;
    const waits: number[] = [];
    const executeOnce = (scrapeRunId: string, rateLimitPerMinute: number) =>
      execute(
        persistenceFor({
          ...tendernedBron(),
          actief: true,
          bronId: "bron-policy-refresh",
          lastRun: null,
          rateLimitPerMinute,
          status: "ready" as const,
        }),
        {
          bronId: "bron-policy-refresh",
          bronSlug: "tenderned",
          connector: {
            bronId: "bron-policy-refresh",
            discover: () =>
              Promise.resolve({ checkpoint: {}, hasMore: false, items: [] }),
            fetch: () => Promise.resolve(null),
          },
          now: () => now,
          objectStore: new InMemoryObjectStore(),
          observationRecorder: new InMemoryObservationRecorder(),
          runLifecycleStore: new InMemoryRunLifecycleStore(),
          scrapeRunId,
          wait: (milliseconds) => {
            waits.push(milliseconds);
            now += milliseconds;
            return Promise.resolve();
          },
        }
      );

    await executeOnce("run-policy-1", 30);
    await executeOnce("run-policy-2", 60);
    await executeOnce("run-policy-3", 60);

    expect(waits).toEqual([2000, 1000]);
  });

  it("does not poison a shared policy-transition reservation when one run aborts", async () => {
    const record = {
      ...tendernedBron(),
      actief: true,
      bronId: "bron-policy-transition-abort",
      lastRun: null,
      status: "ready" as const,
    };
    const now = 0;
    let releasePreviousWait: (() => void) | undefined;
    let previousWaitStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic shared-wait barrier
    const previousWaitStarted = new Promise<void>((resolve) => {
      previousWaitStartedResolve = resolve;
    });
    const wait = (milliseconds: number, signal?: AbortSignal) => {
      if (milliseconds === 2000 && !releasePreviousWait) {
        previousWaitStartedResolve?.();
        // The transition's shared reservation deliberately has no signal.
        // Individual callers cancel their await around this promise.
        // oxlint-disable-next-line promise/avoid-new -- deterministic shared-wait barrier
        return new Promise<void>((resolve) => {
          releasePreviousWait = resolve;
        });
      }
      return sleep(milliseconds, signal);
    };
    const executeOnce = (
      scrapeRunId: string,
      rateLimitPerMinute: number,
      signal?: AbortSignal
    ) =>
      execute(
        persistenceFor({
          ...record,
          rateLimitPerMinute,
        }),
        {
          bronId: record.bronId,
          bronSlug: "tenderned",
          connector: {
            bronId: record.bronId,
            discover: () =>
              Promise.resolve({ checkpoint: {}, hasMore: false, items: [] }),
            fetch: () => Promise.resolve(null),
          },
          now: () => now,
          objectStore: new InMemoryObjectStore(),
          observationRecorder: new InMemoryObservationRecorder(),
          runLifecycleStore: new InMemoryRunLifecycleStore(),
          scrapeRunId,
          signal,
          wait,
        }
      );

    await executeOnce("run-policy-transition-seed", 30);
    const controller = new AbortController();
    const aborted = executeOnce(
      "run-policy-transition-aborted",
      60,
      controller.signal
    );
    await previousWaitStarted;
    const concurrent = executeOnce("run-policy-transition-survivor", 60);
    controller.abort();
    await expect(aborted).resolves.toMatchObject({
      completeness: { complete: false, reason: "aborted" },
    });
    releasePreviousWait?.();
    await expect(concurrent).resolves.toMatchObject({
      completeness: { complete: true },
    });
  });

  it("isolates limiter windows across concurrent runs for distinct bronnen", async () => {
    const waits: number[] = [];
    const executeOnce = (bronId: string, scrapeRunId: string) =>
      execute(
        persistenceFor({
          ...tendernedBron(),
          actief: true,
          bronId,
          lastRun: null,
          status: "ready" as const,
        }),
        {
          bronId,
          bronSlug: bronId,
          connector: {
            bronId,
            discover: () =>
              Promise.resolve({ checkpoint: {}, hasMore: false, items: [] }),
            fetch: () => Promise.resolve(null),
          },
          now: () => 0,
          objectStore: new InMemoryObjectStore(),
          observationRecorder: new InMemoryObservationRecorder(),
          runLifecycleStore: new InMemoryRunLifecycleStore(),
          scrapeRunId,
          wait: (milliseconds) => {
            waits.push(milliseconds);
            return Promise.resolve();
          },
        }
      );

    await Promise.all([
      executeOnce("bron-1", "run-1"),
      executeOnce("bron-2", "run-2"),
    ]);

    expect(waits).toEqual([]);
  });
});
