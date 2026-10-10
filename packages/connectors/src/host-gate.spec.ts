import { describe, expect, it } from "bun:test";

import type { BronId } from "@ji/domain";

import {
  AuthFault,
  RateLimitFault,
  Server5xxFault,
} from "./effect-runtime/faults";
import {
  gateSignalOf,
  HostCircuitOpenError,
  HostGate,
  isHostBlockedError,
} from "./host-gate";
import { HttpStatusError } from "./json-ld/live-fetch";
import { SourceBlockedError } from "./source-blocked";

// SAFETY: a UUID-shaped literal is a valid BronId.
const bronId = "00000000-0000-4000-8000-0000000000aa" as BronId;

const fakeClock = () => {
  let nowMs = 1_000_000;
  const waits: number[] = [];
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    wait: (ms: number) => {
      waits.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    waits,
  };
};

const gate = (clock: ReturnType<typeof fakeClock>, crawlDelayMs = 2000) =>
  new HostGate({ crawlDelayMs, now: clock.now, wait: clock.wait });

describe("HostGate pacing", () => {
  it("keeps the crawl-delay pacing of the limiter it replaces", async () => {
    const clock = fakeClock();
    const subject = gate(clock);
    await subject.acquire(bronId);
    await subject.acquire(bronId);
    await subject.acquire(bronId);
    expect(clock.waits).toEqual([2000, 2000]);
  });
});

describe("HostGate 429/503 pauses", () => {
  it("pauses the host for the Retry-After it sent", async () => {
    const clock = fakeClock();
    const subject = gate(clock);
    await subject.acquire(bronId);
    subject.report(bronId, { kind: "rate_limited", retryAfterMs: 30_000 });
    expect(subject.snapshot(bronId).pausedUntil?.getTime()).toBe(
      clock.now() + 30_000
    );
    await subject.acquire(bronId);
    expect(clock.waits).toEqual([30_000]);
  });

  it("backs off exponentially without Retry-After and resets on success", async () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "rate_limited", retryAfterMs: null });
    await subject.acquire(bronId);
    subject.report(bronId, { kind: "rate_limited", retryAfterMs: null });
    await subject.acquire(bronId);
    subject.report(bronId, { kind: "rate_limited", retryAfterMs: null });
    await subject.acquire(bronId);
    expect(clock.waits).toEqual([30_000, 60_000, 120_000]);
    subject.report(bronId, { kind: "ok" });
    subject.report(bronId, { kind: "rate_limited", retryAfterMs: null });
    await subject.acquire(bronId);
    expect(clock.waits.at(-1)).toBe(30_000);
  });

  it("caps a huge Retry-After so the run budget, not the host, bounds the wait", async () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, {
      kind: "rate_limited",
      retryAfterMs: 86_400_000,
    });
    await subject.acquire(bronId);
    expect(clock.waits).toEqual([600_000]);
  });
});

describe("HostGate circuit", () => {
  it("opens after two consecutive blocks and sends nothing while open", async () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "blocked" });
    expect(subject.snapshot(bronId).circuit).toBe("closed");
    subject.report(bronId, { kind: "blocked" });
    expect(subject.snapshot(bronId).circuit).toBe("open");
    await expect(subject.acquire(bronId)).rejects.toBeInstanceOf(
      HostCircuitOpenError
    );
    clock.advance(3_599_000);
    await expect(subject.acquire(bronId)).rejects.toBeInstanceOf(
      HostCircuitOpenError
    );
  });

  it("lets exactly one probe through after the cool-down; success closes it", async () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "blocked" });
    subject.report(bronId, { kind: "blocked" });
    clock.advance(3_600_000);
    expect(subject.snapshot(bronId).circuit).toBe("half_open");
    await subject.acquire(bronId);
    // A second caller while the probe is out is refused.
    await expect(subject.acquire(bronId)).rejects.toBeInstanceOf(
      HostCircuitOpenError
    );
    subject.report(bronId, { kind: "ok" });
    expect(subject.snapshot(bronId).circuit).toBe("closed");
    await subject.acquire(bronId);
  });

  it("re-opens a failed probe with a doubled cool-down, capped at 24 h", async () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "blocked" });
    subject.report(bronId, { kind: "blocked" });
    const cooldowns: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const openUntil = subject.snapshot(bronId).openUntil?.getTime() ?? 0;
      cooldowns.push((openUntil - clock.now()) / 3_600_000);
      clock.advance(openUntil - clock.now());
      // oxlint-disable-next-line no-await-in-loop -- each probe follows the previous cool-down
      await subject.acquire(bronId);
      subject.report(bronId, { kind: "blocked" });
    }
    expect(cooldowns).toEqual([1, 2, 4, 8, 16, 24, 24]);
  });

  it("counts blocks across successes: a sitemap that loads does not excuse blocked detail pages", () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "ok" });
    subject.report(bronId, { kind: "blocked" });
    subject.report(bronId, { kind: "ok" });
    subject.report(bronId, { kind: "blocked" });
    expect(subject.snapshot(bronId).circuit).toBe("open");
  });

  it("forgets a block once it is older than the window", () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "blocked" });
    clock.advance(6 * 3_600_000 + 1);
    subject.report(bronId, { kind: "blocked" });
    expect(subject.snapshot(bronId)).toMatchObject({
      circuit: "closed",
      recentBlocks: 1,
    });
  });

  it("a probe that gets through closes the circuit, but a block soon after re-opens it escalated", async () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "blocked" });
    subject.report(bronId, { kind: "blocked" });
    clock.advance(3_600_000);
    await subject.acquire(bronId);
    subject.report(bronId, { kind: "ok" });
    expect(subject.snapshot(bronId).circuit).toBe("closed");
    subject.report(bronId, { kind: "blocked" });
    const snapshot = subject.snapshot(bronId);
    expect(snapshot.circuit).toBe("open");
    expect((snapshot.openUntil?.getTime() ?? 0) - clock.now()).toBe(
      2 * 3_600_000
    );
  });
});

