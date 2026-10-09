import { describe, expect, it } from "bun:test";

import type { BronId } from "@ji/domain";

import { FetchRateCap, withFetchRateCap } from "./fetch-rate-cap";
import { HostGate } from "./host-gate";
import type { GateSignal, RequestLimiter } from "./limiter";

const fakeClock = () => {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    wait: (ms: number) => {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    waits,
  };
};

// SAFETY: the cap ignores the bron id; any branded string will do.
const BRON = "bron-cap" as BronId;

describe("FetchRateCap", () => {
  it("spaces sequential starts 1000/perSecond ms apart", async () => {
    const clock = fakeClock();
    const cap = new FetchRateCap({ ...clock, perSecond: 4 });
    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential starts are the case under test
      await cap.acquire();
    }
    expect(clock.waits).toEqual([250, 250, 250]);
    expect(clock.now()).toBe(750);
  });

  it("reserves a distinct slot for each concurrent caller", async () => {
    let now = 0;
    const waits: number[] = [];
    const cap = new FetchRateCap({
      now: () => now,
      perSecond: 10,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await Promise.all([cap.acquire(), cap.acquire(), cap.acquire()]);
    expect(waits).toEqual([100, 200]);
    now = 1000;
    await cap.acquire();
    expect(waits).toEqual([100, 200]);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new FetchRateCap({ perSecond: 0 })).toThrow(
      "perSecond must be a positive number"
    );
  });

  it("stops waiting when the signal aborts", async () => {
    const cap = new FetchRateCap({ perSecond: 1 });
    await cap.acquire();
    const controller = new AbortController();
    const pending = cap.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe("withFetchRateCap", () => {
  it("waits for the host limiter first, then the global slot, and forwards reports", async () => {
    const order: string[] = [];
    const reports: GateSignal[] = [];
    const host: RequestLimiter = {
      acquire: () => {
        order.push("host");
        return Promise.resolve();
      },
      report: (_bronId, signal) => {
        reports.push(signal);
      },
    };
    const clock = fakeClock();
    const cap = new FetchRateCap({
      now: clock.now,
      perSecond: 1,
      wait: (ms) => {
        order.push(`cap:${ms}`);
        return clock.wait(ms);
      },
    });
    const limiter = withFetchRateCap(host, cap);
    await limiter.acquire(BRON);
    await limiter.acquire(BRON);
    limiter.report?.(BRON, { kind: "rate_limited", retryAfterMs: 5000 });
    expect(order).toEqual(["host", "host", "cap:1000"]);
    expect(reports).toEqual([{ kind: "rate_limited", retryAfterMs: 5000 }]);
  });

  it("a request the cap held still keeps the host's crawl delay from its real start", async () => {
    const clock = fakeClock();
    const gate = new HostGate({
      crawlDelayMs: 2000,
      now: clock.now,
      wait: clock.wait,
    });
    const cap = new FetchRateCap({
      now: clock.now,
      perSecond: 1,
      wait: clock.wait,
    });
    const limiter = withFetchRateCap(gate, cap);
    // Another source takes the cap's slot at t=0.
    await cap.acquire();
    const starts: number[] = [];
    await limiter.acquire(BRON);
    starts.push(clock.now());
    await limiter.acquire(BRON);
    starts.push(clock.now());
    // The first request left at 1000 (held by the cap), so the second may
    // not leave before 3000; counting from the reservation would allow 2000.
    expect(starts).toEqual([1000, 3000]);
  });

  it("tells the host limiter about a start only when the cap held it", async () => {
    const started: string[] = [];
    const host: RequestLimiter = {
      acquire: () => Promise.resolve(),
      started: (bronId) => {
        started.push(bronId);
      },
    };
    const clock = fakeClock();
    const limiter = withFetchRateCap(
      host,
      new FetchRateCap({ now: clock.now, perSecond: 1, wait: clock.wait })
    );
    await limiter.acquire(BRON);
    expect(started).toEqual([]);
    await limiter.acquire(BRON);
    expect(started).toEqual([BRON]);
  });
});
