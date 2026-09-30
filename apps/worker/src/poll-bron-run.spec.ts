import { describe, expect, it } from "bun:test";

import type { RunBaselineSample } from "@ji/application/observability";
import type { AlertStore, BronHealthStore } from "@ji/application/registry";
import { resolveTenderNedTestImportDays } from "@ji/application/sources";
import type { BronHealthDatabase } from "@ji/db/bron-health-stores";

import { requireDatabaseUrl, requireManticoreUrl } from "./poll-bron-env";
import type { PollBronRuntime } from "./poll-bron-run";

// `createBronRuntimeClient` builds a lazy postgres-js client — no network
// dial happens at construction, only on an actual query. Safe to call with
// a dummy URL in these guard tests, same pattern slice-a-registry.spec.ts
// uses on the server side.
process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:1/db";
const databaseUrl = process.env.DATABASE_URL;

const { createPollBronRuntime } = await import("./poll-bron-run");

// Unit fixtures assume one owned run; real PostgreSQL ownership is tested separately.
const ownedHealthTransaction =
  (
    alerts: AlertStore,
    health: BronHealthStore,
    // SAFETY: Non-floor fixtures never query this; floor fixtures supply their update double.
    database: BronHealthDatabase = {} as never,
    ownsRun = true
  ): PollBronRuntime["withSourceHealthTransaction"] =>
  (runOperation) =>
    runOperation({
      alerts,
      bronHealth: {
        getByBronId: (id) => health.getByBronId(id),
        list: () => health.list(),
        upsert: (record) => health.upsert(record),
        upsertForRun: ({ record }) =>
          ownsRun ? health.upsert(record) : Promise.resolve(null),
      },
      database,
    });

describe("createPollBronRuntime raw object store production guard (RJC-386)", () => {
  it("throws naming RAW_S3_BUCKET when production resolves to the filesystem store", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBucket = process.env.RAW_S3_BUCKET;
    process.env.NODE_ENV = "production";
    delete process.env.RAW_S3_BUCKET;
    try {
      expect(() => createPollBronRuntime(databaseUrl)).toThrow(
        /RAW_S3_BUCKET/u
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousBucket === undefined) {
        delete process.env.RAW_S3_BUCKET;
      } else {
        process.env.RAW_S3_BUCKET = previousBucket;
      }
    }
  });

  it("does not throw when production resolves to the S3 store", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBucket = process.env.RAW_S3_BUCKET;
    process.env.NODE_ENV = "production";
    process.env.RAW_S3_BUCKET = "ji-raw-prod";
    try {
      const runtime = createPollBronRuntime(databaseUrl);
      try {
        expect(runtime.objectStore).toBeDefined();
      } finally {
        await runtime.close();
      }
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousBucket === undefined) {
        delete process.env.RAW_S3_BUCKET;
      } else {
        process.env.RAW_S3_BUCKET = previousBucket;
      }
    }
  });

  it("leaves the filesystem store usable outside production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBucket = process.env.RAW_S3_BUCKET;
    process.env.NODE_ENV = "development";
    delete process.env.RAW_S3_BUCKET;
    try {
      const runtime = createPollBronRuntime(databaseUrl);
      try {
        expect(runtime.objectStore).toBeDefined();
      } finally {
        await runtime.close();
      }
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousBucket === undefined) {
        delete process.env.RAW_S3_BUCKET;
      } else {
        process.env.RAW_S3_BUCKET = previousBucket;
      }
    }
  });
});

describe("poll-bron runtime guards", () => {
  it("requires DATABASE_URL", () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    expect(() => requireDatabaseUrl()).toThrow("DATABASE_URL is required");
    if (previous === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous;
    }
  });

  it("requires MANTICORE_URL for outbox drain", () => {
    const previous = process.env.MANTICORE_URL;
    delete process.env.MANTICORE_URL;
    expect(() => requireManticoreUrl()).toThrow("MANTICORE_URL is required");
    if (previous === undefined) {
      delete process.env.MANTICORE_URL;
    } else {
      process.env.MANTICORE_URL = previous;
    }
  });
});

const withEnvVar = async (
  key:
    | "SEARCH_PROJECTOR"
    | "MANTICORE_URL"
    | "ALERT_WEBHOOK_URL"
    | "ALERT_ESCALATION_HOURS",
  value: string | undefined,
  run: () => Promise<void> | void
): Promise<void> => {
  const previous = process.env[key];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = previous;
    }
  }
};

