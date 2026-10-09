import type { BronId, ScrapeRunId } from "@ji/domain";
import {
  createCriticalPathSession,
  currentCriticalPathSession,
  isCriticalPathEnabled,
  resolveRunKind,
  buildWorkloadMetadata,
  monotonicNowMs,
  timeCriticalPathPhase,
  withCriticalPathSession,
} from "@ji/performance";

import { boundBronReferentie } from "./bron-referentie";
import type { CheckpointKey, ConnectorRunProgress } from "./checkpoint";
import {
  CONNECTOR_OBSERVATION_CONTRACT_VERSION,
  emptyRunMetrics,
} from "./contract";
import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  ConnectorRunMetrics,
  DiscoverItem,
} from "./contract";
import { isAbortLike, isReadIoFault } from "./effect-runtime/faults";
import type { RequestLimiter } from "./limiter";
import {
  buildContentAddressedRawObjectPath,
  hashContent,
} from "./object-store";
import type { ObjectStore } from "./object-store";
import type { ObservationRecorder } from "./observation-recorder";
import type { RetryPolicy, Sleep } from "./retry";
import { withRetry } from "./retry";
import { ConnectorRunFailure, RunOwnershipLostError } from "./run-lifecycle";
import type {
  ConnectorRunKind,
  RunFailureEnvelope,
  RunLifecycleStore,
} from "./run-lifecycle";

const DAY_IN_MILLISECONDS = 86_400_000;

const FAILURE_ENVELOPES = {
  checkpoint: {
    class: "persistence",
    code: "CHECKPOINT_WRITE_FAILED",
    message: "Run checkpoint persistence failed",
    phase: "checkpoint",
  },
  complete: {
    class: "persistence",
    code: "COMPLETE_WRITE_FAILED",
    message: "Run completion persistence failed",
    phase: "complete",
  },
  discover: {
    class: "connector",
    code: "DISCOVER_FAILED",
    message: "Connector discovery failed",
    phase: "discover",
  },
  fetch: {
    class: "connector",
    code: "FETCH_FAILED",
    message: "Connector fetch failed",
    phase: "fetch",
  },
  observation: {
    class: "persistence",
    code: "OBSERVATION_WRITE_FAILED",
    message: "Observation persistence failed",
    phase: "observation",
  },
  rawStore: {
    class: "storage",
    code: "RAW_STORE_WRITE_FAILED",
    message: "Raw object persistence failed",
    phase: "raw-store",
  },
  unknown: {
    class: "internal",
    code: "UNEXPECTED_FAILURE",
    message: "Connector run failed",
    phase: "unknown",
  },
} as const satisfies Record<string, RunFailureEnvelope>;

/** Marks cancellation that came from the run-owned request boundary. */
class ConnectorRequestAbortedError extends Error {
  constructor(cause: unknown) {
    super("Connector request aborted", { cause });
    this.name = "ConnectorRequestAbortedError";
  }
}

const withFailureEnvelope = async <Result>(
  operation: () => Promise<Result>,
  envelope: RunFailureEnvelope
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof RunOwnershipLostError ||
      error instanceof ConnectorRunFailure ||
      error instanceof ConnectorRequestAbortedError
    ) {
      throw error;
    }
    throw new ConnectorRunFailure(envelope, error);
  }
};

export interface ConnectorRunInput {
  onProgress?: (milestone: {
    key: CheckpointKey;
    fenceToken: number;
    phase: "fetch" | "persist";
    observedAt: Date;
  }) => Promise<void>;
  bronId: BronId;
  bronSlug: string;
  checkpoint?: ConnectorCheckpoint | null;
  connector: Connector;
  limiter: RequestLimiter;
  objectStore: ObjectStore;
  observationRecorder: ObservationRecorder;
  rawRetentionDays: number;
  retryPolicy: RetryPolicy;
  runKind: ConnectorRunKind;
  runLifecycleStore: RunLifecycleStore;
  scrapeRunId: ScrapeRunId;
  /**
   * CTP-490: when aborted, the run stops at the next item boundary, persists
   * what it has and closes the row with `completeness.reason = "aborted"`
   * instead of staying `running` until the process dies. A cancellable
   * connector request may stop in flight; persistence keeps its own failure
   * semantics and is never swallowed as a benign run abort.
   */
  signal?: AbortSignal;
  startedAt?: Date;
  now?: () => Date;
  wait?: Sleep;
  writeNow?: () => Date;
}

