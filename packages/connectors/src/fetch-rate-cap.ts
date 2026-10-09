import type { BronId } from "@ji/domain";

import type { RequestLimiter } from "./limiter";
import type { Sleep } from "./retry";
import { awaitWithSignal, sleep } from "./retry";

export interface FetchRateCapOptions {
  /** Requests per second the whole process may start, across every bron. */
  readonly perSecond: number;
  readonly now?: () => number;
  readonly wait?: Sleep;
}

/**
 * Process-wide ceiling on request starts, shared by every bron run.
 *
 * Per-host politeness stays with each bron's `HostGate`. This cap bounds the
 * box's total outbound rate once more sources run side by side: eight
 * in-flight sources with short crawl delays could otherwise start far more
 * requests per second than the two fixed slots ever did.
 *
 * Starts are spaced evenly (`1000 / perSecond` ms apart), with no burst
 * allowance. Each slot is reserved synchronously, so concurrent callers never
 * share one. A caller that aborts while waiting gives up its slot unused.
 */
export class FetchRateCap {
  private nextStartAt = 0;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly wait: Sleep;

  constructor({
    perSecond,
    now = Date.now,
    wait = sleep,
  }: FetchRateCapOptions) {
    if (!Number.isFinite(perSecond) || perSecond <= 0) {
      throw new Error("perSecond must be a positive number");
    }
    this.intervalMs = 1000 / perSecond;
    this.now = now;
    this.wait = wait;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const currentTime = this.now();
    const startAt = Math.max(currentTime, this.nextStartAt);
    this.nextStartAt = startAt + this.intervalMs;
    const waitMs = Math.ceil(startAt - currentTime);
    if (waitMs > 0) {
      await awaitWithSignal(this.wait(waitMs, signal), signal);
    }
  }
}

/**
 * Puts the process cap behind a bron's own limiter. The host's pacing is
 * honoured first, then the global slot. Feedback still reaches the host gate.
 */
export const withFetchRateCap = (
  limiter: RequestLimiter,
  cap: FetchRateCap
): RequestLimiter => ({
  acquire: async (bronId: BronId, signal?: AbortSignal) => {
    await limiter.acquire(bronId, signal);
    await cap.acquire(signal);
  },
  report: (bronId, gateSignal) => limiter.report?.(bronId, gateSignal),
});
