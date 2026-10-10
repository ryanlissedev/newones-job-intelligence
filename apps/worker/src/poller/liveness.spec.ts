import { describe, expect, it } from "bun:test";

import { LockLostError } from "@ji/db/process-lock";

import { runWithPollerLiveness } from "./liveness";

const options = (
  overrides: Partial<Parameters<typeof runWithPollerLiveness>[0]> = {}
) => ({
  heartbeat: () => Promise.resolve(),
  intervalMs: 5,
  lockKey: 613_204_877,
  lockReassert: () => Promise.resolve(true),
  onLockLoss: () => {},
  signal: new AbortController().signal,
  ...overrides,
});

describe("poller liveness", () => {
  it("keeps the process heartbeat running while the poll loop is busy", async () => {
    let heartbeats = 0;
    const heartbeatsReady = Promise.withResolvers<null>();
    const busy = Promise.withResolvers<null>();

    const running = runWithPollerLiveness(
      options({
        heartbeat: () => {
          heartbeats += 1;
          if (heartbeats >= 2) {
            heartbeatsReady.resolve(null);
          }
          return Promise.resolve();
        },
      }),
      async () => {
        await busy.promise;
        return "done";
      }
    );

    await heartbeatsReady.promise;
    expect(heartbeats).toBeGreaterThanOrEqual(2);
    busy.resolve(null);
    await expect(running).resolves.toBe("done");
  });

  it("aborts and drains the poll loop when the advisory lock is lost", async () => {
    const controller = new AbortController();
    let settled = false;
    const lockLosses: Error[] = [];
    const abortObserved = Promise.withResolvers<null>();
    const deferredWrite = Promise.withResolvers<null>();
    controller.signal.addEventListener(
      "abort",
      () => {
        settled = true;
        abortObserved.resolve(null);
      },
      { once: true }
    );
    const running = runWithPollerLiveness(
      options({
        lockReassert: () => Promise.resolve(false),
        onLockLoss: (error) => {
          lockLosses.push(error);
          controller.abort(error);
        },
        signal: controller.signal,
      }),
      async () => {
        await abortObserved.promise;
        await deferredWrite.promise;
        return "drained";
      }
    );

    let completed = false;
    const completion = (async () => {
      try {
        await running;
      } catch (error) {
        completed = true;
        expect(error).toBeInstanceOf(LockLostError);
      }
    })();
    await abortObserved.promise;
    await Bun.sleep(0);
    expect(completed).toBe(false);
    deferredWrite.resolve(null);
    await completion;
    expect(completed).toBe(true);
    expect(settled).toBe(true);
    expect(lockLosses).toHaveLength(1);
  });

  it("keeps heartbeat alive while a lock probe is half-open", async () => {
    const controller = new AbortController();
    const probeStarted = Promise.withResolvers<null>();
    const probe = Promise.withResolvers<boolean>();
    const abortObserved = Promise.withResolvers<null>();
    const heartbeatReady = Promise.withResolvers<null>();
    let heartbeats = 0;
    const lockLosses: Error[] = [];
    controller.signal.addEventListener(
      "abort",
      () => abortObserved.resolve(null),
      { once: true }
    );
    const running = runWithPollerLiveness(
      options({
        heartbeat: () => {
          heartbeats += 1;
          if (heartbeats >= 2) {
            heartbeatReady.resolve(null);
          }
          return Promise.resolve();
        },
        lockReassert: () => {
          probeStarted.resolve(null);
          return probe.promise;
        },
        onLockLoss: (error) => {
          lockLosses.push(error);
          controller.abort(error);
        },
        signal: controller.signal,
      }),
      async () => {
        await abortObserved.promise;
        return "drained";
      }
    );

    await probeStarted.promise;
    await heartbeatReady.promise;
    expect(heartbeats).toBeGreaterThanOrEqual(2);
    expect(lockLosses).toHaveLength(0);
    probe.reject(new Error("half-open lock probe"));

    await expect(running).rejects.toThrow("half-open lock probe");
    expect(lockLosses).toHaveLength(1);
  });

  it("waits for an in-flight lock probe before releasing its scope", async () => {
    const probeStarted = Promise.withResolvers<null>();
    const probe = Promise.withResolvers<boolean>();
    const running = runWithPollerLiveness(
      options({
        lockReassert: () => {
          probeStarted.resolve(null);
          return probe.promise;
        },
      }),
      async () => {
        await probeStarted.promise;
        return "done";
      }
    );

    await probeStarted.promise;
    let completed = false;
    const completion = (async () => {
      await running;
      completed = true;
    })();
    await Bun.sleep(0);
    expect(completed).toBe(false);
    probe.resolve(true);
    await completion;
    expect(completed).toBe(true);
  });
  it("keeps heartbeat and lock checks independent of a pending telemetry write", async () => {
    const telemetry = Promise.withResolvers<null>();
    const telemetryStarted = Promise.withResolvers<null>();
    const checksReady = Promise.withResolvers<null>();
    const heartbeatReady = Promise.withResolvers<null>();
    const sourceFinished = Promise.withResolvers<null>();
    let checks = 0;
    let beats = 0;
    let writes = 0;
    const running = runWithPollerLiveness(
      options({
        heartbeat: () => {
          beats += 1;
          if (beats >= 2) {
            heartbeatReady.resolve(null);
          }
          return Promise.resolve();
        },
        onLockVerified: () => {
          checks += 1;
          if (checks >= 2) {
            checksReady.resolve(null);
          }
        },
        recordTelemetry: async () => {
          writes += 1;
          telemetryStarted.resolve(null);
          await telemetry.promise;
        },
      }),
      async () => {
        await telemetryStarted.promise;
        await checksReady.promise;
        await heartbeatReady.promise;
        sourceFinished.resolve(null);
        return "done";
      }
    );
    await sourceFinished.promise;
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(writes).toBe(1);
    let completed = false;
    const completion = running.then((value) => {
      completed = true;
      return value;
    });
    await Bun.sleep(0);
    expect(completed).toBe(false);
    telemetry.resolve(null);
    await expect(completion).resolves.toBe("done");
  });
  it("resumes telemetry after an ordinary write rejection", async () => {
    let writes = 0;
    const recovered = Promise.withResolvers<null>();
    const errors: unknown[] = [];
    const failure = new Error("database temporarily unavailable");
    const result = await runWithPollerLiveness(
      options({
        onTelemetryError: (error) => {
          errors.push(error);
        },
        recordTelemetry: () => {
          writes += 1;
          if (writes === 1) {
            return Promise.reject(failure);
          }
          recovered.resolve(null);
          return Promise.resolve();
        },
      }),
      async () => {
        await recovered.promise;
        return "done";
      }
    );
    expect(result).toBe("done");
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([failure]);
  });
});
