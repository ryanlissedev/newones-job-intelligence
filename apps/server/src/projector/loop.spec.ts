import { describe, expect, it } from "bun:test";

import { LockLostError } from "@ji/db/process-lock";
import { SearchIndexSchemaMismatchError } from "@ji/search";

import type { ProjectorCycleLog, ProjectorDrainResult } from "./loop";
import { runProjectorLoop } from "./loop";

const POLL_INTERVAL_MS = 10;
const MAX_BACKOFF_MS = 80;

const sleep = (ms: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- timers have no promise API
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("runProjectorLoop (RJC-387)", () => {
  it("loops immediately without sleeping while a cycle drains rows", async () => {
    const controller = new AbortController();
    // Third result is drained: 0, which stops the immediate-loop condition
    // and makes runProjectorLoop wait pollIntervalMs before calling drain
    // again — that fourth call is where the test aborts, so it runs (and
    // gets logged) too before the loop's next `while (!signal.aborted)`
    // check stops it.
    const results: ProjectorDrainResult[] = [
      { drained: 3, indexVersion: 3 },
      { drained: 2, indexVersion: 5 },
      { drained: 0, indexVersion: 5 },
    ];
    const logs: ProjectorCycleLog[] = [];

    const drain = (): Promise<ProjectorDrainResult> => {
      const next = results.shift();
      if (!next) {
        controller.abort();
        return Promise.resolve({ drained: 0, indexVersion: 5 });
      }
      return Promise.resolve(next);
    };

    await runProjectorLoop({
      drain,
      maxBackoffMs: MAX_BACKOFF_MS,
      onCycle: (log) => logs.push(log),
      pollIntervalMs: POLL_INTERVAL_MS,
      signal: controller.signal,
    });

    expect(logs.map((log) => log.drained)).toEqual([3, 2, 0, 0]);
  });

  it("waits pollIntervalMs after a cycle drains nothing", async () => {
    const controller = new AbortController();
    let calls = 0;
    const timestamps: number[] = [];

    const drain = (): Promise<ProjectorDrainResult> => {
      calls += 1;
      timestamps.push(Date.now());
      if (calls >= 3) {
        controller.abort();
      }
      return Promise.resolve({ drained: 0, indexVersion: null });
    };

    await runProjectorLoop({
      drain,
      maxBackoffMs: MAX_BACKOFF_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      signal: controller.signal,
    });

    expect(calls).toBe(3);
    expect(timestamps).toHaveLength(3);
    // SAFETY: length asserted above as exactly 3, so all three indices exist.
    const [first, second, third] = timestamps as [number, number, number];
    expect(second - first).toBeGreaterThanOrEqual(POLL_INTERVAL_MS - 2);
    expect(third - second).toBeGreaterThanOrEqual(POLL_INTERVAL_MS - 2);
  });

  it("doubles the backoff on repeated transient errors, capped at maxBackoffMs, then keeps going", async () => {
    const controller = new AbortController();
    const logs: ProjectorCycleLog[] = [];
    let calls = 0;

    const drain = (): Promise<ProjectorDrainResult> => {
      calls += 1;
      if (calls <= 4) {
        return Promise.reject(new Error(`transient failure ${calls}`));
      }
      controller.abort();
      return Promise.resolve({ drained: 0, indexVersion: null });
    };

    const start = Date.now();
    await runProjectorLoop({
      drain,
      maxBackoffMs: MAX_BACKOFF_MS,
      onCycle: (log) => logs.push(log),
      pollIntervalMs: POLL_INTERVAL_MS,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(calls).toBe(5);
    expect(logs.filter((log) => log.errorName === "Error")).toHaveLength(4);
    // Backoff sequence: 10, 20, 40, 80(capped) — sum 150ms minimum.
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it("rejects immediately on SearchIndexSchemaMismatchError instead of retrying", async () => {
    const controller = new AbortController();
    let calls = 0;

    const drain = (): Promise<ProjectorDrainResult> => {
      calls += 1;
      return Promise.reject(
        new SearchIndexSchemaMismatchError("old-hash", "new-hash")
      );
    };

    await expect(
      runProjectorLoop({
        drain,
        maxBackoffMs: MAX_BACKOFF_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(SearchIndexSchemaMismatchError);

    expect(calls).toBe(1);
  });

  it("stops on a lock-heartbeat that returns false, without retrying", async () => {
    const controller = new AbortController();
    let cycle = 0;
    const HEARTBEAT_LOST_AT_CYCLE = 3;

    const drain = (): Promise<ProjectorDrainResult> => {
      cycle += 1;
      const heartbeatOk = cycle < HEARTBEAT_LOST_AT_CYCLE;
      if (!heartbeatOk) {
        return Promise.reject(new LockLostError(847_732_991));
      }
      return Promise.resolve({ drained: 0, indexVersion: cycle });
    };

    await expect(
      runProjectorLoop({
        drain,
        maxBackoffMs: MAX_BACKOFF_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(LockLostError);

    // Cycles 1 and 2 passed the heartbeat; cycle 3 lost it and stopped —
    // no cycle 4 (no retry after a lost lock).
    expect(cycle).toBe(3);
  });

  it("returns promptly when aborted mid-sleep", async () => {
    const controller = new AbortController();
    let calls = 0;

    const drain = (): Promise<ProjectorDrainResult> => {
      calls += 1;
      return Promise.resolve({ drained: 0, indexVersion: null });
    };

    const loopPromise = runProjectorLoop({
      drain,
      maxBackoffMs: MAX_BACKOFF_MS,
      // Long enough that a real wait would fail the test's own timeout.
      pollIntervalMs: 5000,
      signal: controller.signal,
    });

    await sleep(5);
    const abortedAt = Date.now();
    controller.abort();
    await loopPromise;

    expect(Date.now() - abortedAt).toBeLessThan(200);
    expect(calls).toBe(1);
  });

  it("finishes an in-flight cycle before returning when aborted mid-drain", async () => {
    const controller = new AbortController();
    let cycleFinished = false;

    const drain = async (): Promise<ProjectorDrainResult> => {
      controller.abort();
      await sleep(20);
      cycleFinished = true;
      return { drained: 0, indexVersion: null };
    };

    await runProjectorLoop({
      drain,
      maxBackoffMs: MAX_BACKOFF_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      signal: controller.signal,
    });

    expect(cycleFinished).toBe(true);
  });

  it("returns once and does not throw when the signal is aborted twice", async () => {
    // Mirrors main.ts's repeated-SIGTERM guard at the AbortSignal level:
    // aborting an already-aborted controller is a no-op in the DOM spec, and
    // the loop must not treat a second abort as anything other than "still
    // aborted".
    const controller = new AbortController();
    let calls = 0;

    const drain = (): Promise<ProjectorDrainResult> => {
      calls += 1;
      controller.abort();
      controller.abort();
      return Promise.resolve({ drained: 0, indexVersion: null });
    };

    await expect(
      runProjectorLoop({
        drain,
        maxBackoffMs: MAX_BACKOFF_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        signal: controller.signal,
      })
    ).resolves.toBeUndefined();

    expect(calls).toBe(1);
  });
});
