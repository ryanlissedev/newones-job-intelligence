import { describe, expect, it } from "bun:test";

import type { BronId, ScrapeRunId } from "@ji/domain";

import type { Connector } from "./contract";
import { CancelFault } from "./effect-runtime/faults";
import { CrawlDelayLimiter } from "./limiter";
import {
  buildContentAddressedRawObjectPath,
  buildRawObjectPath,
  InMemoryObjectStore,
  parseContentAddressedRawObjectPath,
} from "./object-store";
import type { ObjectStore } from "./object-store";
import { InMemoryObservationRecorder } from "./observation-recorder";
import type { ObservationRecordInput } from "./observation-recorder";
import { sleep, withRetry } from "./retry";
import { runConnector } from "./run";
import {
  ConnectorRunFailure,
  InMemoryRunLifecycleStore,
  RunOwnershipLostError,
} from "./run-lifecycle";
import type { RunLifecycleStore } from "./run-lifecycle";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const createFakeConnector = (bronId: BronId): Connector => ({
  bronId,
  discover: (checkpoint) => {
    const page = Number(checkpoint?.page ?? 0);
    if (Number.isFinite(page) && page > 0) {
      return Promise.resolve({
        checkpoint: { page },
        hasMore: false,
        items: [],
      });
    }
    return Promise.resolve({
      checkpoint: { page: 1 },
      hasMore: false,
      items: [{ bronReferentie: "TN-100", contentHash: "listing-hash" }],
    });
  },
  fetch: (item) =>
    Promise.resolve({
      body: new TextEncoder().encode(
        JSON.stringify({ id: item.bronReferentie })
      ),
      bronReferentie: item.bronReferentie,
      contentHash:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      contentType: "json",
      status: "fetched",
    }),
});

const runDependencies = (scrapeRunId: ScrapeRunId) => ({
  limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
  objectStore: new InMemoryObjectStore(),
  observationRecorder: new InMemoryObservationRecorder(),
  rawRetentionDays: 90,
  retryPolicy,
  runKind: "poll" as const,
  runLifecycleStore: new InMemoryRunLifecycleStore(),
  scrapeRunId,
});

