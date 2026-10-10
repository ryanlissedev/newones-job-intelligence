import { describe, expect, it } from "bun:test";

import { runContinuously, runWithConcurrency } from "./pool";

interface Tracker {
  readonly finished: string[];
  readonly maxInFlight: () => number;
  readonly started: string[];
  readonly worker: (item: string) => Promise<string>;
}

/**
 * Workers that only resolve once released, so a test decides the interleaving
 * instead of hoping the event loop produces it.
 */
const trackerWithGates = (): Tracker & {
  release: (item: string) => void;
} => {
  const started: string[] = [];
  const finished: string[] = [];
  const gates = new Map<string, () => void>();
  const releasedEarly = new Set<string>();
  let inFlight = 0;
  let peak = 0;

  const complete = (item: string, resolve: (value: string) => void): void => {
    inFlight -= 1;
    finished.push(item);
    resolve(item);
  };

  return {
    finished,
    maxInFlight: () => peak,
    // Releasing an item that has not started yet is remembered, so a test can
    // drain the whole run in one pass without knowing the interleaving.
    release: (item: string) => {
      const gate = gates.get(item);
      if (gate === undefined) {
        releasedEarly.add(item);
        return;
      }
      gate();
    },
    started,
    worker: (item: string) => {
      started.push(item);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // oxlint-disable-next-line promise/avoid-new -- the gate is released by the test, not by another promise
      return new Promise<string>((resolve) => {
        if (releasedEarly.delete(item)) {
          complete(item, resolve);
          return;
        }
        gates.set(item, () => complete(item, resolve));
      });
    },
  };
};

const immediateTracker = (): Tracker => {
  const started: string[] = [];
  const finished: string[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    finished,
    maxInFlight: () => peak,
    started,
    worker: async (item: string) => {
      started.push(item);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      finished.push(item);
      return item;
    },
  };
};

const items = ["a", "b", "c", "d"];

