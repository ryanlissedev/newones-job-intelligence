import { describe, expect, it } from "bun:test";

import {
  emptyMarkeringReadbackState,
  hasNewerMarkering,
  markeringMutationOutcome,
  mergeMarkeringReadback,
  startMarkeringPolling,
} from "./markering-sync";
import { CapabilityRequestError } from "./rest/capability-client";
import type { JobMarkering } from "./types";

const marker = (
  revision: number,
  status: JobMarkering["status"] = "relevant"
) =>
  ({
    reden: null,
    revision,
    status,
    updatedAt: `2026-09-05T00:00:0${revision}.000Z`,
  }) satisfies JobMarkering;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createEnvironment = () => {
  let visibilityState: Document["visibilityState"] = "visible";
  let listener: (() => void) | null = null;
  let nextInterval = 0;
  let nextTimeout = 0;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  return {
    clock: {
      clearInterval: (interval: number) => {
        intervals.delete(interval);
      },
      clearTimeout: (timeout: number) => {
        timeouts.delete(timeout);
      },
      setInterval: (handler: () => void) => {
        const interval = nextInterval;
        nextInterval += 1;
        intervals.set(interval, handler);
        return interval;
      },
      setTimeout: (handler: () => void) => {
        const timeout = nextTimeout;
        nextTimeout += 1;
        timeouts.set(timeout, handler);
        return timeout;
      },
    },
    intervals,
    get listener() {
      return listener;
    },
    runTimeout: () => {
      const timeout = timeouts.entries().next().value;
      if (timeout) {
        timeouts.delete(timeout[0]);
        timeout[1]();
      }
    },
    setVisibility: (next: Document["visibilityState"]) => {
      visibilityState = next;
      listener?.();
    },
    timeouts,
    visibility: {
      addEventListener: (_type: "visibilitychange", next: () => void) => {
        listener = next;
      },
      removeEventListener: () => {
        listener = null;
      },
      get visibilityState() {
        return visibilityState;
      },
    },
  };
};

describe("bounded markering readback", () => {
  it("applies only newer resource versions and makes repeats idempotent", () => {
    const current = marker(2);
    expect(hasNewerMarkering(current, marker(1, "gevolgd"))).toBe(false);
    expect(hasNewerMarkering(current, marker(2))).toBe(false);
    expect(hasNewerMarkering(current, marker(3, "gevolgd"))).toBe(true);
  });

  it("classifies known rejection separately from post-commit uncertainty", () => {
    const rejected = new CapabilityRequestError(403, {
      error: { code: "FORBIDDEN", message: "denied" },
    });
    const unavailable = new CapabilityRequestError(503, {
      error: { code: "UNAVAILABLE", message: "retry" },
    });
    expect(markeringMutationOutcome(rejected)).toBe("failure");
    expect(markeringMutationOutcome(unavailable)).toBe("uncertain");
    expect(markeringMutationOutcome(new TypeError("network"))).toBe(
      "uncertain"
    );

    for (const status of [408, 409, 429]) {
      expect(
        markeringMutationOutcome(
          new CapabilityRequestError(status, {
            error: { code: "RETRYABLE", message: "try again" },
          })
        )
      ).toBe("uncertain");
    }
  });

  it("keeps a polled revision over a late detail response and a clear", () => {
    let state = emptyMarkeringReadbackState();
    state = mergeMarkeringReadback(state, marker(3), "poll");
    state = mergeMarkeringReadback(state, null, "poll");
    state = mergeMarkeringReadback(state, marker(2, "gevolgd"), "detail");
    expect(state.markering).toBeNull();
    state = mergeMarkeringReadback(state, marker(4, "gevolgd"), "poll");
    expect(state.markering).toMatchObject({ revision: 4, status: "gevolgd" });
  });

  it("does not let a late detail null erase a polled marker at the same revision", () => {
    let state = emptyMarkeringReadbackState();
    state = mergeMarkeringReadback(state, marker(3), "poll");
    state = mergeMarkeringReadback(state, null, "detail");
    expect(state.markering).toMatchObject(marker(3));

    state = mergeMarkeringReadback(state, marker(3), "poll");
    expect(state.markering).toMatchObject(marker(3));
  });

  it("does not let a first poll clear resurrect an older detail marker", () => {
    let state = emptyMarkeringReadbackState();
    state = mergeMarkeringReadback(state, null, "poll");
    state = mergeMarkeringReadback(state, marker(1), "detail");
    expect(state.markering).toBeNull();

    state = mergeMarkeringReadback(state, marker(2, "gevolgd"), "poll");
    expect(state.markering).toMatchObject({ revision: 2, status: "gevolgd" });
  });
});

