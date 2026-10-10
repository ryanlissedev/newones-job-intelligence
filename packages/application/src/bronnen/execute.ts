import {
  awaitWithSignal,
  FetchRateCap,
  fullJitter,
  HostGate,
  runConnector,
  withFetchRateCap,
} from "@ji/connectors";
import type {
  Connector,
  ConnectorRunResult,
  HostGateSnapshot,
  ConnectorRunInput,
  ObjectStore,
  ObservationRecorder,
  RequestLimiter,
  RetryPolicy,
  RunLifecycleStore,
  ConnectorRunKind,
  RunCompleteness,
} from "@ji/connectors";
import type { BronId, ScrapeRunId } from "@ji/domain";

import { reconcileMissedPolls } from "../lifecycle/reconcile-missed-polls";
import type {
  LifecycleReconcilePorts,
  ReconcileMissedPollsResult,
} from "../lifecycle/reconcile-missed-polls";
import { isPollableBron } from "./register";
import type { BronPersistence } from "./register";

export interface ExecuteBronRunInput {
  onProgress?: ConnectorRunInput["onProgress"];
  bronId: BronId;
  bronSlug: string;
  scrapeRunId: ScrapeRunId;
  connector: Connector;
  objectStore: ObjectStore;
  observationRecorder: ObservationRecorder;
  runLifecycleStore: RunLifecycleStore;
  runKind?: ConnectorRunKind;
  /**
   * RJC-397: when present, poll runs reconcile `missed_polls` against the
   * observed listing after the connector run and write stale/reopen
   * transitions. Test-import runs never count misses.
   */
  lifecycle?: LifecycleReconcilePorts;
  retryPolicy?: RetryPolicy;
  /**
   * Overrides the process-wide fetch cap for this run (tests). Unset uses the
   * cap from `configureProcessFetchRateCap`, or none when that was never set.
   */
  fetchRateCap?: FetchRateCap;
  /** CTP-490: stops the connector run at the next item boundary; see `ConnectorRunInput.signal`. */
  signal?: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  writeNow?: () => Date;
  startedAt?: Date;
}

interface ActiveLimiter {
  activeRuns: number;
  /** The gate that owns this bron's host state (pauses, circuit). */
  gate: HostGate;
  limiter: RequestLimiter;
  policy: LimiterPolicy;
  replacementLimiter?: HostGate;
}

/**
 * One HostGate per bron for the life of the process, so 429 pauses and an
 * open circuit carry over from one run to the next.
 */
const activeLimiters = new Map<BronId, ActiveLimiter>();

type LimiterPolicy = Pick<
  ConstructorParameters<typeof HostGate>[0],
  "crawlDelayMs" | "rateLimitPerMinute"
>;

const hasSamePolicy = (
  current: LimiterPolicy,
  requested: LimiterPolicy
): boolean =>
  current.crawlDelayMs === requested.crawlDelayMs &&
  current.rateLimitPerMinute === requested.rateLimitPerMinute;

const transitionLimiterPolicy = (
  previous: RequestLimiter,
  next: HostGate
): RequestLimiter => {
  let previousWindow: Promise<void> | undefined;
  return {
    acquire: async (bronId, signal) => {
      // The shared reservation must outlive an individual caller. Waiting on
      // it is cancellable, but the first caller's signal must not poison the
      // promise cached for later runs.
      previousWindow ??= previous.acquire(bronId);
      await awaitWithSignal(previousWindow, signal);
      await next.acquire(bronId, signal);
    },
    report: (bronId, signal) => next.report(bronId, signal),
    started: (bronId) => next.started(bronId),
  };
};

const acquireLimiter = (
  bronId: BronId,
  options: ConstructorParameters<typeof HostGate>[0]
): ActiveLimiter => {
  const activeLimiter = activeLimiters.get(bronId);
  if (activeLimiter) {
    const requestedPolicy = {
      crawlDelayMs: options.crawlDelayMs,
      rateLimitPerMinute: options.rateLimitPerMinute,
    };
    if (!hasSamePolicy(activeLimiter.policy, requestedPolicy)) {
      if (activeLimiter.activeRuns > 0) {
        throw new Error("bron limiter policy changed during an active run");
      }
      const replacementLimiter = new HostGate(options);
      // A new crawl delay must not reset an open circuit or a 429 pause.
      replacementLimiter.adoptStateOf(activeLimiter.gate);
      const refreshed = {
        activeRuns: 1,
        gate: replacementLimiter,
        limiter: transitionLimiterPolicy(
          activeLimiter.limiter,
          replacementLimiter
        ),
        policy: requestedPolicy,
        replacementLimiter,
      };
      activeLimiters.set(bronId, refreshed);
      return refreshed;
    }
    activeLimiter.activeRuns += 1;
    return activeLimiter;
  }
  const gate = new HostGate(options);
  const created = {
    activeRuns: 1,
    gate,
    limiter: gate,
    policy: {
      crawlDelayMs: options.crawlDelayMs,
      rateLimitPerMinute: options.rateLimitPerMinute,
    },
  };
  activeLimiters.set(bronId, created);
  return created;
};