describe("SEARCH_PROJECTOR mode (RJC-387)", () => {
  it("readSearchProjectorMode defaults to worker when unset", async () => {
    const { readSearchProjectorMode } = await import("./poll-bron-env");
    await withEnvVar("SEARCH_PROJECTOR", undefined, () => {
      expect(readSearchProjectorMode()).toBe("worker");
    });
  });

  it("readSearchProjectorMode accepts onbox", async () => {
    const { readSearchProjectorMode } = await import("./poll-bron-env");
    await withEnvVar("SEARCH_PROJECTOR", "onbox", () => {
      expect(readSearchProjectorMode()).toBe("onbox");
    });
  });

  it("readSearchProjectorMode rejects an invalid value", async () => {
    const { readSearchProjectorMode } = await import("./poll-bron-env");
    await withEnvVar("SEARCH_PROJECTOR", "cloud", () => {
      expect(() => readSearchProjectorMode()).toThrow(
        'SEARCH_PROJECTOR must be "worker" or "onbox"'
      );
    });
  });

  it("readAlertWebhookUrl returns null when unset and validates https (CTP-653)", async () => {
    const { readAlertWebhookUrl } = await import("./poll-bron-env");
    await withEnvVar("ALERT_WEBHOOK_URL", undefined, () => {
      expect(readAlertWebhookUrl()).toBeNull();
    });
    await withEnvVar("ALERT_WEBHOOK_URL", "http://hooks.example.test/x", () => {
      expect(() => readAlertWebhookUrl()).toThrow(
        "ALERT_WEBHOOK_URL must be an https URL"
      );
    });
    await withEnvVar("ALERT_WEBHOOK_URL", "http://localhost:8787/hook", () => {
      expect(readAlertWebhookUrl()).toBe("http://localhost:8787/hook");
    });
    await withEnvVar(
      "ALERT_WEBHOOK_URL",
      "https://hooks.example.test/x",
      () => {
        expect(readAlertWebhookUrl()).toBe("https://hooks.example.test/x");
      }
    );
  });

  it("readAlertEscalationHours defaults to 4 and rejects non-positive values (CTP-653)", async () => {
    const { readAlertEscalationHours } = await import("./poll-bron-env");
    await withEnvVar("ALERT_ESCALATION_HOURS", undefined, () => {
      expect(readAlertEscalationHours()).toBe(4);
    });
    await withEnvVar("ALERT_ESCALATION_HOURS", "0", () => {
      expect(() => readAlertEscalationHours()).toThrow(
        "ALERT_ESCALATION_HOURS must be a positive number"
      );
    });
    await withEnvVar("ALERT_ESCALATION_HOURS", "12", () => {
      expect(readAlertEscalationHours()).toBe(12);
    });
  });

  it("onbox mode drains nothing and never needs MANTICORE_URL", async () => {
    const { drainOrDeferToProjector } = await import("./poll-bron-run");
    await withEnvVar("SEARCH_PROJECTOR", "onbox", async () => {
      await withEnvVar("MANTICORE_URL", undefined, async () => {
        // A runtime whose `database` would throw if touched: proves the
        // onbox branch returns before drainPostgresOutbox ever reads it,
        // let alone constructs a ManticoreSearchEngine from MANTICORE_URL.
        const untouchableRuntime = {
          get database(): never {
            throw new Error("onbox mode must not touch runtime.database");
          },
        };

        const summary = await drainOrDeferToProjector(untouchableRuntime);

        expect(summary).toEqual({ drained: 0, indexVersion: null });
        expect(process.env.MANTICORE_URL).toBeUndefined();
      });
    });
  });

  it("worker mode (default) still requires MANTICORE_URL before draining", async () => {
    const { drainOrDeferToProjector } = await import("./poll-bron-run");
    await withEnvVar("SEARCH_PROJECTOR", undefined, async () => {
      await withEnvVar("MANTICORE_URL", undefined, async () => {
        // SAFETY: worker mode reads MANTICORE_URL before touching
        // `database` (see drainOrDeferToProjector), so this placeholder is
        // never dereferenced — the assertion below only proves the
        // MANTICORE_URL guard fires first.
        const untouchedRuntime = { database: {} as never };
        await expect(drainOrDeferToProjector(untouchedRuntime)).rejects.toThrow(
          "MANTICORE_URL is required"
        );
      });
    });
  });
});

describe("TenderNed test-import window", () => {
  it("defaults to 14 days when unset", () => {
    const previous = process.env.TENDER_NED_TEST_IMPORT_DAYS;
    delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
    try {
      expect(resolveTenderNedTestImportDays()).toBe(14);
    } finally {
      if (previous === undefined) {
        delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
      } else {
        process.env.TENDER_NED_TEST_IMPORT_DAYS = previous;
      }
    }
  });

  it("defaults to 14 days when empty", () => {
    const previous = process.env.TENDER_NED_TEST_IMPORT_DAYS;
    process.env.TENDER_NED_TEST_IMPORT_DAYS = "";
    try {
      expect(resolveTenderNedTestImportDays()).toBe(14);
    } finally {
      if (previous === undefined) {
        delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
      } else {
        process.env.TENDER_NED_TEST_IMPORT_DAYS = previous;
      }
    }
  });

  it("returns a configured integer", () => {
    const previous = process.env.TENDER_NED_TEST_IMPORT_DAYS;
    process.env.TENDER_NED_TEST_IMPORT_DAYS = "7";
    try {
      expect(resolveTenderNedTestImportDays()).toBe(7);
    } finally {
      if (previous === undefined) {
        delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
      } else {
        process.env.TENDER_NED_TEST_IMPORT_DAYS = previous;
      }
    }
  });

  it("rejects zero", () => {
    const previous = process.env.TENDER_NED_TEST_IMPORT_DAYS;
    process.env.TENDER_NED_TEST_IMPORT_DAYS = "0";
    try {
      expect(() => resolveTenderNedTestImportDays()).toThrow("1-90");
    } finally {
      if (previous === undefined) {
        delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
      } else {
        process.env.TENDER_NED_TEST_IMPORT_DAYS = previous;
      }
    }
  });

  it("rejects values above 90", () => {
    const previous = process.env.TENDER_NED_TEST_IMPORT_DAYS;
    process.env.TENDER_NED_TEST_IMPORT_DAYS = "91";
    try {
      expect(() => resolveTenderNedTestImportDays()).toThrow("1-90");
    } finally {
      if (previous === undefined) {
        delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
      } else {
        process.env.TENDER_NED_TEST_IMPORT_DAYS = previous;
      }
    }
  });

  it("rejects non-numeric values", () => {
    const previous = process.env.TENDER_NED_TEST_IMPORT_DAYS;
    process.env.TENDER_NED_TEST_IMPORT_DAYS = "abc";
    try {
      expect(() => resolveTenderNedTestImportDays()).toThrow('received "abc"');
    } finally {
      if (previous === undefined) {
        delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
      } else {
        process.env.TENDER_NED_TEST_IMPORT_DAYS = previous;
      }
    }
  });

  it("rejects fractional values", () => {
    const previous = process.env.TENDER_NED_TEST_IMPORT_DAYS;
    process.env.TENDER_NED_TEST_IMPORT_DAYS = "1.5";
    try {
      expect(() => resolveTenderNedTestImportDays()).toThrow('received "1.5"');
    } finally {
      if (previous === undefined) {
        delete process.env.TENDER_NED_TEST_IMPORT_DAYS;
      } else {
        process.env.TENDER_NED_TEST_IMPORT_DAYS = previous;
      }
    }
  });
});

const untouched = (name: string): never => {
  throw new Error(`runPollBron must not touch runtime.${name}`);
};

