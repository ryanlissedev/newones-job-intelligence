import type { BronId } from "@ji/domain";

import type { Sleep } from "./retry";
import { awaitWithSignal, sleep } from "./retry";

/**
 * What one request told the limiter about the host. `blocked` is a 403 or a
 * bot challenge; `rate_limited` is a 429 or 503, with the `Retry-After` the
 * host sent when it sent one. `settled` is a request that ended without an
 * answer about the host (aborted, timed out, 404, parse error): it frees the
 * limiter's bookkeeping for that request but says nothing either way.
 */
export type GateSignal =
  | { readonly kind: "ok" }
  | { readonly kind: "blocked" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | null }
  | { readonly kind: "settled" };

export interface RequestLimiter {
  acquire: (bronId: BronId, signal?: AbortSignal) => Promise<void>;
  /**
   * Optional feedback after each limited request. A limiter that ignores it
   * (the plain crawl-delay limiter) keeps its fixed pacing.
   */
  report?: (bronId: BronId, signal: GateSignal) => void;
}

export interface CrawlDelayLimiterOptions {
  crawlDelayMs: number;
  rateLimitPerMinute?: number;
  now?: () => number;
  wait?: Sleep;
}

/** Enforces a minimum request interval per bron; production may inject a distributed limiter. */
export class CrawlDelayLimiter implements RequestLimiter {
  private readonly nextRequestAt = new Map<BronId, number>();
  private readonly now: () => number;
  private readonly wait: Sleep;
  private readonly minimumIntervalMs: number;

  constructor({
    crawlDelayMs,
    rateLimitPerMinute,
    now = Date.now,
    wait = sleep,
  }: CrawlDelayLimiterOptions) {
    if (!Number.isInteger(crawlDelayMs) || crawlDelayMs < 0) {
      throw new Error("crawlDelayMs must be a non-negative integer");
    }
    if (
      rateLimitPerMinute !== undefined &&
      (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute <= 0)
    ) {
      throw new Error("rateLimitPerMinute must be a positive integer");
    }
    const rateIntervalMs = rateLimitPerMinute
      ? Math.ceil(60_000 / rateLimitPerMinute)
      : 0;
    this.minimumIntervalMs = Math.max(crawlDelayMs, rateIntervalMs);
    this.now = now;
    this.wait = wait;
  }

  async acquire(bronId: BronId, signal?: AbortSignal): Promise<void> {
    const currentTime = this.now();
    const requestAt = Math.max(
      currentTime,
      this.nextRequestAt.get(bronId) ?? currentTime
    );
    const waitMs = requestAt - currentTime;
    // Reserve synchronously so overlapping callers cannot claim the same window.
    this.nextRequestAt.set(bronId, requestAt + this.minimumIntervalMs);
    if (waitMs > 0) {
      await awaitWithSignal(this.wait(waitMs, signal), signal);
    }
  }
}
