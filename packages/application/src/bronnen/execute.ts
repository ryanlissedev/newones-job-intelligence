import {
  awaitWithSignal,
  CrawlDelayLimiter,
  fullJitter,
  runConnector,
} from "@ji/connectors";
import type {
  ResumeOrderLookup,
  Connector,
  ConnectorRunResult,
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
   * Poll runs fetch never-fetched and longest-unfetched items first when
   * this is present, so a budget cut resumes on the next run.
   */
  resumeOrder?: ResumeOrderLookup;
  /**
   * RJC-397: when present, poll runs reconcile `missed_polls` against the
   * observed listing after the connector run and write stale/reopen
   * transitions. Test-import runs never count misses.
   */
  lifecycle?: LifecycleReconcilePorts;
  retryPolicy?: RetryPolicy;
  /** CTP-490: stops the connector run at the next item boundary; see `ConnectorRunInput.signal`. */
  signal?: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  writeNow?: () => Date;
  startedAt?: Date;
}

interface ActiveLimiter {
  activeRuns: number;
  limiter: RequestLimiter;
  policy: LimiterPolicy;
  replacementLimiter?: CrawlDelayLimiter;
}

const activeLimiters = new Map<BronId, ActiveLimiter>();

type LimiterPolicy = Pick<
  ConstructorParameters<typeof CrawlDelayLimiter>[0],
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
  next: CrawlDelayLimiter
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
  };
};

const acquireLimiter = (
  bronId: BronId,
  options: ConstructorParameters<typeof CrawlDelayLimiter>[0]
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
      const replacementLimiter = new CrawlDelayLimiter(options);
      const refreshed = {
        activeRuns: 1,
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
  const created = {
    activeRuns: 1,
    limiter: new CrawlDelayLimiter(options),
    policy: {
      crawlDelayMs: options.crawlDelayMs,
      rateLimitPerMinute: options.rateLimitPerMinute,
    },
  };
  activeLimiters.set(bronId, created);
  return created;
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
  result.discoveryCompleteness.complete &&
  result.observedBronReferenties.length === 0
    ? { complete: false, reason: "empty" }
    : result.discoveryCompleteness;

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

  let result: ConnectorRunResult;
  try {
    result = await runConnector({
      bronId: input.bronId,
      bronSlug: input.bronSlug,
      connector: input.connector,
      limiter: activeLimiter.limiter,
      objectStore: input.objectStore,
      observationRecorder: input.observationRecorder,
      onProgress: input.onProgress,
      rawRetentionDays: record.retentionDays,
      // Only poll runs reorder their fetches; a test import keeps listing order.
      resumeOrder: runKind === "poll" ? input.resumeOrder : undefined,
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
  // means the listing was read. Closure keys on whether the whole LISTING
  // was discovered, not on whether every detail page was fetched: a budget
  // cut during fetch still saw every listed reference.
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
