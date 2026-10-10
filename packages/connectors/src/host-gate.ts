/* oxlint-disable max-classes-per-file -- the gate and the error it raises are one module */
import type { BronId } from "@ji/domain";

import { isReadIoFault } from "./effect-runtime/faults";
import { HttpStatusError } from "./json-ld/live-fetch";
import type { GateSignal, RequestLimiter } from "./limiter";
import type { Sleep } from "./retry";
import { awaitWithSignal, sleep } from "./retry";
import { SourceBlockedError } from "./source-blocked";

const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MAX_CAUSE_DEPTH = 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface HostGatePolicy {
  /** Blocked answers (403 / bot challenge) within `blockedWindowMs` that open the circuit. */
  readonly blockedThreshold: number;
  /**
   * How long a block counts. Successes do not reset it: a host that serves
   * its sitemap but challenges every detail page is still blocking us.
   */
  readonly blockedWindowMs: number;
  /** First circuit cool-down; doubles on every re-open, capped at the max. */
  readonly circuitCooldownMs: number;
  readonly maxCircuitCooldownMs: number;
  /** Pause after a 429/503 without `Retry-After`; doubles per repeat. */
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
  /** A `Retry-After` longer than this is capped: the run budget, not the host, bounds the wait. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_HOST_GATE_POLICY: HostGatePolicy = {
  backoffInitialMs: 30_000,
  backoffMaxMs: 10 * MINUTE_MS,
  blockedThreshold: 2,
  blockedWindowMs: 6 * HOUR_MS,
  circuitCooldownMs: HOUR_MS,
  maxCircuitCooldownMs: 24 * HOUR_MS,
  maxRetryAfterMs: 10 * MINUTE_MS,
};

export type HostCircuitState = "closed" | "half_open" | "open";

export interface HostGateSnapshot {
  readonly circuit: HostCircuitState;
  readonly consecutiveRateLimited: number;
  /** Blocked answers still inside the policy window. */
  readonly recentBlocks: number;
  /** Set while the circuit is open or half-open. */
  readonly openUntil: Date | null;
  /** Set while a 429/503 pause is still running. */
  readonly pausedUntil: Date | null;
}

/**
 * The host's circuit is open: it refused us repeatedly, so the gate stops
 * sending requests until the cool-down ends. A `SourceBlockedError`, so the
 * run is classified `blocked`, and never retried per URL.
 */
export class HostCircuitOpenError extends SourceBlockedError {
  readonly openUntil: Date;

  constructor(options: { bronId: BronId; openUntil: Date }) {
    super({
      message: `Host circuit open for bron ${options.bronId} until ${options.openUntil.toISOString()}: the source blocked repeated requests`,
      url: "",
    });
    this.name = "HostCircuitOpenError";
    this.openUntil = options.openUntil;
  }
}

const statusSignal = (
  status: number | undefined,
  retryAfterMs: number | null = null
): GateSignal | null => {
  if (status === HTTP_FORBIDDEN) {
    return { kind: "blocked" };
  }
  if (
    status === HTTP_TOO_MANY_REQUESTS ||
    status === HTTP_SERVICE_UNAVAILABLE
  ) {
    return { kind: "rate_limited", retryAfterMs };
  }
  return null;
};