describe("bounded markering polling", () => {
  it("polls on the interval, reconnects on visibility, and cleans up", async () => {
    const environment = createEnvironment();
    const reads: string[] = [];
    const releases: ((value: JobMarkering | null) => void)[] = [];
    const stop = startMarkeringPolling({
      clock: environment.clock,
      getMarkering: (resourceId) => {
        reads.push(resourceId);
        const pending = Promise.withResolvers<JobMarkering | null>();
        releases.push(pending.resolve);
        return pending.promise;
      },
      onMarkering: () => {},
      resourceId: "job-1",
      visibility: environment.visibility,
    });

    expect(reads).toEqual(["job-1"]);
    releases.shift()?.(marker(1));
    await flush();
    environment.intervals.values().next().value?.();
    expect(reads).toEqual(["job-1", "job-1"]);
    releases.shift()?.(marker(2));
    await flush();

    environment.setVisibility("hidden");
    environment.intervals.values().next().value?.();
    expect(reads).toHaveLength(2);
    environment.setVisibility("visible");
    expect(reads).toHaveLength(3);
    releases.shift()?.(marker(3));
    await flush();

    stop();
    expect(environment.listener).toBeNull();
    expect(environment.intervals.size).toBe(0);
  });

  it("does not apply an in-flight read after a resource switch cleanup", async () => {
    const environment = createEnvironment();
    const pending = Promise.withResolvers<JobMarkering | null>();
    const applied: (JobMarkering | null)[] = [];
    const stop = startMarkeringPolling({
      clock: environment.clock,
      getMarkering: () => pending.promise,
      onMarkering: (markering) => applied.push(markering),
      resourceId: "old-job",
      visibility: environment.visibility,
    });

    stop();
    pending.resolve(marker(5));
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([]);
  });

  it("swallows a read failure and allows the next poll to retry", async () => {
    const environment = createEnvironment();
    const applied: (JobMarkering | null)[] = [];
    let attempts = 0;
    const stop = startMarkeringPolling({
      clock: environment.clock,
      getMarkering: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary read failure");
        }
        return marker(2);
      },
      onMarkering: (markering) => applied.push(markering),
      resourceId: "job-1",
      visibility: environment.visibility,
    });

    await Promise.resolve();
    await Promise.resolve();
    environment.intervals.values().next().value?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(applied).toEqual([marker(2)]);
    stop();
  });

  it("aborts a hanging read and releases the next poll slot after timeout", async () => {
    const environment = createEnvironment();
    const pending: PromiseWithResolvers<JobMarkering | null>[] = [];
    const signals: AbortSignal[] = [];
    const stop = startMarkeringPolling({
      clock: environment.clock,
      getMarkering: (_resourceId, signal) => {
        signals.push(signal);
        const next = Promise.withResolvers<JobMarkering | null>();
        pending.push(next);
        return next.promise;
      },
      onMarkering: () => {},
      resourceId: "job-1",
      timeoutMs: 10,
      visibility: environment.visibility,
    });

    expect(signals).toHaveLength(1);
    environment.runTimeout();
    await flush();
    expect(signals[0]?.aborted).toBe(true);

    environment.intervals.values().next().value?.();
    expect(signals).toHaveLength(2);
    stop();
    expect(signals[1]?.aborted).toBe(true);
    expect(pending).toHaveLength(2);
  });

  it("keeps a newer revision when a later read is older", async () => {
    const environment = createEnvironment();
    const applied: (JobMarkering | null)[] = [];
    let latest: JobMarkering | null = null;
    let reads = 0;
    const stop = startMarkeringPolling({
      clock: environment.clock,
      getMarkering: () => {
        reads += 1;
        return reads === 1 ? marker(3) : marker(2, "gevolgd");
      },
      onMarkering: (next) => {
        if (hasNewerMarkering(latest, next)) {
          latest = next;
          applied.push(next);
        }
      },
      resourceId: "job-1",
      visibility: environment.visibility,
    });

    await Promise.resolve();
    await Promise.resolve();
    environment.intervals.values().next().value?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([marker(3)]);
    stop();
  });
});
