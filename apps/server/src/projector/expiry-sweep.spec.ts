import { describe, expect, it } from "bun:test";

import {
  createSearchExpirySweepRunner,
  parseSearchExpirySweepConfig,
} from "./expiry-sweep";
import type { SearchExpirySweepLog } from "./expiry-sweep";

describe("search expiry sweep configuration", () => {
  it("defaults to off and the documented bounds", () => {
    expect(parseSearchExpirySweepConfig({})).toEqual({
      batchSize: 200,
      intervalMs: 900_000,
      maxPerRun: 2000,
      mode: "off",
    });
  });

  it("rejects an invalid mode and too-short interval", () => {
    expect(() =>
      parseSearchExpirySweepConfig({ SEARCH_EXPIRY_SWEEP_MODE: "bogus" })
    ).toThrow("SEARCH_EXPIRY_SWEEP_MODE");
    expect(() =>
      parseSearchExpirySweepConfig({ SEARCH_EXPIRY_SWEEP_INTERVAL_MS: "59999" })
    ).toThrow("at least 60000");
    expect(() =>
      parseSearchExpirySweepConfig({ SEARCH_EXPIRY_SWEEP_BATCH_SIZE: "1001" })
    ).toThrow("SEARCH_EXPIRY_SWEEP_BATCH_SIZE");
    expect(() =>
      parseSearchExpirySweepConfig({ SEARCH_EXPIRY_SWEEP_MAX_PER_RUN: "10001" })
    ).toThrow("SEARCH_EXPIRY_SWEEP_MAX_PER_RUN");
  });
});

describe("search expiry sweep runner", () => {
  it("does not schedule work when disabled", async () => {
    let calls = 0;
    const runner = createSearchExpirySweepRunner({
      config: { batchSize: 1, intervalMs: 60_000, maxPerRun: 1, mode: "off" },
      log: () => {},
      sweep: () => {
        calls += 1;
        return Promise.resolve({
          batches: 1,
          candidates: 1,
          capped: false,
          enqueued: 0,
          mode: "dry-run",
          sampleIds: [],
          skippedPending: 0,
        });
      },
    });
    runner.start();
    await Bun.sleep(5);
    await runner.stop();
    expect(calls).toBe(0);
  });

  it("stop awaits the in-flight run", async () => {
    const started = Promise.withResolvers<true>();
    const release = Promise.withResolvers<true>();
    const runner = createSearchExpirySweepRunner({
      config: { batchSize: 1, intervalMs: 1, maxPerRun: 1, mode: "dry-run" },
      log: () => {},
      sweep: async () => {
        started.resolve(true);
        await release.promise;
        return {
          batches: 1,
          candidates: 1,
          capped: false,
          enqueued: 0,
          mode: "dry-run" as const,
          sampleIds: [],
          skippedPending: 0,
        };
      },
    });
    runner.start();
    await started.promise;
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(2);
    expect(stopped).toBe(false);
    release.resolve(true);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("logs a thrown sweep with a bounded message and runs the next tick", async () => {
    const logs: SearchExpirySweepLog[] = [];
    const secondTick = Promise.withResolvers<true>();
    let calls = 0;
    const runner = createSearchExpirySweepRunner({
      config: { batchSize: 1, intervalMs: 1, maxPerRun: 1, mode: "dry-run" },
      log: (fields) => logs.push(fields),
      sweep: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            new Error(`postgresql://secret@example.test/db ${"x".repeat(500)}`)
          );
        }
        secondTick.resolve(true);
        return Promise.resolve({
          batches: 1,
          candidates: 1,
          capped: false,
          enqueued: 0,
          mode: "dry-run" as const,
          sampleIds: [],
          skippedPending: 0,
        });
      },
    });
    runner.start();
    await secondTick.promise;
    await runner.stop();
    const errorLog = logs.find((log) => log.errorName === "Error");
    expect(errorLog?.message).toHaveLength(300);
    expect(errorLog?.message).not.toContain("postgresql://");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("logs when a sweep is skipped because its lock is held", async () => {
    const logged = Promise.withResolvers<SearchExpirySweepLog>();
    const runner = createSearchExpirySweepRunner({
      config: { batchSize: 1, intervalMs: 1, maxPerRun: 1, mode: "dry-run" },
      log: (fields) => logged.resolve(fields),
      sweep: () =>
        Promise.resolve({
          batches: 0,
          candidates: 0,
          capped: false,
          enqueued: 0,
          mode: "dry-run" as const,
          sampleIds: [],
          skipped: "lock_held" as const,
          skippedPending: 0,
        }),
    });
    runner.start();
    const log = await logged.promise;
    await runner.stop();

    expect(log).toMatchObject({
      batches: 0,
      candidates: 0,
      skipped: "lock_held",
    });
  });
});