describe("HostGate probe bookkeeping", () => {
  it("a probe that ends without an answer keeps the circuit half-open for the next request", async () => {
    const clock = fakeClock();
    const subject = gate(clock, 0);
    subject.report(bronId, { kind: "blocked" });
    subject.report(bronId, { kind: "blocked" });
    clock.advance(3_600_000);
    await subject.acquire(bronId);
    // A 404, a timeout or an abort: nothing learned about the host.
    subject.report(bronId, { kind: "settled" });
    expect(subject.snapshot(bronId).circuit).toBe("half_open");
    await subject.acquire(bronId);
    subject.report(bronId, { kind: "ok" });
    expect(subject.snapshot(bronId).circuit).toBe("closed");
  });

  it("a probe whose pacing wait is aborted frees the probe for the next caller", async () => {
    const clock = fakeClock();
    let failWait = true;
    const subject = new HostGate({
      crawlDelayMs: 2 * 3_600_000,
      now: clock.now,
      wait: (ms) => {
        if (failWait) {
          return Promise.reject(new Error("aborted"));
        }
        return clock.wait(ms);
      },
    });
    // Reserve a pacing window that outlasts the cool-down.
    await subject.acquire(bronId);
    subject.report(bronId, { kind: "blocked" });
    subject.report(bronId, { kind: "blocked" });
    clock.advance(3_600_000);
    await expect(subject.acquire(bronId)).rejects.toThrow("aborted");
    failWait = false;
    await subject.acquire(bronId);
    expect(subject.snapshot(bronId).circuit).toBe("half_open");
  });

  it("a replacement gate adopts an open circuit, its cool-down and a 429 pause", async () => {
    const clock = fakeClock();
    const previous = gate(clock, 0);
    previous.report(bronId, { kind: "blocked" });
    previous.report(bronId, { kind: "blocked" });
    const replacement = gate(clock, 5000);
    replacement.adoptStateOf(previous);
    await expect(replacement.acquire(bronId)).rejects.toBeInstanceOf(
      HostCircuitOpenError
    );
    expect(replacement.snapshot(bronId)).toMatchObject({
      circuit: "open",
      recentBlocks: 2,
    });
    // A failed probe on the replacement still escalates to 2 h.
    clock.advance(3_600_000);
    await replacement.acquire(bronId);
    replacement.report(bronId, { kind: "blocked" });
    expect(replacement.snapshot(bronId).openUntil?.getTime()).toBe(
      clock.now() + 2 * 3_600_000
    );

    const paused = gate(clock, 0);
    const otherBron =
      // SAFETY: a UUID-shaped literal is a valid BronId.
      "00000000-0000-4000-8000-0000000000ab" as BronId;
    paused.report(otherBron, { kind: "rate_limited", retryAfterMs: 30_000 });
    const pausedReplacement = gate(clock, 0);
    pausedReplacement.adoptStateOf(paused);
    expect(pausedReplacement.snapshot(otherBron).pausedUntil?.getTime()).toBe(
      clock.now() + 30_000
    );
  });
});

describe("gateSignalOf", () => {
  it("reads blocks, rate limits and Retry-After from every error shape", () => {
    const challenge = new SourceBlockedError({
      message: "cf challenge",
      url: "https://x.test",
    });
    expect(gateSignalOf(challenge)).toEqual({ kind: "blocked" });
    expect(
      gateSignalOf(
        new AuthFault({ cause: challenge, message: "403", status: 403 })
      )
    ).toEqual({ kind: "blocked" });
    expect(
      gateSignalOf(
        new HttpStatusError({ slug: "s", status: 403, url: "https://x.test" })
      )
    ).toEqual({ kind: "blocked" });
    expect(
      gateSignalOf(
        new RateLimitFault({
          message: "429",
          retryAfterMs: 5000,
          status: 429,
        })
      )
    ).toEqual({ kind: "rate_limited", retryAfterMs: 5000 });
    expect(
      gateSignalOf(new Server5xxFault({ message: "503", status: 503 }))
    ).toEqual({ kind: "rate_limited", retryAfterMs: null });
    expect(
      gateSignalOf(
        new Error("Connector fetch failed", {
          cause: new HttpStatusError({
            slug: "s",
            status: 429,
            url: "https://x.test",
          }),
        })
      )
    ).toEqual({ kind: "rate_limited", retryAfterMs: null });
    expect(
      gateSignalOf(
        new HttpStatusError({
          retryAfterMs: 3000,
          slug: "s",
          status: 429,
          url: "https://x.test",
        })
      )
    ).toEqual({ kind: "rate_limited", retryAfterMs: 3000 });
  });

  it("says nothing for answers that are not about the host's patience", () => {
    expect(
      gateSignalOf(new AuthFault({ message: "401", status: 401 }))
    ).toBeNull();
    expect(
      gateSignalOf(new Server5xxFault({ message: "500", status: 500 }))
    ).toBeNull();
    expect(
      gateSignalOf(
        new HttpStatusError({ slug: "s", status: 404, url: "https://x.test" })
      )
    ).toBeNull();
    expect(gateSignalOf(new Error("parse broke"))).toBeNull();
    const circuitOpen = new HostCircuitOpenError({
      bronId,
      openUntil: new Date(0),
    });
    expect(gateSignalOf(circuitOpen)).toBeNull();
    expect(isHostBlockedError(circuitOpen)).toBe(true);
  });
});