const captureRunFailure = async (
  input: Parameters<typeof runConnector>[0]
): Promise<ConnectorRunFailure> => {
  try {
    await runConnector(input);
  } catch (error) {
    if (error instanceof ConnectorRunFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected connector run failure");
};

const observationInput = (
  bronReferentie: string,
  contentHash: string
): ObservationRecordInput => ({
  fenceToken: 1,
  key: { bronId: "bron-recorder", scrapeRunId: "run-recorder" },
  observation: {
    bronId: "bron-recorder",
    bronReferentie,
    contentHash,
    contentType: "json",
    contractVersion: "connector-observation/v1",
    observedAt: "2026-08-29T10:00:00.000Z",
    rawPayloadRef: `raw/${bronReferentie}.json`,
    scrapeRunId: "run-recorder",
  },
  sourceRecord: {
    bronId: "bron-recorder",
    bronReferentie,
    contentHash,
    rawPayloadRef: `raw/${bronReferentie}.json`,
    scrapeRunId: "run-recorder",
  },
});

describe("buildRawObjectPath", () => {
  it("uses the documented raw object layout", () => {
    expect(
      buildRawObjectPath({
        bronSlug: "tenderned",
        contentType: "json",
        recordId: "TN-100",
        runId: "run-1",
        startedAt: new Date("2026-08-28T10:15:00.000Z"),
      })
    ).toBe("raw/tenderned/2026/08/28/run-1/TN-100.json");
  });
});

describe("buildContentAddressedRawObjectPath", () => {
  const validHash =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("throws on a bronSlug containing a slash", () => {
    expect(() =>
      buildContentAddressedRawObjectPath({
        bronSlug: "tender/ned",
        contentHash: validHash,
        contentType: "json",
      })
    ).toThrow(/Invalid bronSlug/u);
  });

  it("normalises an uppercase digest and remains digest-verifiable", () => {
    const upperHash = validHash.toUpperCase();
    const path = buildContentAddressedRawObjectPath({
      bronSlug: "tenderned",
      contentHash: upperHash,
      contentType: "json",
      startedAt: new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(path).toBe(`raw/tenderned/2026/08/${validHash}.json`);
    expect(parseContentAddressedRawObjectPath(path)).toEqual({
      contentHash: validHash,
    });
  });

  it("throws on a contentHash that is not a 64-character hex digest", () => {
    expect(() =>
      buildContentAddressedRawObjectPath({
        bronSlug: "tenderned",
        contentHash: "too-short",
        contentType: "json",
      })
    ).toThrow(/Invalid contentHash/u);
  });
});

describe("parseContentAddressedRawObjectPath", () => {
  const validHash =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("rejects a near-miss with an extra path segment", () => {
    expect(
      parseContentAddressedRawObjectPath(
        `raw/tender/ned/2026/08/${validHash}.json`
      )
    ).toBeNull();
  });

  it("rejects an uppercase digest (would have to come from a path the builder never produces)", () => {
    expect(
      parseContentAddressedRawObjectPath(
        `raw/tenderned/2026/08/${validHash.toUpperCase()}.json`
      )
    ).toBeNull();
  });

  it("rejects a legacy day/runId/recordId path", () => {
    expect(
      parseContentAddressedRawObjectPath(
        "raw/tenderned/2026/08/28/run-1/TN-100.json"
      )
    ).toBeNull();
  });
});

describe("CrawlDelayLimiter", () => {
  it("enforces the stricter of crawl delay and per-minute rate", async () => {
    let now = 1000;
    const waits: number[] = [];
    const limiter = new CrawlDelayLimiter({
      crawlDelayMs: 250,
      now: () => now,
      rateLimitPerMinute: 60,
      wait: (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });
    await limiter.acquire("bron-limited");
    await limiter.acquire("bron-limited");
    expect(waits).toEqual([1000]);
  });

  it("isolates request windows per bron", async () => {
    let now = 1000;
    const waits: number[] = [];
    const limiter = new CrawlDelayLimiter({
      crawlDelayMs: 500,
      now: () => now,
      wait: (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });
    await limiter.acquire("bron-a");
    await limiter.acquire("bron-b");
    await limiter.acquire("bron-a");
    expect(waits).toEqual([500]);
  });

  it("reserves same-bron request windows before concurrent callers wait", async () => {
    const waits: number[] = [];
    const limiter = new CrawlDelayLimiter({
      crawlDelayMs: 500,
      now: () => 1000,
      wait: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });

    await Promise.all([
      limiter.acquire("bron-a"),
      limiter.acquire("bron-a"),
      limiter.acquire("bron-a"),
    ]);

    expect(waits).toEqual([500, 1000]);
  });

  it("rejects non-finite, fractional, and negative policy values", () => {
    for (const crawlDelayMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
    ]) {
      expect(() => new CrawlDelayLimiter({ crawlDelayMs })).toThrow(
        "crawlDelayMs must be a non-negative integer"
      );
    }
    for (const rateLimitPerMinute of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      1.5,
    ]) {
      expect(
        () => new CrawlDelayLimiter({ crawlDelayMs: 0, rateLimitPerMinute })
      ).toThrow("rateLimitPerMinute must be a positive integer");
    }
  });

  it("cancels a delayed acquire promptly", async () => {
    const controller = new AbortController();
    let waitStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic wait barrier
    const waitStarted = new Promise<void>((resolve) => {
      waitStartedResolve = resolve;
    });
    const limiter = new CrawlDelayLimiter({
      crawlDelayMs: 1000,
      wait: (milliseconds, signal) => {
        waitStartedResolve?.();
        return sleep(milliseconds, signal);
      },
    });
    await limiter.acquire("bron-abort-wait");
    const pending = limiter.acquire("bron-abort-wait", controller.signal);
    await waitStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("withRetry", () => {
  it("applies injectable jitter to capped exponential backoff", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts += 1;
        return attempts < 4
          ? Promise.reject(new Error("temporary"))
          : Promise.resolve("done");
      },
      {
        initialDelayMs: 10,
        jitter: (delayMs) => Math.floor(delayMs / 2),
        maxAttempts: 4,
        maxDelayMs: 25,
        multiplier: 2,
      },
      (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      }
    );
    expect(result).toBe("done");
    expect(attempts).toBe(4);
    expect(waits).toEqual([5, 10, 12]);
  });

  it("rejects unbounded or fractional retry configuration", async () => {
    await expect(
      withRetry(() => Promise.resolve(), {
        initialDelayMs: 1.5,
        maxAttempts: 2,
        maxDelayMs: 10,
        multiplier: 2,
      })
    ).rejects.toThrow("initialDelayMs must be a non-negative integer");
    await expect(
      withRetry(() => Promise.resolve(), {
        initialDelayMs: 1,
        maxAttempts: Number.POSITIVE_INFINITY,
        maxDelayMs: 10,
        multiplier: 2,
      })
    ).rejects.toThrow("maxAttempts must be a positive integer");
  });

  it("cancels a retry backoff before starting another attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let waitStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic retry barrier
    const waitStarted = new Promise<void>((resolve) => {
      waitStartedResolve = resolve;
    });
    const pending = withRetry(
      () => {
        attempts += 1;
        return Promise.reject(new Error("temporary"));
      },
      {
        initialDelayMs: 25,
        maxAttempts: 2,
        maxDelayMs: 25,
        multiplier: 1,
      },
      (milliseconds, signal) => {
        waitStartedResolve?.();
        return sleep(milliseconds, signal);
      },
      controller.signal
    );
    await waitStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });
});

describe("InMemoryObservationRecorder", () => {
  it("rejects a stale fence before changing the mutable source record", async () => {
    const recorder = new InMemoryObservationRecorder();
    const current = observationInput("reference", "current-hash");
    current.fenceToken = 2;
    await recorder.record(current);
    const stale = observationInput("reference", "stale-hash");
    stale.fenceToken = 1;
    await expect(recorder.record(stale)).rejects.toMatchObject({
      code: "RUN_OWNERSHIP_LOST",
    });
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]?.contentHash).toBe("current-hash");
    expect(recorder.observations).toHaveLength(1);
  });

  it("treats different references with the same hash as separate new records", async () => {
    const recorder = new InMemoryObservationRecorder();
    const first = await recorder.record(observationInput("ref-1", "same-hash"));
    const second = await recorder.record(
      observationInput("ref-2", "same-hash")
    );

    expect(first.outcome).toBe("new");
    expect(second.outcome).toBe("new");
    expect(recorder.records).toHaveLength(2);
    expect(recorder.observations).toHaveLength(2);
  });

  it("classifies a second hash for the same run reference as changed", async () => {
    const recorder = new InMemoryObservationRecorder();
    const first = await recorder.record(observationInput("ref-1", "hash-1"));
    const changed = await recorder.record(observationInput("ref-1", "hash-2"));
    const replay = await recorder.record(observationInput("ref-1", "hash-1"));

    expect(first.outcome).toBe("new");
    expect(changed.outcome).toBe("changed");
    expect(replay.outcome).toBe("new");
    expect(recorder.observations).toHaveLength(2);
  });
});

describe("InMemoryRunLifecycleStore", () => {
  it("issues monotone fence tokens and rejects every stale mutation", async () => {
    const store = new InMemoryRunLifecycleStore();
    const key = { bronId: "bron-fence", scrapeRunId: "run-fence" };
    const staleProgress = {
      checkpoint: { page: 1 },
      metrics: {
        changed: 0,
        error: 0,
        found: 1,
        new: 1,
        rejected: 0,
        unchanged: 0,
      },
    };
    const newestProgress = {
      checkpoint: { page: 2 },
      metrics: {
        changed: 1,
        error: 0,
        found: 2,
        new: 1,
        rejected: 0,
        unchanged: 0,
      },
    };
    const first = await store.start({
      key,
      mode: "reset",
      progress: staleProgress,
      runKind: "poll",
      startedAt: new Date("2026-08-29T08:00:00Z"),
    });
    const second = await store.start({
      key,
      mode: "resume",
      progress: staleProgress,
      runKind: "poll",
      startedAt: new Date("2026-08-29T09:00:00Z"),
    });
    expect(second.fenceToken).toBe(first.fenceToken + 1);
    await expect(
      store.checkpoint(key, newestProgress, first.fenceToken)
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    await expect(
      store.complete({
        fenceToken: first.fenceToken,
        finishedAt: new Date("2026-08-29T09:01:00Z"),
        key,
        progress: newestProgress,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    await expect(
      store.fail({
        failure: {
          class: "internal",
          code: "UNEXPECTED_FAILURE",
          message: "Connector run failed",
          phase: "unknown",
        },
        fenceToken: first.fenceToken,
        finishedAt: new Date("2026-08-29T09:01:00Z"),
        key,
        progress: newestProgress,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(await store.load(key)).toEqual(staleProgress);
    await store.checkpoint(key, newestProgress, second.fenceToken);
    expect(await store.load(key)).toEqual(newestProgress);
  });

  it("replaces startedAt on reset and preserves it on resume", async () => {
    const store = new InMemoryRunLifecycleStore();
    const key = { bronId: "bron-time", scrapeRunId: "run-time" };
    const progress = {
      checkpoint: null,
      metrics: {
        changed: 0,
        error: 0,
        found: 0,
        new: 0,
        rejected: 0,
        unchanged: 0,
      },
    };
    await store.start({
      key,
      mode: "reset",
      progress,
      runKind: "test",
      startedAt: new Date("2026-08-20T08:00:00.000Z"),
    });
    await store.start({
      key,
      mode: "reset",
      progress,
      runKind: "test",
      startedAt: new Date("2026-08-21T08:00:00.000Z"),
    });
    const resumed = await store.start({
      key,
      mode: "resume",
      progress,
      runKind: "test",
      startedAt: new Date("2026-08-29T08:00:00.000Z"),
    });

    expect(resumed.startedAt).toEqual(new Date("2026-08-21T08:00:00.000Z"));

    await expect(
      store.start({
        key,
        mode: "resume",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-29T08:00:00.000Z"),
      })
    ).rejects.toThrow("Cannot resume connector run with a different run kind");

    await store.start({
      key,
      mode: "reset",
      progress,
      runKind: "poll",
      startedAt: new Date("2026-08-22T08:00:00.000Z"),
    });
    const pollResume = await store.start({
      key,
      mode: "resume",
      progress,
      runKind: "poll",
      startedAt: new Date("2026-08-29T08:00:00.000Z"),
    });
    expect(pollResume.startedAt).toEqual(new Date("2026-08-22T08:00:00.000Z"));
  });

  it("rejects reuse of succeeded and failed run ids", async () => {
    const store = new InMemoryRunLifecycleStore();
    const progress = {
      checkpoint: null,
      metrics: {
        changed: 0,
        error: 0,
        found: 0,
        new: 0,
        rejected: 0,
        unchanged: 0,
      },
    };
    const succeededKey = {
      bronId: "bron-terminal",
      scrapeRunId: "run-succeeded",
    };
    const failedKey = { bronId: "bron-terminal", scrapeRunId: "run-failed" };
    const startedAt = new Date("2026-08-29T08:00:00.000Z");
    const succeededRun = await store.start({
      key: succeededKey,
      mode: "reset",
      progress,
      runKind: "test",
      startedAt,
    });
    await store.complete({
      fenceToken: succeededRun.fenceToken,
      finishedAt: new Date("2026-08-29T08:01:00.000Z"),
      key: succeededKey,
      progress,
    });
    const failedRun = await store.start({
      key: failedKey,
      mode: "reset",
      progress,
      runKind: "test",
      startedAt,
    });
    await store.fail({
      failure: {
        class: "internal",
        code: "UNEXPECTED_FAILURE",
        message: "Connector run failed",
        phase: "unknown",
      },
      fenceToken: failedRun.fenceToken,
      finishedAt: new Date("2026-08-29T08:01:00.000Z"),
      key: failedKey,
      progress,
    });

    await expect(
      store.start({
        key: succeededKey,
        mode: "reset",
        progress,
        runKind: "test",
        startedAt,
      })
    ).rejects.toThrow("Cannot reuse a terminal connector run");
    await expect(
      store.start({
        key: failedKey,
        mode: "resume",
        progress,
        runKind: "test",
        startedAt,
      })
    ).rejects.toThrow("Cannot reuse a terminal connector run");
  });
});

describe("runConnector", () => {
  it("retains committed item metrics when reporting progress fails", async () => {
    const dependencies = runDependencies("run-progress-failure");
    const telemetryError = new Error("progress write unavailable");
    await expect(
      runConnector({
        ...dependencies,
        bronId: "bron-progress-failure",
        bronSlug: "tenderned",
        connector: createFakeConnector("bron-progress-failure"),
        onProgress: (milestone) =>
          milestone.phase === "persist"
            ? Promise.reject(telemetryError)
            : Promise.resolve(),
      })
    ).rejects.toMatchObject({ cause: telemetryError });
    expect(dependencies.observationRecorder.observations).toHaveLength(1);
    const progress = await dependencies.runLifecycleStore.load({
      bronId: "bron-progress-failure",
      scrapeRunId: "run-progress-failure",
    });
    expect(progress?.metrics).toMatchObject({ error: 1, found: 1, new: 1 });
  });

  it("reports per-item progress only after the corresponding work completes", async () => {
    const dependencies = runDependencies("run-progress");
    const milestones: string[] = [];
    const observedAt = new Date("2026-09-19T12:00:00Z");
    await runConnector({
      ...dependencies,
      bronId: "bron-progress",
      bronSlug: "tenderned",
      connector: createFakeConnector("bron-progress"),
      onProgress: (milestone) => {
        expect(milestone.key).toEqual({
          bronId: "bron-progress",
          scrapeRunId: "run-progress",
        });
        expect(milestone.fenceToken).toBe(1);
        expect(milestone.observedAt).toEqual(observedAt);
        milestones.push(
          `${milestone.phase}:${dependencies.observationRecorder.observations.length}`
        );
        return Promise.resolve();
      },
      writeNow: () => observedAt,
    });
    expect(milestones).toEqual(["fetch:0", "fetch:0", "persist:1"]);
  });

  it("passes the run AbortSignal through discover and fetch", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const bronId = "bron-signal-propagation";
    const dependencies = runDependencies("run-signal-propagation");

    await runConnector({
      ...dependencies,
      bronId,
      bronSlug: "signal-propagation",
      connector: {
        bronId,
        discover: (_checkpoint, signal) => {
          if (signal) {
            signals.push(signal);
          }
          return Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [{ bronReferentie: "signal-1", contentHash: "listing" }],
          });
        },
        fetch: (item, signal) => {
          if (signal) {
            signals.push(signal);
          }
          return Promise.resolve({
            body: new TextEncoder().encode(item.bronReferentie),
            bronReferentie: item.bronReferentie,
            contentHash:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            contentType: "json" as const,
            status: "fetched" as const,
          });
        },
        fetchUsesNetwork: false,
      },
      signal: controller.signal,
    });

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("stores an oversized bron_referentie as one bounded key in staging, the observation, and the seen-set (CTP-500)", async () => {
    const oversized = "vacatures/".concat("x".repeat(3000));
    const bronId = "bron-bounded-ref";
    const dependencies = runDependencies("run-bounded-ref");

    const result = await runConnector({
      ...dependencies,
      bronId,
      bronSlug: "bounded-ref",
      connector: {
        bronId,
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [{ bronReferentie: oversized, contentHash: "listing" }],
          }),
        fetch: (item) =>
          Promise.resolve({
            body: new TextEncoder().encode(item.bronReferentie),
            bronReferentie: item.bronReferentie,
            contentHash:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            contentType: "json" as const,
            status: "fetched" as const,
          }),
        fetchUsesNetwork: false,
      },
    });

    const [record] = dependencies.observationRecorder.records;
    const [observation] = dependencies.observationRecorder.observations;
    const bounded = record?.bronReferentie ?? "";
    expect(bounded).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(observation?.bronReferentie).toBe(bounded);
    expect(result.observedBronReferenties).toEqual([bounded]);
    expect(result.metrics.new).toBe(1);
  });

  it("limits discovery and network fetches while allowing local fetches to skip the limiter", async () => {
    const acquireCalls: BronId[] = [];
    const limiter = {
      acquire: (bronId: BronId): Promise<void> => {
        acquireCalls.push(bronId);
        return Promise.resolve();
      },
    };
    const dependencies = {
      ...runDependencies("run-local-fetch-limiter"),
      limiter,
    };
    const bronId = "bron-local-fetch-limiter";

    await runConnector({
      ...dependencies,
      bronId,
      bronSlug: "local-fetch-limiter",
      connector: {
        bronId,
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [{ bronReferentie: "local-1", contentHash: "listing" }],
          }),
        fetch: (item) =>
          Promise.resolve({
            body: new TextEncoder().encode(item.bronReferentie),
            bronReferentie: item.bronReferentie,
            contentHash:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            contentType: "json" as const,
            status: "fetched" as const,
          }),
        fetchUsesNetwork: false,
      },
    });

    expect(acquireCalls).toEqual([bronId]);

    const networkBronId = "bron-network-fetch-limiter";
    await runConnector({
      ...dependencies,
      bronId: networkBronId,
      bronSlug: "network-fetch-limiter",
      connector: createFakeConnector(networkBronId),
      scrapeRunId: "run-network-fetch-limiter",
    });

    expect(acquireCalls).toEqual([bronId, networkBronId, networkBronId]);
  });

  it("maps each guarded failure phase to its exact secret-safe tuple", async () => {
    const inputFor = (suffix: string): Parameters<typeof runConnector>[0] => ({
      ...runDependencies(`run-phase-${suffix}`),
      bronId: `bron-phase-${suffix}`,
      bronSlug: `phase-${suffix}`,
      connector: createFakeConnector(`bron-phase-${suffix}`),
    });

    const discoverInput = inputFor("discover");
    discoverInput.connector = {
      bronId: discoverInput.bronId,
      discover: () => Promise.reject(new Error("secret discover details")),
      fetch: () => Promise.resolve(null),
    };
    const discoverFailure = await captureRunFailure(discoverInput);
    expect(discoverFailure.envelope).toEqual({
      class: "connector",
      code: "DISCOVER_FAILED",
      message: "Connector discovery failed",
      phase: "discover",
    });

    const fetchInput = inputFor("fetch");
    fetchInput.connector = {
      ...createFakeConnector(fetchInput.bronId),
      fetch: () => Promise.reject(new Error("secret fetch details")),
    };
    const fetchFailure = await captureRunFailure(fetchInput);
    expect(fetchFailure.envelope).toEqual({
      class: "connector",
      code: "FETCH_FAILED",
      message: "Connector fetch failed",
      phase: "fetch",
    });

    const rawInput = inputFor("raw-store");
    rawInput.objectStore = {
      deleteExpired: () => Promise.resolve(0),
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error("secret storage details")),
    };
    const rawFailure = await captureRunFailure(rawInput);
    expect(rawFailure.envelope).toEqual({
      class: "storage",
      code: "RAW_STORE_WRITE_FAILED",
      message: "Raw object persistence failed",
      phase: "raw-store",
    });

    const observationFailureInput = inputFor("observation");
    observationFailureInput.observationRecorder = {
      record: () => Promise.reject(new Error("secret database details")),
    };
    const observationFailure = await captureRunFailure(observationFailureInput);
    expect(observationFailure.envelope).toEqual({
      class: "persistence",
      code: "OBSERVATION_WRITE_FAILED",
      message: "Observation persistence failed",
      phase: "observation",
    });

    const persistenceFailures = await Promise.all(
      (["checkpoint", "complete"] as const).map((phase) => {
        const persistenceInput = inputFor(phase);
        const baseStore = persistenceInput.runLifecycleStore;
        persistenceInput.runLifecycleStore = {
          checkpoint: (key, progress, fenceToken) =>
            phase === "checkpoint"
              ? Promise.reject(new Error("secret checkpoint details"))
              : baseStore.checkpoint(key, progress, fenceToken),
          complete: (completion) =>
            phase === "complete"
              ? Promise.reject(new Error("secret completion details"))
              : baseStore.complete(completion),
          fail: (failure) => baseStore.fail(failure),
          load: (key) => baseStore.load(key),
          start: (start) => baseStore.start(start),
        };
        return captureRunFailure(persistenceInput);
      })
    );
    expect(persistenceFailures.map((failure) => failure.envelope)).toEqual([
      {
        class: "persistence",
        code: "CHECKPOINT_WRITE_FAILED",
        message: "Run checkpoint persistence failed",
        phase: "checkpoint",
      },
      {
        class: "persistence",
        code: "COMPLETE_WRITE_FAILED",
        message: "Run completion persistence failed",
        phase: "complete",
      },
    ]);
  });

  it("preserves a non-Error retry cause by identity in ConnectorRunFailure", async () => {
    const cause = { secret: "do-not-persist", type: "source-rejection" };
    const dependencies = runDependencies("run-non-error");
    let caught: unknown;
    try {
      await runConnector({
        ...dependencies,
        bronId: "bron-non-error",
        bronSlug: "non-error",
        connector: {
          bronId: "bron-non-error",
          discover: () => Promise.reject(cause),
          fetch: () => Promise.resolve(null),
        },
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof ConnectorRunFailure)) {
      throw new Error("Expected ConnectorRunFailure");
    }
    expect(caught.cause).toBe(cause);
    expect(caught.envelope).toEqual({
      class: "connector",
      code: "DISCOVER_FAILED",
      message: "Connector discovery failed",
      phase: "discover",
    });
  });

  it("does not record failure after run ownership is lost", async () => {
    const baseStore = new InMemoryRunLifecycleStore();
    let failCalls = 0;
    const runLifecycleStore: RunLifecycleStore = {
      checkpoint: () => Promise.reject(new RunOwnershipLostError()),
      complete: (input) => baseStore.complete(input),
      fail: () => {
        failCalls += 1;
        return Promise.resolve();
      },
      load: (key) => baseStore.load(key),
      start: (input) => baseStore.start(input),
    };
    const dependencies = runDependencies("run-lost-owner");
    await expect(
      runConnector({
        ...dependencies,
        bronId: "bron-lost-owner",
        bronSlug: "lost-owner",
        connector: {
          bronId: "bron-lost-owner",
          discover: () =>
            Promise.resolve({
              checkpoint: { page: 1 },
              hasMore: false,
              items: [],
            }),
          fetch: () => Promise.resolve(null),
        },
        runLifecycleStore,
      })
    ).rejects.toMatchObject({ code: "RUN_OWNERSHIP_LOST" });
    expect(failCalls).toBe(0);
  });

  it("writes an object and a source_record pointer in one run", async () => {
    const dependencies = runDependencies("run-1");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-tenderned",
      bronSlug: "tenderned",
      checkpoint: null,
      connector: createFakeConnector("bron-tenderned"),
      startedAt: new Date("2026-08-28T10:15:00.000Z"),
    });
    expect(result).toMatchObject({
      metrics: {
        changed: 0,
        error: 0,
        found: 1,
        new: 1,
        rejected: 0,
        unchanged: 0,
      },
      writtenRecords: 1,
    });
    expect(dependencies.observationRecorder.records).toEqual([
      {
        bronId: "bron-tenderned",
        bronReferentie: "TN-100",
        contentHash:
          "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        // RJC-357: the discover pass's listing-tier hash rides along so the
        // next poll's short-circuit compares like with like.
        listingHash: "listing-hash",
        rawPayloadRef:
          "raw/tenderned/2026/08/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.json",
        scrapeRunId: "run-1",
      },
    ]);
  });

  it("retains distinct raw objects for multiple versions of one reference", async () => {
    const dependencies = runDependencies("run-raw-collision");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-raw-collision",
      bronSlug: "raw-collision",
      connector: {
        bronId: "bron-raw-collision",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [
              {
                bronReferentie: "REF-1",
                contentHash:
                  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
              {
                bronReferentie: "REF-1",
                contentHash:
                  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
            ],
          }),
        fetch: (item) =>
          Promise.resolve({
            body: new TextEncoder().encode(item.contentHash),
            bronReferentie: item.bronReferentie,
            contentHash: item.contentHash,
            contentType: "json",
            status: "fetched",
          }),
      },
      startedAt: new Date("2026-08-28T10:15:00.000Z"),
    });

    const firstPath =
      "raw/raw-collision/2026/08/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
    const secondPath =
      "raw/raw-collision/2026/08/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json";
    expect(await dependencies.objectStore.get(firstPath)).not.toBeNull();
    expect(await dependencies.objectStore.get(secondPath)).not.toBeNull();
    expect(
      dependencies.observationRecorder.observations.map(
        (observation) => observation.rawPayloadRef
      )
    ).toEqual([firstPath, secondPath]);
    expect(result.metrics).toMatchObject({ changed: 1, new: 1 });
  });

  it("counts a replayed observation only once per executor invocation", async () => {
    const dependencies = runDependencies("run-same-invocation-replay");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-same-invocation-replay",
      bronSlug: "same-invocation-replay",
      connector: {
        bronId: "bron-same-invocation-replay",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [
              {
                bronReferentie: "REF-1",
                contentHash:
                  "1111111111111111111111111111111111111111111111111111111111111111",
              },
              {
                bronReferentie: "REF-1",
                contentHash:
                  "1111111111111111111111111111111111111111111111111111111111111111",
              },
            ],
          }),
        fetch: (item) =>
          Promise.resolve({
            body: new TextEncoder().encode(item.contentHash),
            bronReferentie: item.bronReferentie,
            contentHash: item.contentHash,
            contentType: "json",
            status: "fetched",
          }),
      },
    });

    expect(result.metrics).toMatchObject({ changed: 0, new: 1 });
    expect(result.writtenRecords).toBe(1);
    expect(dependencies.observationRecorder.observations).toHaveLength(1);
  });

  it("scopes checkpoints by run and treats explicit null as a reset", async () => {
    const dependencies = runDependencies("run-pages");
    const key = { bronId: "bron-pages", scrapeRunId: "run-pages" };
    const receivedCheckpoints: unknown[] = [];
    const seeded = await dependencies.runLifecycleStore.start({
      key,
      mode: "reset",
      progress: {
        checkpoint: { page: 99 },
        metrics: {
          changed: 0,
          error: 0,
          found: 99,
          new: 99,
          rejected: 0,
          unchanged: 0,
        },
      },
      runKind: "poll",
      startedAt: new Date("2026-08-28T08:00:00.000Z"),
    });
    await dependencies.runLifecycleStore.checkpoint(
      key,
      {
        checkpoint: { page: 99 },
        metrics: {
          changed: 0,
          error: 0,
          found: 99,
          new: 99,
          rejected: 0,
          unchanged: 0,
        },
      },
      seeded.fenceToken
    );
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-pages",
      bronSlug: "pages",
      checkpoint: null,
      connector: {
        bronId: "bron-pages",
        discover: (checkpoint) => {
          receivedCheckpoints.push(checkpoint);
          return Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [],
          });
        },
        fetch: () => Promise.resolve(null),
      },
    });
    expect(receivedCheckpoints).toEqual([null]);
    expect(result.checkpoint).toEqual({ page: 1 });
    expect(await dependencies.runLifecycleStore.load(key)).toEqual({
      checkpoint: { page: 1 },
      metrics: {
        changed: 0,
        error: 0,
        found: 0,
        new: 0,
        rejected: 0,
        unchanged: 0,
      },
    });
    expect(
      await dependencies.runLifecycleStore.load({
        ...key,
        scrapeRunId: "other",
      })
    ).toBeNull();
  });

  it("resumes a run-scoped checkpoint when checkpoint is undefined", async () => {
    const dependencies = runDependencies("run-resume");
    const key = { bronId: "bron-resume", scrapeRunId: "run-resume" };
    const receivedCheckpoints: unknown[] = [];
    const seeded = await dependencies.runLifecycleStore.start({
      key,
      mode: "reset",
      progress: {
        checkpoint: { cursor: "resume-here" },
        metrics: {
          changed: 1,
          error: 0,
          found: 4,
          new: 2,
          rejected: 1,
          unchanged: 0,
        },
      },
      runKind: "poll",
      startedAt: new Date("2026-08-28T08:00:00.000Z"),
    });
    await dependencies.runLifecycleStore.checkpoint(
      key,
      {
        checkpoint: { cursor: "resume-here" },
        metrics: {
          changed: 1,
          error: 0,
          found: 4,
          new: 2,
          rejected: 1,
          unchanged: 0,
        },
      },
      seeded.fenceToken
    );
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-resume",
      bronSlug: "resume",
      connector: {
        bronId: "bron-resume",
        discover: (checkpoint) => {
          receivedCheckpoints.push(checkpoint);
          return Promise.resolve({
            checkpoint: { cursor: "done" },
            hasMore: false,
            items: [],
          });
        },
        fetch: () => Promise.resolve(null),
      },
    });
    expect(receivedCheckpoints).toEqual([{ cursor: "resume-here" }]);
    expect(result.metrics).toEqual({
      changed: 1,
      error: 0,
      found: 4,
      new: 2,
      rejected: 1,
      unchanged: 0,
    });
    expect(result.writtenRecords).toBe(3);
  });

  it("persists checkpoint and cumulative metrics atomically after every page", async () => {
    const dependencies = runDependencies("run-progress");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-progress",
      bronSlug: "progress",
      connector: {
        bronId: "bron-progress",
        discover: (checkpoint) => {
          const page = checkpoint?.page ?? 0;
          return Promise.resolve({
            checkpoint: { page: page + 1 },
            hasMore: page === 0,
            items: [
              {
                bronReferentie: `record-${page + 1}`,
                contentHash: String(page + 1).padStart(64, "0"),
              },
            ],
          });
        },
        fetch: (item) =>
          Promise.resolve({
            body: new Uint8Array([1]),
            bronReferentie: item.bronReferentie,
            contentHash: item.contentHash,
            contentType: "json",
            status: "fetched",
          }),
      },
    });

    const checkpoints = dependencies.runLifecycleStore.events.filter(
      (event) => event.type === "checkpoint"
    );
    expect(checkpoints).toMatchObject([
      {
        progress: {
          checkpoint: { page: 1 },
          metrics: { found: 1, new: 1 },
        },
      },
      {
        progress: {
          checkpoint: { page: 2 },
          metrics: { found: 2, new: 2 },
        },
      },
    ]);
    expect(result).toMatchObject({
      checkpoint: { page: 2 },
      metrics: { found: 2, new: 2 },
      writtenRecords: 2,
    });
  });

  it("reports a fresh, exhausted listing as complete and lists every discovered reference as observed", async () => {
    const dependencies = runDependencies("run-complete");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-complete",
      bronSlug: "tenderned",
      checkpoint: null,
      connector: {
        bronId: "bron-complete",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [
              { bronReferentie: "seen", contentHash: "a" },
              { bronReferentie: "rejected", contentHash: "b" },
              { bronReferentie: "known-hash-skip", contentHash: "c" },
            ],
          }),
        fetch: (item) => {
          if (item.bronReferentie === "rejected") {
            return Promise.resolve({
              bronReferentie: item.bronReferentie,
              reason: "listing payload missing id",
              status: "rejected" as const,
            });
          }
          if (item.bronReferentie === "known-hash-skip") {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            body: new Uint8Array([1]),
            bronReferentie: item.bronReferentie,
            contentHash:
              "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            contentType: "json" as const,
            status: "fetched" as const,
          });
        },
      },
    });
    expect(result.completeness).toEqual({ complete: true });
    expect(result.observedBronReferenties.toSorted()).toEqual([
      "known-hash-skip",
      "rejected",
      "seen",
    ]);
  });

  it("reports a run that resumed from a checkpoint as incomplete", async () => {
    const dependencies = runDependencies("run-resumed");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-resumed",
      bronSlug: "tenderned",
      checkpoint: { page: 1 },
      connector: createFakeConnector("bron-resumed"),
    });
    expect(result.completeness).toEqual({
      complete: false,
      reason: "resumed",
    });
  });

  it("reports a run whose connector hit a page cap as incomplete", async () => {
    const dependencies = runDependencies("run-truncated");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-truncated",
      bronSlug: "tenderned",
      checkpoint: null,
      connector: {
        bronId: "bron-truncated",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 40 },
            hasMore: false,
            items: [{ bronReferentie: "TN-1", contentHash: "a" }],
            truncated: true,
          }),
        fetch: () => Promise.resolve(null),
      },
    });
    expect(result.completeness).toEqual({
      complete: false,
      reason: "truncated",
    });
    expect(result.observedBronReferenties).toEqual(["TN-1"]);
  });

  it("stops at the next item when the signal aborts, keeps the page checkpoint and closes the row (CTP-490)", async () => {
    const dependencies = runDependencies("run-aborted");
    const controller = new AbortController();
    const fetched: string[] = [];
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-aborted",
      bronSlug: "tenderned",
      checkpoint: null,
      connector: {
        bronId: "bron-aborted",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: true,
            items: [
              { bronReferentie: "TN-1", contentHash: "a" },
              { bronReferentie: "TN-2", contentHash: "b" },
              { bronReferentie: "TN-3", contentHash: "c" },
            ],
          }),
        fetch: (item) => {
          fetched.push(item.bronReferentie);
          if (item.bronReferentie === "TN-2") {
            controller.abort();
          }
          return Promise.resolve(null);
        },
      },
      signal: controller.signal,
    });
    expect(fetched).toEqual(["TN-1", "TN-2"]);
    expect(result.completeness).toEqual({
      complete: false,
      reason: "aborted",
    });
    // Every reference the page listed counts as seen, fetched or not; the
    // listing itself is incomplete because more pages were never discovered.
    expect(result.observedBronReferenties).toEqual(["TN-1", "TN-2", "TN-3"]);
    expect(result.discoveryCompleteness).toEqual({
      complete: false,
      reason: "aborted",
    });
    // The interrupted page is not done, so its checkpoint does not advance.
    expect(result.checkpoint).toEqual({});
    // The row is closed (complete), never left `running` for the reaper.
    expect(
      dependencies.runLifecycleStore.events.map((event) => event.type)
    ).toEqual(["start", "checkpoint", "complete"]);
    const stored = await dependencies.runLifecycleStore.load({
      bronId: "bron-aborted",
      scrapeRunId: "run-aborted",
    });
    expect(stored?.checkpoint).toBeNull();
  });

  it("gracefully closes after an in-flight fetch aborts and preserves the page checkpoint", async () => {
    const dependencies = runDependencies("run-fetch-abort");
    const controller = new AbortController();
    let fetchStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic fetch barrier
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    const pending = runConnector({
      ...dependencies,
      bronId: "bron-fetch-abort",
      bronSlug: "tenderned",
      connector: {
        bronId: "bron-fetch-abort",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: true,
            items: [{ bronReferentie: "TN-1", contentHash: "a" }],
          }),
        fetch: (_item, signal) =>
          // oxlint-disable-next-line promise/avoid-new, promise/param-names -- controlled in-flight request
          // oxlint-disable-next-line promise/avoid-new -- controlled in-flight request
          new Promise((_resolve, reject) => {
            fetchStartedResolve?.();
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          }),
      },
      signal: controller.signal,
    });
    await fetchStarted;
    controller.abort();
    const result = await pending;
    expect(result.completeness).toEqual({
      complete: false,
      reason: "aborted",
    });
    expect(result.checkpoint).toEqual({});
    expect(
      dependencies.runLifecycleStore.events.map((event) => event.type)
    ).toEqual(["start", "checkpoint", "complete"]);
  });

  it("accepts an arbitrary signal reason from an in-flight fetch", async () => {
    const dependencies = runDependencies("run-fetch-reason");
    const controller = new AbortController();
    let fetchStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic fetch barrier
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    const pending = runConnector({
      ...dependencies,
      bronId: "bron-fetch-reason",
      bronSlug: "tenderned",
      connector: {
        bronId: "bron-fetch-reason",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: true,
            items: [{ bronReferentie: "TN-1", contentHash: "a" }],
          }),
        fetch: (_item, signal) =>
          // oxlint-disable-next-line promise/avoid-new -- controlled in-flight request
          new Promise((_resolve, reject) => {
            fetchStartedResolve?.();
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      },
      signal: controller.signal,
    });
    await fetchStarted;
    const reason = new Error("run budget elapsed");
    controller.abort(reason);
    await expect(pending).resolves.toMatchObject({
      completeness: { complete: false, reason: "aborted" },
    });
  });

  it("recognises a typed cancel fault from an aborted run signal", async () => {
    const dependencies = runDependencies("run-typed-cancel");
    const controller = new AbortController();
    let fetchStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic fetch barrier
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    const pending = runConnector({
      ...dependencies,
      bronId: "bron-typed-cancel",
      bronSlug: "tenderned",
      connector: {
        bronId: "bron-typed-cancel",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: true,
            items: [{ bronReferentie: "TN-1", contentHash: "a" }],
          }),
        fetch: (_item, signal) =>
          // oxlint-disable-next-line promise/avoid-new -- controlled in-flight request
          new Promise((_resolve, reject) => {
            fetchStartedResolve?.();
            signal?.addEventListener(
              "abort",
              () => reject(new CancelFault({ message: "request cancelled" })),
              { once: true }
            );
          }),
      },
      signal: controller.signal,
    });
    await fetchStarted;
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      completeness: { complete: false, reason: "aborted" },
    });
  });

  it("cancels retry backoff through runConnector without a second fetch", async () => {
    const dependencies = runDependencies("run-fetch-backoff-abort");
    const controller = new AbortController();
    let attempts = 0;
    let waitStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic retry barrier
    const waitStarted = new Promise<void>((resolve) => {
      waitStartedResolve = resolve;
    });
    const pending = runConnector({
      ...dependencies,
      bronId: "bron-fetch-backoff-abort",
      bronSlug: "tenderned",
      connector: {
        bronId: "bron-fetch-backoff-abort",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [{ bronReferentie: "TN-1", contentHash: "a" }],
          }),
        fetch: () => {
          attempts += 1;
          return Promise.reject(new Error("temporary fetch failure"));
        },
      },
      retryPolicy: {
        ...retryPolicy,
        initialDelayMs: 1000,
        maxAttempts: 3,
        maxDelayMs: 1000,
      },
      signal: controller.signal,
      wait: (milliseconds, signal) => {
        waitStartedResolve?.();
        return sleep(milliseconds, signal);
      },
    });
    await waitStarted;
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      completeness: { complete: false, reason: "aborted" },
    });
    expect(attempts).toBe(1);
  });

  it("propagates ownership loss during abort cleanup without calling fail", async () => {
    for (const phase of ["checkpoint", "complete"] as const) {
      const base = runDependencies(`run-abort-owner-${phase}`);
      const baseStore = base.runLifecycleStore;
      let failCalls = 0;
      const runLifecycleStore: RunLifecycleStore = {
        checkpoint: (key, progress, fenceToken) =>
          phase === "checkpoint"
            ? Promise.reject(new RunOwnershipLostError())
            : baseStore.checkpoint(key, progress, fenceToken),
        complete: (input) =>
          phase === "complete"
            ? Promise.reject(new RunOwnershipLostError())
            : baseStore.complete(input),
        fail: (input) => {
          failCalls += 1;
          return baseStore.fail(input);
        },
        load: (key) => baseStore.load(key),
        start: (input) => baseStore.start(input),
      };
      const controller = new AbortController();
      let fetchStartedResolve: (() => void) | undefined;
      // oxlint-disable-next-line promise/avoid-new -- deterministic fetch barrier
      const fetchStarted = new Promise<void>((resolve) => {
        fetchStartedResolve = resolve;
      });
      const pending = runConnector({
        ...base,
        bronId: `bron-abort-owner-${phase}`,
        bronSlug: "tenderned",
        connector: {
          bronId: `bron-abort-owner-${phase}`,
          discover: () =>
            Promise.resolve({
              checkpoint: { page: 1 },
              hasMore: true,
              items: [{ bronReferentie: "TN-1", contentHash: "a" }],
            }),
          fetch: (_item, signal) =>
            // oxlint-disable-next-line promise/avoid-new -- controlled in-flight request
            new Promise((_resolve, reject) => {
              fetchStartedResolve?.();
              if (signal?.aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true }
              );
            }),
        },
        runLifecycleStore,
        signal: controller.signal,
      });
      // oxlint-disable-next-line no-await-in-loop -- each phase must reach its in-flight abort boundary
      await fetchStarted;
      controller.abort();
      // oxlint-disable-next-line no-await-in-loop -- each phase asserts its own ownership outcome
      await expect(pending).rejects.toBeInstanceOf(RunOwnershipLostError);
      expect(failCalls).toBe(0);
    }
  });

  it("gracefully closes after an in-flight discovery aborts without retrying", async () => {
    const dependencies = runDependencies("run-discover-abort");
    const controller = new AbortController();
    let discoverCalls = 0;
    let discoverStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic discovery barrier
    const discoverStarted = new Promise<void>((resolve) => {
      discoverStartedResolve = resolve;
    });
    const pending = runConnector({
      ...dependencies,
      bronId: "bron-discover-abort",
      bronSlug: "tenderned",
      connector: {
        bronId: "bron-discover-abort",
        discover: (_checkpoint, signal) =>
          // oxlint-disable-next-line promise/avoid-new, promise/param-names -- controlled in-flight request
          new Promise((_resolve, reject) => {
            discoverCalls += 1;
            discoverStartedResolve?.();
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          }),
        fetch: () => Promise.resolve(null),
      },
      retryPolicy: { ...retryPolicy, maxAttempts: 3 },
      signal: controller.signal,
    });
    await discoverStarted;
    controller.abort();
    const result = await pending;
    expect(result.completeness).toEqual({
      complete: false,
      reason: "aborted",
    });
    expect(discoverCalls).toBe(1);
    expect(
      dependencies.runLifecycleStore.events.map((event) => event.type)
    ).toEqual(["start", "checkpoint", "complete"]);
  });

  it("keeps a raw-store failure fatal when abort races the storage write", async () => {
    const controller = new AbortController();
    let putStartedResolve: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- deterministic storage barrier
    const putStarted = new Promise<void>((resolve) => {
      putStartedResolve = resolve;
    });
    const objectStore: ObjectStore = {
      deleteExpired: () => Promise.resolve(0),
      get: () => Promise.resolve(null),
      put: () => {
        putStartedResolve?.();
        // oxlint-disable-next-line promise/avoid-new, promise/param-names -- controlled in-flight storage write
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("storage failed after abort")),
            { once: true }
          );
        });
      },
    };
    const dependencies = {
      ...runDependencies("run-raw-abort-failure"),
      objectStore,
    };
    const pending = runConnector({
      ...dependencies,
      bronId: "bron-raw-abort-failure",
      bronSlug: "tenderned",
      connector: createFakeConnector("bron-raw-abort-failure"),
      signal: controller.signal,
    });
    await putStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      envelope: {
        code: "RAW_STORE_WRITE_FAILED",
        phase: "raw-store",
      },
    });
    expect(
      dependencies.runLifecycleStore.events.map((event) => event.type)
    ).toContain("fail");
  });

  it("ignores a signal that fires after the last page was read in full", async () => {
    const dependencies = runDependencies("run-aborted-late");
    const controller = new AbortController();
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-aborted-late",
      bronSlug: "tenderned",
      checkpoint: null,
      connector: {
        bronId: "bron-aborted-late",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [{ bronReferentie: "TN-1", contentHash: "a" }],
          }),
        fetch: () => {
          controller.abort();
          return Promise.resolve(null);
        },
      },
      signal: controller.signal,
    });
    expect(result.completeness).toEqual({ complete: true });
    expect(result.checkpoint).toEqual({ page: 1 });
  });

  it("does not advance the checkpoint when a page fails", async () => {
    const dependencies = runDependencies("run-page-failure");
    const key = {
      bronId: "bron-page-failure",
      scrapeRunId: "run-page-failure",
    };
    let discoveries = 0;
    const seeded = await dependencies.runLifecycleStore.start({
      key,
      mode: "reset",
      progress: {
        checkpoint: { page: 0 },
        metrics: {
          changed: 0,
          error: 0,
          found: 0,
          new: 0,
          rejected: 0,
          unchanged: 0,
        },
      },
      runKind: "poll",
      startedAt: new Date("2026-08-28T08:00:00.000Z"),
    });
    await dependencies.runLifecycleStore.checkpoint(
      key,
      {
        checkpoint: { page: 0 },
        metrics: {
          changed: 0,
          error: 0,
          found: 0,
          new: 0,
          rejected: 0,
          unchanged: 0,
        },
      },
      seeded.fenceToken
    );
    await expect(
      runConnector({
        ...dependencies,
        bronId: "bron-page-failure",
        bronSlug: "page-failure",
        connector: {
          bronId: "bron-page-failure",
          discover: () => {
            discoveries += 1;
            return Promise.resolve({
              checkpoint: { page: 1 },
              hasMore: false,
              items: [{ bronReferentie: "broken", contentHash: "broken" }],
            });
          },
          fetch: () => Promise.reject(new Error("page failed")),
        },
      })
    ).rejects.toThrow("Connector fetch failed");
    expect(discoveries).toBe(1);
    expect(await dependencies.runLifecycleStore.load(key)).toEqual({
      checkpoint: { page: 0 },
      metrics: {
        changed: 0,
        error: 1,
        found: 1,
        new: 0,
        rejected: 0,
        unchanged: 0,
      },
    });
  });

  it("reports new, changed, and unchanged recorder outcomes truthfully", async () => {
    const observationRecorder = new InMemoryObservationRecorder();
    const runOnce = (scrapeRunId: ScrapeRunId, contentHash: string) => {
      const dependencies = runDependencies(scrapeRunId);
      return runConnector({
        ...dependencies,
        bronId: "bron-metrics",
        bronSlug: "metrics",
        connector: {
          ...createFakeConnector("bron-metrics"),
          fetch: (item) =>
            Promise.resolve({
              body: new Uint8Array([1]),
              bronReferentie: item.bronReferentie,
              contentHash,
              contentType: "json",
              status: "fetched",
            }),
        },
        observationRecorder,
      });
    };
    const created = await runOnce(
      "run-new",
      "1111111111111111111111111111111111111111111111111111111111111111"
    );
    expect(created.metrics.new).toBe(1);
    const unchanged = await runOnce(
      "run-unchanged",
      "1111111111111111111111111111111111111111111111111111111111111111"
    );
    expect(unchanged.metrics).toMatchObject({
      changed: 0,
      new: 0,
      unchanged: 1,
    });
    expect(unchanged.writtenRecords).toBe(0);
    const changed = await runOnce(
      "run-changed",
      "2222222222222222222222222222222222222222222222222222222222222222"
    );
    expect(changed.metrics).toMatchObject({ changed: 1, new: 0 });
    expect(changed.writtenRecords).toBe(1);
  });

  it("distinguishes connector rejection from skipped no-detail", async () => {
    const dependencies = runDependencies("run-fetch-outcomes");
    const result = await runConnector({
      ...dependencies,
      bronId: "bron-fetch-outcomes",
      bronSlug: "fetch-outcomes",
      connector: {
        bronId: "bron-fetch-outcomes",
        discover: () =>
          Promise.resolve({
            checkpoint: { page: 1 },
            hasMore: false,
            items: [
              { bronReferentie: "reject", contentHash: "reject" },
              { bronReferentie: "skip", contentHash: "skip" },
            ],
          }),
        fetch: (item) =>
          Promise.resolve(
            item.bronReferentie === "reject"
              ? {
                  bronReferentie: item.bronReferentie,
                  reason: "invalid source payload",
                  status: "rejected" as const,
                }
              : null
          ),
      },
    });

    expect(result.metrics).toMatchObject({ found: 2, new: 0, rejected: 1 });
    expect(result.writtenRecords).toBe(0);
    expect(dependencies.observationRecorder.records).toHaveLength(0);
  });

  it("persists terminal failure with an error metric", async () => {
    const dependencies = runDependencies("run-failure");
    await expect(
      runConnector({
        ...dependencies,
        bronId: "bron-failure",
        bronSlug: "failure",
        connector: {
          bronId: "bron-failure",
          discover: () => Promise.reject(new Error("source unavailable")),
          fetch: () => Promise.resolve(null),
        },
      })
    ).rejects.toThrow("Connector discovery failed");
    expect(
      dependencies.runLifecycleStore.events.find(
        (event) => event.type === "fail"
      )
    ).toMatchObject({
      input: { progress: { metrics: { error: 1 } } },
      type: "fail",
    });
  });

  it("preserves the connector error when failure persistence also fails", async () => {
    const baseStore = new InMemoryRunLifecycleStore();
    const persistenceError = new Error("failure persistence unavailable");
    const connectorError = new Error("connector unavailable");
    const runLifecycleStore: RunLifecycleStore = {
      checkpoint: (key, progress, fenceToken) =>
        baseStore.checkpoint(key, progress, fenceToken),
      complete: (input) => baseStore.complete(input),
      fail: () => Promise.reject(persistenceError),
      load: (key) => baseStore.load(key),
      start: (input) => baseStore.start(input),
    };
    const dependencies = runDependencies("run-double-failure");
    let caught: unknown;
    try {
      await runConnector({
        ...dependencies,
        bronId: "bron-double-failure",
        bronSlug: "double-failure",
        connector: {
          bronId: "bron-double-failure",
          discover: () => Promise.reject(connectorError),
          fetch: () => Promise.resolve(null),
        },
        runLifecycleStore,
      });
    } catch (error) {
      caught = error;
    }

    if (!(caught instanceof AggregateError)) {
      throw new Error("Expected AggregateError");
    }
    expect(caught.message).toBe(
      "Connector run failed and failure persistence also failed"
    );
    if (!(caught.cause instanceof ConnectorRunFailure)) {
      throw new Error("Expected connector failure as cause");
    }
    expect(caught.cause.cause).toBe(connectorError);
    const errorMessages: string[] = [];
    for (const aggregateError of caught.errors) {
      if (!(aggregateError instanceof Error)) {
        throw new Error("Expected Error in AggregateError");
      }
      errorMessages.push(aggregateError.message);
    }
    expect(errorMessages).toEqual([
      "Connector discovery failed",
      "failure persistence unavailable",
    ]);
  });

  it("uses canonical provenance but a fresh retention clock after resume", async () => {
    const dependencies = runDependencies("run-canonical-time");
    const originalStartedAt = new Date("2026-08-20T08:00:00.000Z");
    await dependencies.runLifecycleStore.start({
      key: {
        bronId: "bron-canonical-time",
        scrapeRunId: "run-canonical-time",
      },
      mode: "reset",
      progress: {
        checkpoint: null,
        metrics: {
          changed: 0,
          error: 0,
          found: 0,
          new: 0,
          rejected: 0,
          unchanged: 0,
        },
      },
      runKind: "poll",
      startedAt: originalStartedAt,
    });

    const writeTime = new Date("2026-08-29T12:00:00.000Z");
    await runConnector({
      ...dependencies,
      bronId: "bron-canonical-time",
      bronSlug: "canonical-time",
      connector: createFakeConnector("bron-canonical-time"),
      rawRetentionDays: 1,
      startedAt: new Date("2026-08-29T12:00:00.000Z"),
      writeNow: () => writeTime,
    });

    const rawPath =
      "raw/canonical-time/2026/08/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.json";
    const storedObject = await dependencies.objectStore.get(rawPath);
    expect(storedObject).not.toBeNull();
    expect(storedObject?.expiresAt).toEqual(
      new Date("2026-08-30T12:00:00.000Z")
    );
    expect(dependencies.observationRecorder.observations[0]?.observedAt).toBe(
      originalStartedAt.toISOString()
    );
    expect(
      dependencies.observationRecorder.observations[0]?.rawPayloadRef
    ).toBe(rawPath);
  });

  it("replays the original atomic outcome after a crash before page progress", async () => {
    const baseStore = new InMemoryRunLifecycleStore();
    const observationRecorder = new InMemoryObservationRecorder();
    const dependencies = runDependencies("run-replay");
    const crashingStore: RunLifecycleStore = {
      checkpoint: () =>
        Promise.reject(new Error("process lost checkpoint ack")),
      complete: (input) => baseStore.complete(input),
      fail: () => Promise.reject(new Error("process terminated")),
      load: (key) => baseStore.load(key),
      start: (input) => baseStore.start(input),
    };
    const input = {
      ...dependencies,
      bronId: "bron-replay",
      bronSlug: "replay",
      connector: createFakeConnector("bron-replay"),
      observationRecorder,
    };

    await expect(
      runConnector({ ...input, runLifecycleStore: crashingStore })
    ).rejects.toThrow(
      "Connector run failed and failure persistence also failed"
    );
    expect(observationRecorder.observations).toHaveLength(1);

    const replayed = await runConnector({
      ...input,
      runLifecycleStore: baseStore,
    });
    expect(replayed.metrics).toMatchObject({ changed: 0, new: 1 });
    expect(replayed.writtenRecords).toBe(1);
    expect(observationRecorder.observations).toHaveLength(1);
  });

  it("adds retention metadata and emits the stable observation contract", async () => {
    const dependencies = runDependencies("run-observation");
    await runConnector({
      ...dependencies,
      bronId: "bron-tenderned",
      bronSlug: "generic",
      connector: createFakeConnector("bron-tenderned"),
      rawRetentionDays: 1,
      startedAt: new Date("2026-08-28T10:15:00.000Z"),
      writeNow: () => new Date("2026-08-28T10:15:00.000Z"),
    });
    expect(dependencies.observationRecorder.observations).toHaveLength(1);
    expect(dependencies.observationRecorder.observations[0]).toMatchObject({
      contractVersion: "connector-observation/v1",
      observedAt: "2026-08-28T10:15:00.000Z",
      sourceRecordId: "bron-tenderned:TN-100",
    });
    expect(
      await dependencies.objectStore.deleteExpired(
        new Date("2026-08-29T10:15:00.000Z")
      )
    ).toBe(1);
  });
});