/**
 * RJC-397: whether this run saw the source's WHOLE listing. Only a complete
 * run may count unseen records as missed. A run is incomplete when it
 * resumed from a persisted checkpoint (earlier pages were seen by another
 * attempt, not this one) or when a connector reported a page cap
 * (`ConnectorDiscoverResult.truncated`), or when the caller's `signal`
 * aborted it before the last page (`aborted`). A failed run never returns a
 * result at all, so failure is covered by the throw, not by this flag.
 */
export type RunCompleteness =
  | { complete: true }
  | {
      complete: false;
      reason: "aborted" | "empty" | "resumed" | "truncated";
    };

export type RunIncompleteReason = Exclude<
  RunCompleteness,
  { complete: true }
>["reason"];

export interface ConnectorRunResult {
  checkpoint: ConnectorCheckpoint;
  completeness: RunCompleteness;
  fenceToken: number;
  metrics: ConnectorRunMetrics;
  /**
   * Every bron_referentie the listing showed this run, including rejected
   * items and items the known-hash short-circuit skipped fetching: the
   * source still lists them, so they are not missed.
   */
  observedBronReferenties: string[];
  writtenRecords: number;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- this is the Promise catch boundary for request abort values from fetch, Effect, and AbortSignal.reason. */
const isRunAbort = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true &&
  (error === signal.reason ||
    isAbortLike(error) ||
    (isReadIoFault(error) && error._tag === "cancel"));
/* oxlint-enable anti-slop/no-unknown-parameters */

const retryRequest = async <Result>(
  operation: () => Promise<Result>,
  retryPolicy: RetryPolicy,
  wait: Sleep | undefined,
  signal: AbortSignal | undefined
): Promise<Result> => {
  try {
    return await withRetry(operation, retryPolicy, wait, signal);
  } catch (error: unknown) {
    if (isRunAbort(error, signal)) {
      throw new ConnectorRequestAbortedError(error);
    }
    throw error;
  }
};

const request = <Result>(
  operation: () => Promise<Result>,
  bronId: BronId,
  limiter: RequestLimiter,
  retryPolicy: RetryPolicy,
  wait?: Sleep,
  signal?: AbortSignal
): Promise<Result> => {
  const limitedOperation = async (): Promise<Result> => {
    try {
      await limiter.acquire(bronId, signal);
      return await operation();
    } catch (error) {
      if (isRunAbort(error, signal)) {
        throw new ConnectorRequestAbortedError(error);
      }
      throw error;
    }
  };
  return retryRequest(limitedOperation, retryPolicy, wait, signal);
};

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/**
 * An aborted page keeps the checkpoint it started from: the items it did not
 * reach were never observed, so the page is not done. A signal that fires
 * after the last page changes nothing: the listing was read in full.
 */
const settlePage = (
  discovery: ConnectorDiscoverResult,
  pageAborted: boolean,
  startCheckpoint: ConnectorCheckpoint | null,
  signal: AbortSignal | undefined
) => {
  const aborted = pageAborted || (discovery.hasMore && isAborted(signal));
  return {
    aborted,
    checkpoint: pageAborted ? startCheckpoint : discovery.checkpoint,
    hasMore: discovery.hasMore && !aborted,
  };
};

const resolveCompleteness = (
  resumed: boolean,
  truncated: boolean,
  aborted: boolean
): RunCompleteness => {
  if (aborted) {
    return { complete: false, reason: "aborted" };
  }
  if (resumed) {
    return { complete: false, reason: "resumed" };
  }
  if (truncated) {
    return { complete: false, reason: "truncated" };
  }
  return { complete: true };
};

// oxlint-disable-next-line complexity -- the run state machine keeps request, persistence, and ownership outcomes distinct
const runConnectorInner = async (
  input: ConnectorRunInput
): Promise<ConnectorRunResult> => {
  const {
    bronId,
    bronSlug,
    connector,
    limiter,
    objectStore,
    observationRecorder,
    rawRetentionDays,
    retryPolicy,
    runKind,
    runLifecycleStore,
    scrapeRunId,
    signal,
    startedAt = new Date(),
    now = () => new Date(),
    wait,
  } = input;
  const writeNow = input.writeNow ?? now;
  if (connector.bronId !== bronId) {
    throw new Error("connector bronId does not match run bronId");
  }
  if (!Number.isInteger(rawRetentionDays) || rawRetentionDays < 1) {
    throw new Error("rawRetentionDays must be a positive integer");
  }

  const checkpointKey = { bronId, scrapeRunId };
  const requestedProgress: ConnectorRunProgress = {
    checkpoint: input.checkpoint ?? null,
    metrics: emptyRunMetrics(),
  };
  const queueStartedMs = monotonicNowMs();
  const canonicalRun = await runLifecycleStore.start({
    key: checkpointKey,
    mode: input.checkpoint === undefined ? "resume" : "reset",
    progress: structuredClone(requestedProgress),
    runKind,
    startedAt,
  });
  currentCriticalPathSession()?.recordSample({
    durationMs: Math.round(monotonicNowMs() - queueStartedMs),
    endedAt: new Date().toISOString(),
    label: "ingest-queuewait",
    startedAt: new Date().toISOString(),
    success: true,
  });
  const progress = structuredClone(canonicalRun.progress);
  let { checkpoint } = progress;
  const { metrics } = progress;
  const observedAt = canonicalRun.startedAt;
  let writtenRecords = metrics.new + metrics.changed;
  let hasMore = true;
  const countedObservations = new Set<string>();
  const observedBronReferenties = new Set<string>();
  const resumed = checkpoint !== null;
  let truncated = false;
  let aborted = false;

  const reportProgress = (phase: "fetch" | "persist"): Promise<void> =>
    input.onProgress?.({
      fenceToken: canonicalRun.fenceToken,
      key: checkpointKey,
      observedAt: writeNow(),
      phase,
    }) ?? Promise.resolve();

  const completeAbortedRun = async (): Promise<ConnectorRunResult> => {
    aborted = true;
    progress.checkpoint = checkpoint;
    await withFailureEnvelope(
      () =>
        runLifecycleStore.checkpoint(
          checkpointKey,
          structuredClone(progress),
          canonicalRun.fenceToken
        ),
      FAILURE_ENVELOPES.checkpoint
    );
    await withFailureEnvelope(
      () =>
        runLifecycleStore.complete({
          fenceToken: canonicalRun.fenceToken,
          finishedAt: now(),
          key: checkpointKey,
          progress: structuredClone(progress),
        }),
      FAILURE_ENVELOPES.complete
    );
    return {
      checkpoint: checkpoint ?? {},
      completeness: resolveCompleteness(resumed, truncated, aborted),
      fenceToken: canonicalRun.fenceToken,
      metrics,
      observedBronReferenties: [...observedBronReferenties],
      writtenRecords,
    };
  };

  const persistItem = async (
    item: DiscoverItem,
    itemObservedAt: Date
  ): Promise<void> => {
    // Before the limiter: an unchanged page must not cost a crawl-delay slot.
    if (connector.skipFetch && (await connector.skipFetch(item))) {
      await reportProgress("fetch");
      return;
    }
    const fetched = await withFailureEnvelope(
      () =>
        timeCriticalPathPhase("ingest-fetch", () =>
          connector.fetchUsesNetwork === false
            ? retryRequest(
                () => connector.fetch(item, signal),
                retryPolicy,
                wait,
                signal
              )
            : request(
                () => connector.fetch(item, signal),
                bronId,
                limiter,
                retryPolicy,
                wait,
                signal
              )
        ),
      FAILURE_ENVELOPES.fetch
    );
    await reportProgress("fetch");
    if (fetched === null) {
      return;
    }
    if (fetched.status === "rejected") {
      metrics.rejected += 1;
      return;
    }
    const contentHash =
      fetched.contentHash || (await hashContent(fetched.body));
    // CTP-500: the one place a connector's reference becomes a stored key.
    const bronReferentie = boundBronReferentie(fetched.bronReferentie);
    // RJC-386: content-addressed so every new raw object is digest-validated
    // on readback (see RawObjectDigestMismatchError). Legacy buildRawObjectPath
    // keys stay readable unverified; this is the only writer, so all new
    // writes go through the content-addressed scheme from here on.
    const rawPayloadRef = buildContentAddressedRawObjectPath({
      bronSlug,
      contentHash,
      contentType: fetched.contentType,
      startedAt: itemObservedAt,
    });
    await withFailureEnvelope(
      () =>
        timeCriticalPathPhase("ingest-raw-write", () =>
          // Content-addressed put is retry-safe by design (the dedup
          // short-circuit + sidecar-before-body ordering recover a partial
          // write), so a transient object-store error must not fail a run
          // that already fetched hundreds of items (CTP-609: ASML poll died
          // on a single RAW_STORE_WRITE_FAILED mid-run).
          withRetry(
            () =>
              objectStore.put({
                body: fetched.body,
                contentType: fetched.contentType,
                expiresAt: new Date(
                  writeNow().getTime() + rawRetentionDays * DAY_IN_MILLISECONDS
                ),
                path: rawPayloadRef,
              }),
            retryPolicy,
            wait,
            signal
          )
        ),
      FAILURE_ENVELOPES.rawStore
    );
    const sourceRecord = await withFailureEnvelope(
      () =>
        observationRecorder.record({
          fenceToken: canonicalRun.fenceToken,
          key: checkpointKey,
          observation: {
            bronId,
            bronReferentie,
            contentHash,
            contentType: fetched.contentType,
            contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
            observedAt: itemObservedAt.toISOString(),
            rawPayloadRef,
            scrapeRunId,
          },
          sourceRecord: {
            bronId,
            bronReferentie,
            contentHash,
            // RJC-357: persist the discover pass's listing-tier hash next to
            // the payload hash so the next poll's known-hash short-circuit
            // compares like with like.
            listingHash: item.contentHash,
            rawPayloadRef,
            scrapeRunId,
          },
        }),
      FAILURE_ENVELOPES.observation
    );
    const observationKey = `${bronReferentie}\0${contentHash}`;
    if (countedObservations.has(observationKey)) {
      return;
    }
    countedObservations.add(observationKey);
    if (sourceRecord.outcome === "new") {
      metrics.new += 1;
      writtenRecords += 1;
    } else if (sourceRecord.outcome === "changed") {
      metrics.changed += 1;
      writtenRecords += 1;
    } else if (sourceRecord.outcome === "unchanged") {
      metrics.unchanged += 1;
    }
    await reportProgress("persist");
  };

  /** Persists items in order; returns true when the signal cut the page short. */
  const persistPage = async (
    items: readonly DiscoverItem[],
    at: Date
  ): Promise<boolean> => {
    for (const item of items) {
      if (isAborted(signal)) {
        return true;
      }
      // CTP-500: missed-polls compares this set against stored keys.
      observedBronReferenties.add(boundBronReferentie(item.bronReferentie));
      // oxlint-disable-next-line no-await-in-loop -- crawl policy requires sequential fetches
      await persistItem(item, at);
    }
    return false;
  };

  try {
    while (hasMore) {
      const currentCheckpoint = checkpoint;
      // oxlint-disable-next-line no-await-in-loop -- page checkpoints require sequential discovery
      const discovery = await withFailureEnvelope(
        () =>
          timeCriticalPathPhase("ingest-discover", () =>
            request(
              () => connector.discover(currentCheckpoint, signal),
              bronId,
              limiter,
              retryPolicy,
              wait,
              signal
            )
          ),
        FAILURE_ENVELOPES.discover
      );
      // oxlint-disable-next-line no-await-in-loop -- report an actual completed discovery before fetching the page
      await reportProgress("fetch");
      metrics.found += discovery.items.length;
      truncated ||= discovery.truncated === true;

      // oxlint-disable-next-line no-await-in-loop -- crawl policy requires sequential fetches
      const pageAborted = await persistPage(discovery.items, observedAt);
      const page = settlePage(discovery, pageAborted, checkpoint, signal);
      ({ aborted, checkpoint } = page);
      progress.checkpoint = checkpoint;
      // oxlint-disable-next-line no-await-in-loop -- checkpoint and cumulative metrics persist atomically
      await withFailureEnvelope(
        () =>
          runLifecycleStore.checkpoint(
            checkpointKey,
            structuredClone(progress),
            canonicalRun.fenceToken
          ),
        FAILURE_ENVELOPES.checkpoint
      );
      ({ hasMore } = page);
    }
    await withFailureEnvelope(
      () =>
        runLifecycleStore.complete({
          fenceToken: canonicalRun.fenceToken,
          finishedAt: now(),
          key: checkpointKey,
          progress: structuredClone(progress),
        }),
      FAILURE_ENVELOPES.complete
    );
  } catch (error) {
    if (error instanceof ConnectorRequestAbortedError && signal?.aborted) {
      return completeAbortedRun();
    }
    if (error instanceof RunOwnershipLostError) {
      throw error;
    }
    const runError =
      error instanceof ConnectorRunFailure
        ? error
        : new ConnectorRunFailure(FAILURE_ENVELOPES.unknown, error);
    metrics.error += 1;
    progress.checkpoint = checkpoint;
    try {
      await runLifecycleStore.fail({
        failure: runError.envelope,
        fenceToken: canonicalRun.fenceToken,
        finishedAt: now(),
        key: checkpointKey,
        progress: structuredClone(progress),
      });
    } catch (persistenceError) {
      if (persistenceError instanceof RunOwnershipLostError) {
        throw persistenceError;
      }
      // oxlint-disable-next-line preserve-caught-error -- AggregateError carries the original as cause and first error
      throw new AggregateError(
        [runError, persistenceError],
        "Connector run failed and failure persistence also failed",
        { cause: runError }
      );
    }
    throw runError;
  }

  return {
    checkpoint: checkpoint ?? {},
    completeness: resolveCompleteness(resumed, truncated, aborted),
    fenceToken: canonicalRun.fenceToken,
    metrics,
    observedBronReferenties: [...observedBronReferenties],
    writtenRecords,
  };
};

export const runConnector = async (
  input: ConnectorRunInput
): Promise<ConnectorRunResult> => {
  const execute = (): Promise<ConnectorRunResult> => runConnectorInner(input);
  if (!isCriticalPathEnabled()) {
    return execute();
  }

  const runStartedMs = monotonicNowMs();
  const session = createCriticalPathSession({
    metadata: buildWorkloadMetadata(),
    runKind: resolveRunKind(),
  });

  try {
    const result = await withCriticalPathSession(session, execute);
    const elapsedMs = Math.max(1, Math.round(monotonicNowMs() - runStartedMs));
    const recordsPerSecond = (
      (result.writtenRecords * 1000) /
      elapsedMs
    ).toFixed(3);
    session.mergeMetadata({
      "freshness-ms": String(
        Date.now() - (input.startedAt ?? new Date()).getTime()
      ),
      "records-per-second": recordsPerSecond,
    });
    await session.flush();
    return result;
  } catch (error) {
    await session.flush();
    throw error;
  }
};