describe("runPollBron missed-poll lifecycle wiring (RJC-397)", () => {
  it("exposes lifecycle ports on the runtime built from a database url", async () => {
    const runtime = createPollBronRuntime(databaseUrl);
    try {
      expect(runtime.lifecycle.curateStore).toBeDefined();
      expect(runtime.lifecycle.missedPolls).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it("passes the lifecycle port into the run and carries a JSON-safe summary on the result", async () => {
    const { runPollBron } = await import("./poll-bron-run");
    const { InMemoryCurateStore } = await import("@ji/application/identity");
    const { createInMemoryLifecyclePorts, InMemoryMissedPollsStore } =
      await import("@ji/application/lifecycle");
    const {
      InMemoryKnownHashStore,
      InMemoryObjectStore,
      InMemoryObservationRecorder,
      InMemoryRunLifecycleStore,
      RunOwnershipLostError,
    } = await import("@ji/connectors");
    const { SOURCES } = await import("@ji/application/sources");

    const source = SOURCES.hero;
    const { bronId } = source;
    const missedPolls = new InMemoryMissedPollsStore();
    // A record seen in an earlier run that this run's listing will not show.
    missedPolls.ensure(bronId, "gone-since-last-run");
    const record = {
      actief: true,
      bronId,
      categorie: "msp_broker",
      crawlDelayMs: 0,
      interval: "*/15 * * * *",
      lastRun: null,
      loginVereist: false,
      mappingRef: null,
      method: "html" as const,
      naam: source.naam,
      rateLimitPerMinute: 600,
      retentionDays: 30,
      secretRef: null,
      status: "ready" as const,
      voorwaardenStatus: "toegestaan" as const,
    };
    const runtime = {
      bronPersistence: {
        activate: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        findById: () => Promise.resolve(record),
        list: () => Promise.resolve([record]),
      },
      close: () => Promise.resolve(),
      createConnector: () => ({
        bronId,
        discover: () =>
          Promise.resolve({
            checkpoint: {},
            hasMore: false,
            items: [{ bronReferentie: "still-listed", contentHash: "" }],
          }),
        fetch: () => Promise.resolve(null),
      }),
      get curateStore(): never {
        return untouched("curateStore");
      },
      get database(): never {
        return untouched("database");
      },
      knownHashStore: new InMemoryKnownHashStore(),
      lifecycle: createInMemoryLifecyclePorts(
        new InMemoryCurateStore(),
        missedPolls
      ),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      withSourceHealthTransaction: <T>(): Promise<T> =>
        Promise.reject(new Error("unused")),
    };

    let progressCallbacks = 0;
    const result = await runPollBron(
      {
        bronId,
        bronSlug: "hero",
        scrapeRunId: "00000000-0000-4000-8000-00000000a397",
      },
      runtime,
      "poll",
      {
        onProgress: () => {
          progressCallbacks += 1;
          throw new Error("telemetry observer unavailable");
        },
      }
    );

    expect(progressCallbacks).toBeGreaterThan(0);
    expect(result.status).toBe("succeeded");
    // Task output must be JSON-safe scalars (Trigger.dev run payload).
    expect(JSON.stringify(result.lifecycle)).toBe(
      '{"incremented":1,"reopened":0,"reset":1,"skippedIncrementReason":null,"staled":0}'
    );
    expect(missedPolls.read(bronId, "gone-since-last-run")?.missedPolls).toBe(
      1
    );

    await expect(
      runPollBron(
        {
          bronId,
          bronSlug: "hero",
          scrapeRunId: "00000000-0000-4000-8000-00000000a398",
        },
        runtime,
        "poll",
        {
          onProgress: () => {
            throw new RunOwnershipLostError();
          },
        }
      )
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    const abortController = new AbortController();
    const abortReason = new Error("operator cancelled telemetry");
    let abortedError: unknown;
    try {
      await runPollBron(
        {
          bronId,
          bronSlug: "hero",
          scrapeRunId: "00000000-0000-4000-8000-00000000a399",
        },
        runtime,
        "poll",
        {
          onProgress: () => {
            abortController.abort(abortReason);
            throw new Error("observer failed after cancellation");
          },
          signal: abortController.signal,
        }
      );
    } catch (error) {
      abortedError = error;
    }
    expect(abortedError).toBeInstanceOf(Error);
    if (!(abortedError instanceof Error)) {
      throw new Error("Expected aborted telemetry run to reject");
    }
    expect(abortedError.cause).toBe(abortReason);
  });
});

const unusedSilenceProp = (name: string): never => {
  throw new Error(`handleSilenceAndHealth must not touch runtime.${name}`);
};

const baselineSamples = (): RunBaselineSample[] => {
  // Anchored to the run, not to a calendar date. `handleSilenceAndHealth`
  // evaluates silence against the real clock, so a fixed `detectedAt` ages out
  // of the baseline window and the suite starts failing on a date nobody
  // changed anything on.
  const detectedAt = new Date();
  return Array.from({ length: 7 }, (_, index) => ({
    at: new Date(detectedAt.getTime() - (index + 1) * 86_400_000),
    changed: 4,
    found: 40,
    new: 8,
  }));
};

describe("runBronIngestPipeline silence evaluation (RJC-409)", () => {
  const bronId = "00000000-0000-4000-8000-000000000010";
  const bronNaam = "TenderNed";

  it("wires evaluateSilence in runBronIngestPipeline after complete and dedupes second alert", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth } = await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();

    const silentPollResult = {
      bronId,
      bronSlug: "tenderned" as const,
      completeness: null,
      fenceToken: 1,
      lifecycle: null,
      metrics: {
        changed: 0,
        error: 0,
        found: 10,
        new: 0,
        rejected: 0,
        unchanged: 10,
      },
      scrapeRunId: "00000000-0000-4000-8000-000000000001",
      status: "succeeded" as const,
      writtenRecords: 0,
    };

    const runtime = {
      alerts,
      bronHealth,
      bronPersistence: {
        activate: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        findById: () =>
          Promise.resolve({
            actief: true,
            bronId,
            categorie: "overheidsportaal",
            crawlDelayMs: 0,
            interval: "*/15 * * * *",
            lastRun: null,
            loginVereist: false,
            mappingRef: null,
            method: "json-api" as const,
            naam: bronNaam,
            rateLimitPerMinute: 60,
            retentionDays: 90,
            secretRef: null,
            status: "ready" as const,
            voorwaardenStatus: "toegestaan" as const,
          }),
        list: () => Promise.resolve([]),
      },
      close: () => Promise.resolve(),
      createConnector: () => unusedSilenceProp("createConnector"),
      get curateStore(): never {
        return unusedSilenceProp("curateStore");
      },
      get database(): never {
        return unusedSilenceProp("database");
      },
      get knownHashStore(): never {
        return unusedSilenceProp("knownHashStore");
      },
      get lifecycle(): never {
        return unusedSilenceProp("lifecycle");
      },
      loadBaseline: () => Promise.resolve(baselineSamples()),
      get objectStore(): never {
        return unusedSilenceProp("objectStore");
      },
      get observationRecorder(): never {
        return unusedSilenceProp("observationRecorder");
      },
      get runLifecycleStore(): never {
        return unusedSilenceProp("runLifecycleStore");
      },
      withSourceHealthTransaction: ownedHealthTransaction(alerts, bronHealth),
    };

    // First run: silence detected -> alert created, silenceAlertOpen set to true
    const firstResult = await handleSilenceAndHealth(
      silentPollResult,
      runtime,
      "poll"
    );
    expect(firstResult).not.toBeNull();
    expect(firstResult?.created).toBe(true);
    expect(firstResult?.alertId).toBeDefined();

    const openAlerts = await alerts.listOpen();
    expect(openAlerts).toHaveLength(1);
    expect(openAlerts[0]?.id).toBe(firstResult?.alertId);
    expect(openAlerts[0]?.kind).toBe("bron.stil");

    const healthAfterFirst = await bronHealth.getByBronId(bronId);
    expect(healthAfterFirst?.silenceAlertOpen).toBe(true);
    expect(healthAfterFirst?.lastRunStatus).toBe("succeeded");

    // Second run: silence detected again -> dedupe key prevents second alert
    const secondResult = await handleSilenceAndHealth(
      silentPollResult,
      runtime,
      "poll"
    );
    expect(secondResult).not.toBeNull();
    expect(secondResult?.created).toBe(false);
    expect(secondResult?.alertId).toBe(firstResult?.alertId);

    const openAlertsAfterSecond = await alerts.listOpen();
    expect(openAlertsAfterSecond).toHaveLength(1);

    const healthAfterSecond = await bronHealth.getByBronId(bronId);
    expect(healthAfterSecond?.silenceAlertOpen).toBe(true);
  });

  it("updates bronHealth with silenceAlertOpen false when run has normal activity", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth } = await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();

    const normalPollResult = {
      bronId,
      bronSlug: "tenderned" as const,
      completeness: null,
      fenceToken: 1,
      lifecycle: null,
      metrics: {
        changed: 2,
        error: 0,
        found: 30,
        new: 5,
        rejected: 0,
        unchanged: 23,
      },
      scrapeRunId: "00000000-0000-4000-8000-000000000002",
      status: "succeeded" as const,
      writtenRecords: 7,
    };

    const runtime = {
      alerts,
      bronHealth,
      bronPersistence: {
        activate: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        findById: () =>
          Promise.resolve({
            actief: true,
            bronId,
            categorie: "overheidsportaal",
            crawlDelayMs: 0,
            interval: "*/15 * * * *",
            lastRun: null,
            loginVereist: false,
            mappingRef: null,
            method: "json-api" as const,
            naam: bronNaam,
            rateLimitPerMinute: 60,
            retentionDays: 90,
            secretRef: null,
            status: "ready" as const,
            voorwaardenStatus: "toegestaan" as const,
          }),
        list: () => Promise.resolve([]),
      },
      close: () => Promise.resolve(),
      createConnector: () => unusedSilenceProp("createConnector"),
      get curateStore(): never {
        return unusedSilenceProp("curateStore");
      },
      get database(): never {
        return unusedSilenceProp("database");
      },
      get knownHashStore(): never {
        return unusedSilenceProp("knownHashStore");
      },
      get lifecycle(): never {
        return unusedSilenceProp("lifecycle");
      },
      loadBaseline: () => Promise.resolve(baselineSamples()),
      get objectStore(): never {
        return unusedSilenceProp("objectStore");
      },
      get observationRecorder(): never {
        return unusedSilenceProp("observationRecorder");
      },
      get runLifecycleStore(): never {
        return unusedSilenceProp("runLifecycleStore");
      },
      withSourceHealthTransaction: ownedHealthTransaction(alerts, bronHealth),
    };

    const result = await handleSilenceAndHealth(
      normalPollResult,
      runtime,
      "poll"
    );
    expect(result).not.toBeNull();
    expect(result?.created).toBe(false);
    expect(result?.alertId).toBeUndefined();

    const openAlerts = await alerts.listOpen();
    expect(openAlerts).toHaveLength(0);

    const health = await bronHealth.getByBronId(bronId);
    expect(health?.silenceAlertOpen).toBe(false);
    expect(health?.lastRunStatus).toBe("succeeded");
  });

  it("skips silence evaluation and surfaces the error when the baseline read fails", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth } = await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();

    const silentPollResult = {
      bronId,
      bronSlug: "tenderned" as const,
      completeness: null,
      fenceToken: 1,
      lifecycle: null,
      metrics: {
        changed: 0,
        error: 0,
        found: 10,
        new: 0,
        rejected: 0,
        unchanged: 10,
      },
      scrapeRunId: "00000000-0000-4000-8000-000000000004",
      status: "succeeded" as const,
      writtenRecords: 0,
    };

    const runtime = {
      alerts,
      bronHealth,
      bronPersistence: {
        activate: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        findById: () => Promise.resolve(null),
        list: () => Promise.resolve([]),
      },
      close: () => Promise.resolve(),
      createConnector: () => unusedSilenceProp("createConnector"),
      get curateStore(): never {
        return unusedSilenceProp("curateStore");
      },
      get database(): never {
        return unusedSilenceProp("database");
      },
      get knownHashStore(): never {
        return unusedSilenceProp("knownHashStore");
      },
      get lifecycle(): never {
        return unusedSilenceProp("lifecycle");
      },
      loadBaseline: () =>
        Promise.reject(
          new Error("baseline query timed out", {
            cause: new Error("postgres://user:secret@db.internal/ji"),
          })
        ),
      get objectStore(): never {
        return unusedSilenceProp("objectStore");
      },
      get observationRecorder(): never {
        return unusedSilenceProp("observationRecorder");
      },
      get runLifecycleStore(): never {
        return unusedSilenceProp("runLifecycleStore");
      },
      withSourceHealthTransaction: ownedHealthTransaction(alerts, bronHealth),
    };

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // SAFETY: the code under test only calls write(string); the stub is restored in `finally`.
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let result: Awaited<ReturnType<typeof handleSilenceAndHealth>>;
    try {
      result = await handleSilenceAndHealth(silentPollResult, runtime, "poll");
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result?.created).toBe(false);
    expect(result?.alertId).toBeUndefined();
    expect(result?.baselineReadError).toContain("baseline query timed out");
    expect(result?.baselineReadError).not.toContain("secret");

    // A failed read is not a silent bron: no alert, but no clean "no history" either.
    expect(await alerts.listOpen()).toHaveLength(0);
    const health = await bronHealth.getByBronId(bronId);
    expect(health?.lastRunStatus).toBe("succeeded");
    expect(health?.silenceAlertOpen).toBe(false);

    const logged = stderrLines.find((line) =>
      line.includes("run_baseline_read_failed")
    );
    expect(logged).toBeDefined();
    expect(logged).toContain(bronId);
    expect(logged).not.toContain("secret");
  });

  it("does not evaluate silence for non-poll runs", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth } = await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();

    const testPollResult = {
      bronId,
      bronSlug: "tenderned" as const,
      completeness: null,
      fenceToken: 1,
      lifecycle: null,
      metrics: {
        changed: 0,
        error: 0,
        found: 0,
        new: 0,
        rejected: 0,
        unchanged: 0,
      },
      scrapeRunId: "00000000-0000-4000-8000-000000000003",
      status: "succeeded" as const,
      writtenRecords: 0,
    };

    const runtime = {
      alerts,
      bronHealth,
      bronPersistence: {
        activate: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        findById: () => Promise.resolve(null),
        list: () => Promise.resolve([]),
      },
      close: () => Promise.resolve(),
      createConnector: () => unusedSilenceProp("createConnector"),
      get curateStore(): never {
        return unusedSilenceProp("curateStore");
      },
      get database(): never {
        return unusedSilenceProp("database");
      },
      get knownHashStore(): never {
        return unusedSilenceProp("knownHashStore");
      },
      get lifecycle(): never {
        return unusedSilenceProp("lifecycle");
      },
      get objectStore(): never {
        return unusedSilenceProp("objectStore");
      },
      get observationRecorder(): never {
        return unusedSilenceProp("observationRecorder");
      },
      get runLifecycleStore(): never {
        return unusedSilenceProp("runLifecycleStore");
      },
      withSourceHealthTransaction: ownedHealthTransaction(alerts, bronHealth),
    };

    const result = await handleSilenceAndHealth(
      testPollResult,
      runtime,
      "test"
    );
    expect(result).toBeNull();
  });

  const silentPollResult = {
    bronId,
    bronSlug: "tenderned" as const,
    completeness: null,
    fenceToken: 1,
    lifecycle: null,
    metrics: {
      changed: 0,
      error: 0,
      found: 10,
      new: 0,
      rejected: 0,
      unchanged: 10,
    },
    scrapeRunId: "00000000-0000-4000-8000-000000000001",
    status: "succeeded" as const,
    writtenRecords: 0,
  };

  const silenceRuntime = (
    alerts: AlertStore,
    bronHealth: BronHealthStore,
    transaction?: PollBronRuntime["withSourceHealthTransaction"]
  ) => ({
    alerts,
    bronHealth,
    bronPersistence: {
      activate: () => Promise.reject(new Error("unused")),
      create: () => Promise.reject(new Error("unused")),
      findById: () =>
        Promise.resolve({
          actief: true,
          bronId,
          categorie: "overheidsportaal",
          crawlDelayMs: 0,
          interval: "*/15 * * * *",
          lastRun: null,
          loginVereist: false,
          mappingRef: null,
          method: "json-api" as const,
          naam: bronNaam,
          rateLimitPerMinute: 60,
          retentionDays: 90,
          secretRef: null,
          status: "ready" as const,
          voorwaardenStatus: "toegestaan" as const,
        }),
      list: () => Promise.resolve([]),
    },
    close: () => Promise.resolve(),
    createConnector: () => unusedSilenceProp("createConnector"),
    get curateStore(): never {
      return unusedSilenceProp("curateStore");
    },
    get database(): never {
      return unusedSilenceProp("database");
    },
    get knownHashStore(): never {
      return unusedSilenceProp("knownHashStore");
    },
    get lifecycle(): never {
      return unusedSilenceProp("lifecycle");
    },
    loadBaseline: () => Promise.resolve(baselineSamples()),
    get objectStore(): never {
      return unusedSilenceProp("objectStore");
    },
    get observationRecorder(): never {
      return unusedSilenceProp("observationRecorder");
    },
    get runLifecycleStore(): never {
      return unusedSilenceProp("runLifecycleStore");
    },
    withSourceHealthTransaction:
      transaction ?? ownedHealthTransaction(alerts, bronHealth),
  });

  it("delivers the opened alert only after the health transaction commits", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth } = await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();
    const calls: string[] = [];

    const base = ownedHealthTransaction(alerts, bronHealth);
    const runtime = silenceRuntime(alerts, bronHealth, async (operation) => {
      calls.push("tx-begin");
      const result = await base(operation);
      calls.push("tx-commit");
      return result;
    });

    const realFetch = globalThis.fetch;
    // Object.assign keeps Bun's fetch statics on the recording stub, so the
    // assignment stays type-correct without an assertion.
    globalThis.fetch = Object.assign(() => {
      calls.push("deliver");
      return Promise.resolve(new Response("ok"));
    }, realFetch);
    try {
      await withEnvVar(
        "ALERT_WEBHOOK_URL",
        "https://hooks.example.test/x",
        async () => {
          const result = await handleSilenceAndHealth(
            silentPollResult,
            runtime,
            "poll"
          );
          expect(result?.created).toBe(true);
        }
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toEqual(["tx-begin", "tx-commit", "deliver"]);
  });

  it("never delivers when the health transaction throws", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth } = await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();
    const calls: string[] = [];

    // Simulates a rollback: the callback ran (alert row written inside the
    // tx) but ownership was lost before commit.
    const runtime = silenceRuntime(alerts, bronHealth, async (operation) => {
      calls.push("tx-body");
      await ownedHealthTransaction(alerts, bronHealth)(operation);
      calls.push("tx-rollback");
      throw new Error("ownership lost — transaction rolled back");
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(() => {
      calls.push("deliver");
      return Promise.resolve(new Response("ok"));
    }, realFetch);
    try {
      await withEnvVar(
        "ALERT_WEBHOOK_URL",
        "https://hooks.example.test/x",
        async () => {
          await expect(
            handleSilenceAndHealth(silentPollResult, runtime, "poll")
          ).rejects.toThrow("rolled back");
        }
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toEqual(["tx-body", "tx-rollback"]);
    expect(calls.includes("deliver")).toBe(false);
  });

  it("auto-resolves an open silence alert when a later poll has activity", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth, SILENCE_AUTO_RESOLVE_ACTOR } =
      await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();
    const runtime = silenceRuntime(alerts, bronHealth);

    const silentResult = await handleSilenceAndHealth(
      silentPollResult,
      runtime,
      "poll"
    );
    expect(silentResult?.created).toBe(true);
    const alertId = silentResult?.alertId;
    expect(alertId).toBeDefined();

    const activePollResult = {
      ...silentPollResult,
      metrics: {
        changed: 2,
        error: 0,
        found: 30,
        new: 5,
        rejected: 0,
        unchanged: 23,
      },
      scrapeRunId: "00000000-0000-4000-8000-000000000005",
      writtenRecords: 7,
    };
    await handleSilenceAndHealth(activePollResult, runtime, "poll");

    expect(await alerts.listOpen()).toHaveLength(0);
    // SAFETY: silentResult.created was asserted true, so alertId is set.
    const resolved = await alerts.getById(alertId as string);
    expect(resolved?.ackedBy).toBe(SILENCE_AUTO_RESOLVE_ACTOR);
    const health = await bronHealth.getByBronId(bronId);
    expect(health?.silenceAlertOpen).toBe(false);
    expect(health?.lastRunStatus).toBe("succeeded");
  });

  it("keeps the silence alert open when a later poll succeeds without activity", async () => {
    const { MemoryAlertStore, MemoryBronHealthStore } =
      await import("@ji/application/registry");
    const { handleSilenceAndHealth } = await import("./poll-bron-run");

    const alerts = new MemoryAlertStore();
    const bronHealth = new MemoryBronHealthStore();
    const runtime = silenceRuntime(alerts, bronHealth);

    const silentResult = await handleSilenceAndHealth(
      silentPollResult,
      runtime,
      "poll"
    );
    expect(silentResult?.created).toBe(true);
    const alertId = silentResult?.alertId;

    // Volume matches baseline but still zero new/changed: no new event, and
    // no recovery either — a quiet run is not evidence the silence ended.
    const quietPollResult = {
      ...silentPollResult,
      metrics: {
        changed: 0,
        error: 0,
        found: 40,
        new: 0,
        rejected: 0,
        unchanged: 40,
      },
      scrapeRunId: "00000000-0000-4000-8000-000000000006",
    };
    await handleSilenceAndHealth(quietPollResult, runtime, "poll");

    expect(await alerts.listOpen()).toHaveLength(1);
    // SAFETY: silentResult.created was asserted true, so alertId is set.
    const stillOpen = await alerts.getById(alertId as string);
    expect(stillOpen?.ackedBy).toBeNull();
    const health = await bronHealth.getByBronId(bronId);
    expect(health?.silenceAlertOpen).toBe(true);
  });
});