describe("runWithConcurrency", () => {
  it("runs strictly one at a time at limit 1", async () => {
    const tracker = immediateTracker();
    const results = await runWithConcurrency(
      items,
      1,
      tracker.worker,
      new AbortController().signal
    );

    expect(tracker.maxInFlight()).toBe(1);
    expect(tracker.started).toEqual(items);
    expect(tracker.finished).toEqual(items);
    expect(results.map((entry) => entry.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("never exceeds the limit and keeps the input as the starting order", async () => {
    const tracker = trackerWithGates();
    const run = runWithConcurrency(
      items,
      2,
      tracker.worker,
      new AbortController().signal
    );

    await Promise.resolve();
    expect(tracker.started).toEqual(["a", "b"]);
    expect(tracker.maxInFlight()).toBe(2);

    // Finishing "b" first must still hand the free slot to "c", not "d".
    tracker.release("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.started).toEqual(["a", "b", "c"]);

    for (const item of items) {
      tracker.release(item);
    }
    await run;

    expect(tracker.started).toEqual(items);
    expect(tracker.maxInFlight()).toBe(2);
  });

  it("returns results in starting order, not completion order", async () => {
    const tracker = trackerWithGates();
    const run = runWithConcurrency(
      items,
      4,
      tracker.worker,
      new AbortController().signal
    );
    await Promise.resolve();

    for (const item of items.toReversed()) {
      tracker.release(item);
    }
    const results = await run;

    expect(tracker.finished).toEqual(["d", "c", "b", "a"]);
    expect(
      results.map((entry) =>
        entry.status === "fulfilled" ? entry.value : entry.reason
      )
    ).toEqual(items);
  });

  it("stops starting new items once the signal aborts", async () => {
    const controller = new AbortController();
    const tracker = trackerWithGates();
    const run = runWithConcurrency(items, 2, tracker.worker, controller.signal);

    await Promise.resolve();
    expect(tracker.started).toEqual(["a", "b"]);

    controller.abort();
    tracker.release("a");
    tracker.release("b");
    const results = await run;

    // The two in flight finish; "c" and "d" are never started.
    expect(tracker.started).toEqual(["a", "b"]);
    expect(results).toHaveLength(2);
  });

  it("starts nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tracker = immediateTracker();

    const results = await runWithConcurrency(
      items,
      2,
      tracker.worker,
      controller.signal
    );

    expect(tracker.started).toEqual([]);
    expect(results).toEqual([]);
  });

  it("lets the other items finish when one worker rejects", async () => {
    const started: string[] = [];
    const boom = new Error("source exploded");
    const results = await runWithConcurrency(
      items,
      2,
      async (item: string) => {
        started.push(item);
        await Promise.resolve();
        if (item === "b") {
          throw boom;
        }
        return item;
      },
      new AbortController().signal
    );

    expect(started).toEqual(items);
    expect(results).toHaveLength(4);
    expect(results[1]).toEqual({ reason: boom, status: "rejected" });
    expect(
      results.filter((entry) => entry.status === "fulfilled")
    ).toHaveLength(3);
  });

  it("handles an empty list without starting a runner", async () => {
    const tracker = immediateTracker();
    const results = await runWithConcurrency(
      [],
      4,
      tracker.worker,
      new AbortController().signal
    );

    expect(results).toEqual([]);
    expect(tracker.started).toEqual([]);
  });
});

/** Polls a condition at 1 ms; used where the loop's own tick drives progress. */
const waitFor = async (condition: () => boolean): Promise<void> => {
  while (!condition()) {
    // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- timers have no promise API
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
};

describe("runContinuously", () => {
  it("starts a newly due item while a long run is still in flight", async () => {
    const controller = new AbortController();
    const longGate = Promise.withResolvers<null>();
    const shortStarted = Promise.withResolvers<null>();
    const events: string[] = [];
    let longInFlight = false;
    let shortSawLongInFlight = false;
    let dueCalls = 0;

    const scheduler = runContinuously<string>({
      concurrency: 2,
      // Tick 1 has only the long bron due; from tick 2 the short bron is
      // due too — the point is it must not wait for the long run to end.
      dueItems: () => {
        dueCalls += 1;
        return Promise.resolve(dueCalls === 1 ? ["long"] : ["short"]);
      },
      keyOf: (item) => item,
      run: async (item) => {
        events.push(`start:${item}`);
        if (item === "long") {
          longInFlight = true;
          await longGate.promise;
          longInFlight = false;
          return;
        }
        shortSawLongInFlight = longInFlight;
        shortStarted.resolve(null);
      },
      signal: controller.signal,
      tickMs: 1,
    });

    await shortStarted.promise;
    expect(events.slice(0, 2)).toEqual(["start:long", "start:short"]);
    expect(shortSawLongInFlight).toBe(true);
    expect(longInFlight).toBe(true);

    controller.abort();
    longGate.resolve(null);
    await scheduler;
  });

  it("keeps one active run per key and merges missed ticks into a single follow-up", async () => {
    const controller = new AbortController();
    const firstGate = Promise.withResolvers<null>();
    const secondStarted = Promise.withResolvers<null>();
    let dueCalls = 0;
    let runCount = 0;
    let inFlight = false;
    let overlap = false;
    let secondRunStarted = false;

    const scheduler = runContinuously<string>({
      concurrency: 2,
      // "a" stays due across every evaluation, so each tick while the first
      // run is in flight is a missed tick that must coalesce, not enqueue.
      dueItems: () => {
        dueCalls += 1;
        return Promise.resolve(secondRunStarted ? [] : ["a"]);
      },
      keyOf: (item) => item,
      run: async () => {
        runCount += 1;
        if (inFlight) {
          overlap = true;
        }
        inFlight = true;
        if (runCount === 1) {
          await firstGate.promise;
          inFlight = false;
          return;
        }
        secondRunStarted = true;
        inFlight = false;
        secondStarted.resolve(null);
      },
      signal: controller.signal,
      tickMs: 1,
    });

    // Several evaluations pass while run 1 is in flight — no duplicate.
    await waitFor(() => dueCalls >= 4 && runCount === 1);
    expect(runCount).toBe(1);

    // When run 1 ends and the bron is still due, exactly one merged
    // follow-up starts — not one per missed tick.
    firstGate.resolve(null);
    await secondStarted.promise;
    expect(runCount).toBe(2);
    expect(overlap).toBe(false);

    controller.abort();
    await scheduler;
    expect(runCount).toBe(2);
  });

  it("caps concurrent starts and hands a freed slot to the next due item", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const done = new Set<string>();
    const gates = new Map<string, () => void>();
    let inFlight = 0;
    let peak = 0;

    const scheduler = runContinuously<string>({
      concurrency: 2,
      dueItems: () =>
        Promise.resolve(["a", "b", "c"].filter((item) => !done.has(item))),
      keyOf: (item) => item,
      run: async (item) => {
        started.push(item);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // oxlint-disable-next-line promise/avoid-new -- the gate is released by the test, not by another promise
        await new Promise<null>((resolve) => {
          gates.set(item, () => {
            inFlight -= 1;
            done.add(item);
            resolve(null);
          });
        });
      },
      signal: controller.signal,
      tickMs: 1,
    });

    await waitFor(() => started.length === 2);
    expect(started).toEqual(["a", "b"]);
    expect(peak).toBe(2);

    // Freeing "a" wakes the loop early: "c" starts without waiting a tick.
    gates.get("a")?.();
    await waitFor(() => started.length === 3);
    expect(started).toEqual(["a", "b", "c"]);
    expect(peak).toBe(2);

    for (const release of gates.values()) {
      release();
    }
    controller.abort();
    await scheduler;
    expect(done.size).toBe(3);
  });

  it("keeps a slot for short items while a long item holds the long lane", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const done = new Set<string>();
    const gates = new Map<string, () => void>();
    const long = new Set(["long-a", "long-b"]);

    const scheduler = runContinuously<string>({
      concurrency: 2,
      // Both long items are due first, as when Techniekwerkt and ProUnity have
      // waited longest; without the lane cap they would take both slots.
      dueItems: () =>
        Promise.resolve(
          ["long-a", "long-b", "short-c", "short-d"].filter(
            (item) => !done.has(item)
          )
        ),
      isLong: (item) => long.has(item),
      keyOf: (item) => item,
      maxLongInFlight: 1,
      run: async (item) => {
        started.push(item);
        // oxlint-disable-next-line promise/avoid-new -- the gate is released by the test, not by another promise
        await new Promise<null>((resolve) => {
          gates.set(item, () => {
            done.add(item);
            resolve(null);
          });
        });
      },
      signal: controller.signal,
      tickMs: 1,
    });

    await waitFor(() => started.length === 2);
    expect(started).toEqual(["long-a", "short-c"]);

    // The short slot turns over; the second long item still waits.
    gates.get("short-c")?.();
    await waitFor(() => started.length === 3);
    expect(started).toEqual(["long-a", "short-c", "short-d"]);

    // Once the long lane frees up, the waiting long item takes it.
    gates.get("long-a")?.();
    await waitFor(() => started.length === 4);
    expect(started).toEqual(["long-a", "short-c", "short-d", "long-b"]);

    for (const release of gates.values()) {
      release();
    }
    controller.abort();
    await scheduler;
    expect(done.size).toBe(4);
  });

  it("treats every item as short when isLong is omitted", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const gates: (() => void)[] = [];

    const scheduler = runContinuously<string>({
      concurrency: 2,
      dueItems: () => Promise.resolve(["a", "b"]),
      keyOf: (item) => item,
      maxLongInFlight: 1,
      run: async (item) => {
        started.push(item);
        // oxlint-disable-next-line promise/avoid-new -- the gate is released by the test, not by another promise
        await new Promise<null>((resolve) => {
          gates.push(() => resolve(null));
        });
      },
      signal: controller.signal,
      tickMs: 1,
    });

    await waitFor(() => started.length === 2);
    expect(started).toEqual(["a", "b"]);

    controller.abort();
    for (const release of gates) {
      release();
    }
    await scheduler;
  });

  it("stops dispatching on abort and waits for the in-flight run to settle", async () => {
    const controller = new AbortController();
    const gate = Promise.withResolvers<null>();
    const started: string[] = [];

    const scheduler = runContinuously<string>({
      concurrency: 2,
      dueItems: () => Promise.resolve(started.includes("a") ? [] : ["a", "b"]),
      keyOf: (item) => item,
      run: async (item) => {
        started.push(item);
        if (item === "a") {
          await gate.promise;
        }
      },
      signal: controller.signal,
      tickMs: 1,
    });

    await waitFor(() => started.includes("a") && started.includes("b"));
    controller.abort();

    let drained = false;
    const done = scheduler.then(() => {
      drained = true;
    });
    await waitFor(() => started.length >= 2);
    expect(drained).toBe(false);

    gate.resolve(null);
    await done;
    expect(drained).toBe(true);
  });

  it("reports a rejecting run through onRunError and keeps scheduling", async () => {
    const controller = new AbortController();
    const goodStarted = Promise.withResolvers<null>();
    const errors: { error: unknown; item: string }[] = [];
    const boom = new Error("runner defected");

    const scheduler = runContinuously<string>({
      concurrency: 1,
      dueItems: () => Promise.resolve(errors.length === 0 ? ["bad"] : ["good"]),
      keyOf: (item) => item,
      onRunError: (error, item) => {
        errors.push({ error, item });
      },
      run: (item) => {
        if (item === "bad") {
          return Promise.reject(boom);
        }
        goodStarted.resolve(null);
        return Promise.resolve();
      },
      signal: controller.signal,
      tickMs: 1,
    });

    await goodStarted.promise;
    expect(errors).toEqual([{ error: boom, item: "bad" }]);

    controller.abort();
    await scheduler;
  });

  it("invokes onTick before every evaluation", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const ran = Promise.withResolvers<null>();

    const scheduler = runContinuously<string>({
      concurrency: 1,
      dueItems: () => {
        order.push("due");
        return Promise.resolve(order.includes("run") ? [] : ["a"]);
      },
      keyOf: (item) => item,
      onTick: () => {
        order.push("tick");
        return Promise.resolve();
      },
      run: () => {
        order.push("run");
        ran.resolve(null);
        return Promise.resolve();
      },
      signal: controller.signal,
      tickMs: 1,
    });

    await ran.promise;
    await waitFor(() => order.length >= 4);
    controller.abort();
    await scheduler;

    expect(order.slice(0, 3)).toEqual(["tick", "due", "run"]);
    // Every due read is preceded by its own tick.
    for (const [index, entry] of order.entries()) {
      if (entry === "due") {
        expect(order[index - 1]).toBe("tick");
      }
    }
  });
});