/**
 * What a failed request says about the host, or null when it says nothing
 * (a 404, a parse error, a timeout). Walks `cause` like `classifyRunFailure`.
 * The gate's own `HostCircuitOpenError` is not a new answer from the host.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-boundary classifier for whatever a connector threw
export const gateSignalOf = (error: unknown): GateSignal | null => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof HostCircuitOpenError) {
      return null;
    }
    if (current instanceof SourceBlockedError) {
      return { kind: "blocked" };
    }
    if (isReadIoFault(current)) {
      if (current._tag === "rate_limit") {
        return { kind: "rate_limited", retryAfterMs: current.retryAfterMs };
      }
      if (current._tag === "auth" || current._tag === "server_5xx") {
        const signal = statusSignal(current.status);
        if (signal) {
          return signal;
        }
      }
    }
    if (current instanceof HttpStatusError) {
      return statusSignal(current.status, current.retryAfterMs);
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      break;
    }
    current = current.cause;
  }
  return null;
};

/** True for a block or an open circuit: retrying the same URL only hammers the host. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- retry predicate over whatever a connector threw
export const isHostBlockedError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof HostCircuitOpenError) {
      return true;
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      break;
    }
    current = current.cause;
  }
  return gateSignalOf(error)?.kind === "blocked";
};

interface HostState {
  blockedAt: number[];
  circuitOpenUntil: number | null;
  consecutiveRateLimited: number;
  nextCooldownMs: number;
  nextRequestAt: number | null;
  pausedUntil: number;
  probeInFlight: boolean;
}

export interface HostGateOptions {
  crawlDelayMs: number;
  rateLimitPerMinute?: number;
  now?: () => number;
  policy?: Partial<HostGatePolicy>;
  wait?: Sleep;
}

/**
 * Per-host politeness gate behind the `RequestLimiter` interface, so callers
 * do not change. On top of the crawl-delay pacing (burst 1, one request per
 * minimum interval) it:
 *
 * - pauses the host on 429/503 for the `Retry-After` it sent, or an
 *   exponential back-off without one;
 * - opens a circuit after `blockedThreshold` consecutive 403/bot-challenge
 *   answers. While open, `acquire` fails at once with `HostCircuitOpenError`
 *   (no request leaves). After the cool-down one probe request is let
 *   through: success closes the circuit, another block re-opens it with a
 *   doubled cool-down (1 h → 24 h by default). The cool-down only falls back
 *   to its first value once no block is left inside the window.
 */
export class HostGate implements RequestLimiter {
  private readonly hosts = new Map<BronId, HostState>();
  private readonly minimumIntervalMs: number;
  private readonly now: () => number;
  private readonly policy: HostGatePolicy;
  private readonly wait: Sleep;

  constructor({
    crawlDelayMs,
    rateLimitPerMinute,
    now = Date.now,
    policy,
    wait = sleep,
  }: HostGateOptions) {
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
    this.policy = { ...DEFAULT_HOST_GATE_POLICY, ...policy };
    if (this.policy.blockedThreshold < 1) {
      throw new Error("blockedThreshold must be at least 1");
    }
    this.wait = wait;
  }

  /** Drops blocks older than the window; with none left, the cool-down resets. */
  private forgetOldBlocks(state: HostState, currentTime: number): void {
    const since = currentTime - this.policy.blockedWindowMs;
    state.blockedAt = state.blockedAt.filter((at) => at > since);
    if (state.blockedAt.length === 0 && state.circuitOpenUntil === null) {
      state.nextCooldownMs = this.policy.circuitCooldownMs;
    }
  }

  private stateOf(bronId: BronId): HostState {
    let state = this.hosts.get(bronId);
    if (!state) {
      state = {
        blockedAt: [],
        circuitOpenUntil: null,
        consecutiveRateLimited: 0,
        nextCooldownMs: this.policy.circuitCooldownMs,
        nextRequestAt: null,
        pausedUntil: 0,
        probeInFlight: false,
      };
      this.hosts.set(bronId, state);
    }
    return state;
  }

  async acquire(bronId: BronId, signal?: AbortSignal): Promise<void> {
    const state = this.stateOf(bronId);
    const currentTime = this.now();
    let probing = false;
    if (state.circuitOpenUntil !== null) {
      if (currentTime < state.circuitOpenUntil || state.probeInFlight) {
        throw new HostCircuitOpenError({
          bronId,
          openUntil: new Date(state.circuitOpenUntil),
        });
      }
      // Half-open: exactly this request probes the host.
      state.probeInFlight = true;
      probing = true;
    }
    const requestAt = Math.max(
      currentTime,
      state.nextRequestAt ?? currentTime,
      state.pausedUntil
    );
    // Reserve synchronously so overlapping callers cannot claim the same window.
    state.nextRequestAt = requestAt + this.minimumIntervalMs;
    const waitMs = requestAt - currentTime;
    if (waitMs > 0) {
      try {
        await awaitWithSignal(this.wait(waitMs, signal), signal);
      } catch (error) {
        // The probe never left: the next caller may probe instead.
        if (probing) {
          state.probeInFlight = false;
        }
        throw error;
      }
    }
  }