describe("runPollBron scrape_run.gesloten and unchanged metrics (RJC-414)", () => {
  it("writes scrape_run.gesloten from lifecycle.staled and exposes unchanged on PollBronRunResult", async () => {
    const { runPollBron } = await import("./poll-bron-run");
    const { InMemoryCurateStore } = await import("@ji/application/identity");
    const { createInMemoryLifecyclePorts, InMemoryMissedPollsStore } =
      await import("@ji/application/lifecycle");
    const { SOURCES } = await import("@ji/application/sources");
    const {
      InMemoryKnownHashStore,
      InMemoryObjectStore,
      InMemoryObservationRecorder,
      InMemoryRunLifecycleStore,
    } = await import("@ji/connectors");

    const source = SOURCES.hero;
    const { bronId } = source;
    const scrapeRunId = "00000000-0000-4000-8000-00000000a414";

    const record = {
      actief: true,
      bronId,
      categorie: "msp_broker",
      crawlDelayMs: 0,
      interval: "*/15 * * * *",
      lastRun: null,
      loginVereist: false,
      mappingRef: null,
      method: "html" as const,
      naam: source.naam,
      rateLimitPerMinute: 600,
      retentionDays: 30,
      secretRef: null,
      status: "ready" as const,
      voorwaardenStatus: "toegestaan" as const,
    };

    interface UpdateCapture {
      values: { gesloten?: number };
    }
    const updatedRows: UpdateCapture[] = [];
    const fakeDatabase = {
      update: () => ({
        set: (values: { gesloten?: number }) => ({
          where: () => {
            updatedRows.push({ values });
            return {
              returning: () => Promise.resolve([{ id: scrapeRunId }]),
            };
          },
        }),
      }),
    };
    // SAFETY: Test double fulfills the BronRuntimeDatabase update subset required by runPollBron.
    const database = fakeDatabase as never;

    const curateStore = new InMemoryCurateStore();
    const missedPolls = new InMemoryMissedPollsStore();
    missedPolls.ensure(bronId, "staled-ref");
    const missedRow = missedPolls.read(bronId, "staled-ref");
    if (missedRow) {
      missedRow.missedPolls = 2;
    }

    const provenanceItem = { parserVersion: "test", sourcePath: "n/a" };
    await curateStore.insertAanvraag({
      beschrijving: "test",
      bronId,
      bronReferentie: "staled-ref",
      bronSpecifiek: {},
      bronUrl: null,
      contactpersonen: [],
      contentHash: "hash-99",
      contracttype: null,
      dedupGroepId: null,
      eersteGezienOp: new Date("2026-08-01T00:00:00Z"),
      eindDatum: null,
      extractieMethode: "html_parser",
      laatstGezienOp: new Date("2026-08-20T00:00:00Z"),
      locatieLand: "NL",
      locatieTekst: null,
      opdrachtgeverNaam: null,
      parserVersion: "test",
      provenance: {
        beschrijving: provenanceItem,
        bron_referentie: provenanceItem,
        bron_specifiek: provenanceItem,
        bron_url: provenanceItem,
        locatie_land: provenanceItem,
        locatie_tekst: provenanceItem,
        opdrachtgever_naam: provenanceItem,
        start_datum: provenanceItem,
        tarief_eenheid: provenanceItem,
        tarief_max: provenanceItem,
        tarief_min: provenanceItem,
        titel: provenanceItem,
      },
      publicatiedatum: null,
      rawPayloadRef: "raw/test.json",
      scrapeRunId: "00000000-0000-4000-8000-000000000001",
      sluitingsdatum: null,
      startDatum: null,
      status: "active",
      tariefEenheid: null,
      tariefMax: null,
      tariefMin: null,
      tariefValuta: "EUR",
      titel: "test",
      urenPerWeek: null,
      versie: 1,
      werkvorm: null,
    });

    const runtime = {
      bronPersistence: {
        activate: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        findById: () => Promise.resolve(record),
        list: () => Promise.resolve([record]),
      },
      close: () => Promise.resolve(),
      createConnector: () => ({
        bronId,
        discover: () =>
          Promise.resolve({
            checkpoint: {},
            hasMore: false,
            items: [{ bronReferentie: "still-here", contentHash: "h1" }],
          }),
        fetch: () => Promise.resolve(null),
      }),
      get curateStore(): never {
        return untouched("curateStore");
      },
      database,
      knownHashStore: new InMemoryKnownHashStore(),
      lifecycle: createInMemoryLifecyclePorts(curateStore, missedPolls),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      withSourceHealthTransaction: <T>(): Promise<T> =>
        Promise.reject(new Error("unused")),
    };

    const result = await runPollBron(
      {
        bronId,
        bronSlug: "hero",
        scrapeRunId,
      },
      runtime,
      "poll"
    );

    expect(result.metrics.unchanged).toBe(0);
    expect(result.lifecycle?.staled).toBe(1);
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]?.values).toEqual({ gesloten: 1 });
  });
});