/**
 * The host gate state of a bron this process has run, or null when it has
 * not run it yet. The poller reads it to skip a source whose circuit is open
 * or whose host asked for a pause, instead of starting a run that would only
 * wait or fail at once.
 */
export const hostGateSnapshot = (bronId: BronId): HostGateSnapshot | null =>
  activeLimiters.get(bronId)?.gate.snapshot(bronId) ?? null;

/** True while a bron's host refuses new runs: circuit open, or paused past `until`. */
export const hostGateHoldsStart = (bronId: BronId, until: Date): boolean => {
  const snapshot = hostGateSnapshot(bronId);
  if (!snapshot) {
    return false;
  }
  return (
    snapshot.circuit === "open" ||
    (snapshot.pausedUntil !== null && snapshot.pausedUntil > until)
  );
};

let processFetchRateCap: FetchRateCap | null = null;

/**
 * Sets the process-wide ceiling on request starts per second, shared by every
 * bron run in this process; `null` removes it. The poller calls this once at
 * startup with POLLER_FETCHES_PER_SECOND. Per-host pacing is unaffected: the
 * cap sits behind each bron's HostGate.
 */
export const configureProcessFetchRateCap = (
  perSecond: number | null
): void => {
  processFetchRateCap =
    perSecond === null ? null : new FetchRateCap({ perSecond });
};

const releaseLimiter = (activeLimiter: ActiveLimiter): void => {
  activeLimiter.activeRuns -= 1;
  if (activeLimiter.activeRuns === 0 && activeLimiter.replacementLimiter) {
    activeLimiter.limiter = activeLimiter.replacementLimiter;
    activeLimiter.replacementLimiter = undefined;
  }
};

/**
 * RJC-397: a listing with zero items is far more often a parser regression
 * than an emptied bron, and the two are indistinguishable here. Never count
 * misses on it; a genuinely emptied bron keeps its records until a date or
 * operator close (rare, accepted).
 */
const guardEmptyListing = (result: ConnectorRunResult): RunCompleteness =>
  result.completeness.complete && result.observedBronReferenties.length === 0
    ? { complete: false, reason: "empty" }
    : result.completeness;

export interface ExecuteBronRunResult extends ConnectorRunResult {
  /** Null when no lifecycle ports were supplied or the run was not a poll. */
  lifecycle: ReconcileMissedPollsResult | null;
}

/** Loads operational policy from the durable bron record before starting any request. */
export const executeBronRun = async (
  persistence: BronPersistence,
  input: ExecuteBronRunInput
): Promise<ExecuteBronRunResult> => {
  const record = await persistence.findById(input.bronId);
  if (!record) {
    throw new Error("bron not found");
  }
  const runKind = input.runKind ?? "poll";
  if (runKind === "poll" && !isPollableBron(record)) {
    throw new Error("bron is not pollable");
  }
  if (runKind === "test" && record.voorwaardenStatus !== "toegestaan") {
    throw new Error("bron voorwaarden must be toegestaan for test-import");
  }

  const retryPolicy = input.retryPolicy ?? {
    initialDelayMs: 250,
    jitter: fullJitter,
    maxAttempts: 3,
    maxDelayMs: 5000,
    multiplier: 2,
  };

  const activeLimiter = acquireLimiter(input.bronId, {
    crawlDelayMs: record.crawlDelayMs,
    now: input.now,
    rateLimitPerMinute: record.rateLimitPerMinute,
    wait: input.wait,
  });

  const fetchRateCap = input.fetchRateCap ?? processFetchRateCap;
  let result: ConnectorRunResult;
  try {
    result = await runConnector({
      bronId: input.bronId,
      bronSlug: input.bronSlug,
      connector: input.connector,
      limiter: fetchRateCap
        ? withFetchRateCap(activeLimiter.limiter, fetchRateCap)
        : activeLimiter.limiter,
      objectStore: input.objectStore,
      observationRecorder: input.observationRecorder,
      onProgress: input.onProgress,
      rawRetentionDays: record.retentionDays,
      retryPolicy,
      runKind,
      runLifecycleStore: input.runLifecycleStore,
      scrapeRunId: input.scrapeRunId,
      signal: input.signal,
      startedAt: input.startedAt,
      wait: input.wait,
      writeNow: input.writeNow,
    });
  } finally {
    releaseLimiter(activeLimiter);
  }

  // A failed run threw above and never reaches this point, so a result here
  // means the listing was read; `completeness` says whether all of it was.
  const lifecycle =
    input.lifecycle && runKind === "poll"
      ? await reconcileMissedPolls(input.lifecycle, {
          bronId: input.bronId,
          completeness: guardEmptyListing(result),
          observedAt: (input.writeNow ?? (() => new Date()))(),
          observedBronReferenties: result.observedBronReferenties,
          scrapeRunId: input.scrapeRunId,
        })
      : null;
  if (lifecycle) {
    result.metrics.closed = lifecycle.staled.length;
  }
  return { ...result, lifecycle };
};