  /**
   * The request starts later than its reserved window (a global cap held
   * it): push the host's next window so the crawl delay still separates
   * real request starts.
   */
  started(bronId: BronId): void {
    const state = this.stateOf(bronId);
    const earliestNext = this.now() + this.minimumIntervalMs;
    state.nextRequestAt = Math.max(state.nextRequestAt ?? 0, earliestNext);
  }

  /**
   * Takes over another gate's per-host state, so a policy change (new crawl
   * delay) keeps an open circuit, its escalated cool-down and any 429 pause.
   * A probe the old gate had out is not carried: its answer reports here.
   */
  adoptStateOf(previous: HostGate): void {
    for (const [bronId, state] of previous.hosts) {
      this.hosts.set(bronId, {
        ...state,
        blockedAt: [...state.blockedAt],
        probeInFlight: false,
      });
    }
  }

  report(bronId: BronId, signal: GateSignal): void {
    const state = this.stateOf(bronId);
    const currentTime = this.now();
    if (signal.kind === "settled") {
      // No answer about the host: stay half-open so the next request probes.
      state.probeInFlight = false;
      return;
    }
    if (signal.kind === "ok") {
      state.consecutiveRateLimited = 0;
      if (state.circuitOpenUntil !== null && state.probeInFlight) {
        // The probe got through. Recent blocks still count, so a host that
        // blocks again soon re-opens with the escalated cool-down.
        state.circuitOpenUntil = null;
      }
      state.probeInFlight = false;
      this.forgetOldBlocks(state, currentTime);
      return;
    }
    if (signal.kind === "rate_limited") {
      state.consecutiveRateLimited += 1;
      const backoffMs = Math.min(
        this.policy.backoffInitialMs * 2 ** (state.consecutiveRateLimited - 1),
        this.policy.backoffMaxMs
      );
      const pauseMs =
        signal.retryAfterMs === null
          ? backoffMs
          : Math.min(
              Math.max(0, signal.retryAfterMs),
              this.policy.maxRetryAfterMs
            );
      state.pausedUntil = Math.max(state.pausedUntil, currentTime + pauseMs);
      if (state.probeInFlight) {
        // The host answered the probe, just not yet with content: keep it half-open.
        state.probeInFlight = false;
      }
      return;
    }
    this.forgetOldBlocks(state, currentTime);
    state.blockedAt.push(currentTime);
    const probeFailed = state.probeInFlight;
    state.probeInFlight = false;
    if (probeFailed || state.blockedAt.length >= this.policy.blockedThreshold) {
      state.circuitOpenUntil = currentTime + state.nextCooldownMs;
      state.nextCooldownMs = Math.min(
        state.nextCooldownMs * 2,
        this.policy.maxCircuitCooldownMs
      );
    }
  }

  snapshot(bronId: BronId): HostGateSnapshot {
    const state = this.stateOf(bronId);
    const currentTime = this.now();
    this.forgetOldBlocks(state, currentTime);
    let circuit: HostCircuitState = "closed";
    if (state.circuitOpenUntil !== null) {
      circuit = currentTime < state.circuitOpenUntil ? "open" : "half_open";
    }
    return {
      circuit,
      consecutiveRateLimited: state.consecutiveRateLimited,
      openUntil:
        state.circuitOpenUntil === null
          ? null
          : new Date(state.circuitOpenUntil),
      pausedUntil:
        state.pausedUntil > currentTime ? new Date(state.pausedUntil) : null,
      recentBlocks: state.blockedAt.length,
    };
  }
}