const unusedFloorProp = (name: string): never => {
  throw new Error(`recordDiscoveryFloorBreach must not touch runtime.${name}`);
};

interface DiscoveryFloorUpdate {
  failureClass?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  failurePhase?: string | null;
  status?: string;
}

const createFloorStores = async () => {
  const { MemoryAlertStore, MemoryBronHealthStore } =
    await import("@ji/application/registry");
  return {
    alerts: new MemoryAlertStore(),
    bronHealth: new MemoryBronHealthStore(),
  };
};

describe("discovery floor guard", () => {
  const bronId = "00000000-0000-4000-8000-000000000010";
  const bronNaam = "TenderNed";
  const scrapeRunId = "00000000-0000-4000-8000-000000000001";

  // Anchored to the run like `baselineSamples` above: the guard reads the real
  // clock, so a fixed date would age out of the window.
  const anchor = new Date();
  const lastNonZeroAt = new Date(anchor.getTime() - 86_400_000);
  const collapsedMessage = `Bron ${bronNaam} vond 0 records in 3 opeenvolgende polls terwijl de laatste succesvolle poll op ${lastNonZeroAt.toISOString()} er 730 vond; discovery is stil gevallen zonder foutmelding.`;

  const healthyBaseline = (): RunBaselineSample[] =>
    Array.from({ length: 3 }, (_, index) => ({
      at: new Date(anchor.getTime() - (index + 1) * 86_400_000),
      changed: 0,
      found: 730,
      new: 0,
    }));

  // Two zero polls already on the record, so the run under evaluation is the
  // third in a row and the floor is armed.
  const collapsedBaseline = (): RunBaselineSample[] => [
    {
      at: new Date(anchor.getTime() - 15 * 60_000),
      changed: 0,
      found: 0,
      new: 0,
    },
    {
      at: new Date(anchor.getTime() - 30 * 60_000),
      changed: 0,
      found: 0,
      new: 0,
    },
    ...healthyBaseline(),
  ];

  const bronRecord = {
    actief: true,
    bronId,
    categorie: "overheidsportaal",
    crawlDelayMs: 0,
    interval: "*/15 * * * *",
    lastRun: null,
    loginVereist: false,
    mappingRef: null,
    method: "json-api" as const,
    naam: bronNaam,
    rateLimitPerMinute: 60,
    retentionDays: 90,
    secretRef: null,
    status: "ready" as const,
    voorwaardenStatus: "toegestaan" as const,
  };

  const pollResultWithFound = (found: number) => ({
    bronId,
    bronSlug: "tenderned" as const,
    completeness: null,
    fenceToken: 1,
    lifecycle: null,
    metrics: {
      changed: 0,
      error: 0,
      found,
      new: 0,
      rejected: 0,
      unchanged: 0,
    },
    scrapeRunId,
    status: "succeeded" as const,
    writtenRecords: 0,
  });

  const createRuntime = (input: {
    alerts: AlertStore;
    bronHealth: BronHealthStore;
    captured: DiscoveryFloorUpdate[];
    loadBaseline: () => Promise<RunBaselineSample[]>;
    ownsRun?: boolean;
  }) => {
    // SAFETY: Test double fulfills the update subset the guard uses.
    const database = {
      update: () => ({
        set: (values: DiscoveryFloorUpdate) => ({
          where: () => {
            input.captured.push(values);
            return {
              returning: () =>
                Promise.resolve(
                  input.ownsRun === false ? [] : [{ id: scrapeRunId }]
                ),
            };
          },
        }),
      }),
    } as never;
    return {
      alerts: input.alerts,
      bronHealth: input.bronHealth,
      bronPersistence: {
        activate: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        findById: () => Promise.resolve(bronRecord),
        list: () => Promise.resolve([bronRecord]),
      },
      close: () => Promise.resolve(),
      createConnector: () => unusedFloorProp("createConnector"),
      get curateStore(): never {
        return unusedFloorProp("curateStore");
      },
      database,
      get knownHashStore(): never {
        return unusedFloorProp("knownHashStore");
      },
      get lifecycle(): never {
        return unusedFloorProp("lifecycle");
      },
      loadBaseline: input.loadBaseline,
      get objectStore(): never {
        return unusedFloorProp("objectStore");
      },
      get observationRecorder(): never {
        return unusedFloorProp("observationRecorder");
      },
      get runLifecycleStore(): never {
        return unusedFloorProp("runLifecycleStore");
      },
      withSourceHealthTransaction: ownedHealthTransaction(
        input.alerts,
        input.bronHealth,
        database,
        input.ownsRun ?? true
      ),
    };
  };

  it("fails the run, alerts and returns the error when a collapse persists", async () => {
    const { DiscoveryFloorBreachedError, recordDiscoveryFloorBreach } =
      await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () => Promise.resolve(collapsedBaseline()),
    });

    const breach = await recordDiscoveryFloorBreach(
      pollResultWithFound(0),
      runtime,
      "poll"
    );

    expect(breach).toBeInstanceOf(DiscoveryFloorBreachedError);
    expect(breach?.message).toBe(collapsedMessage);
    expect(breach?.evidence.consecutiveZeroRuns).toBe(3);

    // The envelope is the pinned `DISCOVER_FAILED` tuple: anything else
    // violates `scrape_run_failure_tuple_check`.
    expect(captured).toEqual([
      {
        failureClass: "connector",
        failureCode: "DISCOVER_FAILED",
        failureMessage: "Connector discovery failed",
        failurePhase: "discover",
        status: "failed",
      },
    ]);

    const openAlerts = await alerts.listOpen();
    expect(openAlerts).toHaveLength(1);
    expect(openAlerts[0]?.kind).toBe("bron.discovery_floor");
    expect(openAlerts[0]?.message).toBe(collapsedMessage);
    const healthAfterBreach = await bronHealth.getByBronId(bronId);
    expect(healthAfterBreach?.lastRunStatus).toBe("failed");
  });

  it("leaves the first zero of a collapse alone and writes nothing", async () => {
    const { recordDiscoveryFloorBreach } = await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () => Promise.resolve(healthyBaseline()),
    });

    const breach = await recordDiscoveryFloorBreach(
      pollResultWithFound(0),
      runtime,
      "poll"
    );

    expect(breach).toBeNull();
    expect(captured).toEqual([]);
    expect(await alerts.listOpen()).toEqual([]);
  });

  it("raises one alert when the same collapse repeats", async () => {
    const { recordDiscoveryFloorBreach } = await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () => Promise.resolve(collapsedBaseline()),
    });

    const first = await recordDiscoveryFloorBreach(
      pollResultWithFound(0),
      runtime,
      "poll"
    );
    const second = await recordDiscoveryFloorBreach(
      pollResultWithFound(0),
      runtime,
      "poll"
    );

    expect(first?.message).toBe(collapsedMessage);
    expect(second?.message).toBe(collapsedMessage);
    expect(await alerts.listOpen()).toHaveLength(1);
  });

  it("stops before alerting when the fenced failure update owns no row", async () => {
    const { RunOwnershipLostError } = await import("@ji/connectors");
    const { recordDiscoveryFloorBreach } = await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () => Promise.resolve(collapsedBaseline()),
      ownsRun: false,
    });

    await expect(
      recordDiscoveryFloorBreach(pollResultWithFound(0), runtime, "poll")
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(await alerts.listOpen()).toEqual([]);
    expect(await bronHealth.getByBronId(bronId)).toBeNull();
  });

  it("preserves the circuit and silence signals it does not own", async () => {
    const { recordDiscoveryFloorBreach } = await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    await bronHealth.upsert({
      bronId,
      circuitStatus: "open",
      lastRunAt: new Date(anchor.getTime() - 3_600_000),
      lastRunStatus: "succeeded",
      silenceAlertOpen: true,
    });

    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () => Promise.resolve(collapsedBaseline()),
    });

    const breach = await recordDiscoveryFloorBreach(
      pollResultWithFound(0),
      runtime,
      "poll"
    );

    expect(breach?.message).toBe(collapsedMessage);
    const health = await bronHealth.getByBronId(bronId);
    expect(health?.circuitStatus).toBe("open");
    expect(health?.silenceAlertOpen).toBe(true);
    expect(health?.lastRunStatus).toBe("failed");
  });

  it("leaves a genuine first run alone and writes nothing", async () => {
    const { recordDiscoveryFloorBreach } = await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () => Promise.resolve([]),
    });

    const breach = await recordDiscoveryFloorBreach(
      pollResultWithFound(0),
      runtime,
      "poll"
    );

    expect(breach).toBeNull();
    expect(captured).toEqual([]);
    expect(await alerts.listOpen()).toEqual([]);
  });

  it("leaves a healthy run alone and writes nothing", async () => {
    const { recordDiscoveryFloorBreach } = await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () => Promise.resolve(collapsedBaseline()),
    });

    const breach = await recordDiscoveryFloorBreach(
      pollResultWithFound(730),
      runtime,
      "poll"
    );

    expect(breach).toBeNull();
    expect(captured).toEqual([]);
    expect(await alerts.listOpen()).toEqual([]);
  });

  it("never touches a test-import run, not even to load the baseline", async () => {
    const { recordDiscoveryFloorBreach } = await import("./poll-bron-run");

    const { alerts, bronHealth } = await createFloorStores();
    const captured: DiscoveryFloorUpdate[] = [];
    const runtime = createRuntime({
      alerts,
      bronHealth,
      captured,
      loadBaseline: () =>
        Promise.reject(
          new Error("the discovery floor must not load a baseline for test")
        ),
    });

    const breach = await recordDiscoveryFloorBreach(
      pollResultWithFound(0),
      runtime,
      "test"
    );

    expect(breach).toBeNull();
    expect(captured).toEqual([]);
    expect(await alerts.listOpen()).toEqual([]);
  });
});
