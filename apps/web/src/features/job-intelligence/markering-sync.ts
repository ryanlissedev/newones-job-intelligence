import { CapabilityRequestError } from "./rest/capability-client";
import { runAsync } from "./run-async";
import type { JobMarkering } from "./types";

/**
 * Marker readback is monotone by server revision. Repeated polls and a tab
 * reconnect therefore become no-ops once the UI has the same resource state.
 */
export const hasNewerMarkering = (
  current: JobMarkering | null | undefined,
  next: JobMarkering | null
): boolean => {
  if (current?.revision !== undefined && next?.revision !== undefined) {
    return next.revision > current.revision;
  }
  if (!current || !next) {
    return current !== next;
  }
  return current.status !== next.status || current.reden !== next.reden;
};

export interface MarkeringReadbackState {
  readonly initialized: boolean;
  readonly markering: JobMarkering | null;
  /** Highest durable revision observed, retained across a clear readback. */
  readonly revision: number | null;
  /** A first poll clear has no revision, so detail must wait for a poll row. */
  readonly pollClearObserved: boolean;
}

export type MarkeringReadbackSource = "detail" | "mutation" | "poll";

export const emptyMarkeringReadbackState = (): MarkeringReadbackState => ({
  initialized: false,
  markering: null,
  pollClearObserved: false,
  revision: null,
});

const shouldIgnoreLateDetailAfterInitialPollClear = (
  current: MarkeringReadbackState,
  next: JobMarkering | null,
  source: MarkeringReadbackSource
): boolean =>
  source === "detail" &&
  current.pollClearObserved &&
  current.revision === null &&
  next !== null;

const mergeNullMarkeringReadback = (
  current: MarkeringReadbackState,
  source: MarkeringReadbackSource
): MarkeringReadbackState => {
  // Detail responses contain no tombstone revision, so a late null cannot
  // prove that it is newer than a durable marker already observed by poll.
  // Let the versioned marker endpoint own clears; its null is the explicit
  // readback of the current marker resource.
  if (source === "detail" && current.revision !== null) {
    return current;
  }

  const pollClearObserved = current.pollClearObserved || source === "poll";
  if (current.markering === null) {
    if (current.pollClearObserved === pollClearObserved) {
      return current;
    }
    return { ...current, pollClearObserved };
  }
  return { ...current, markering: null, pollClearObserved };
};

/**
 * Merge one resource-scoped read into the state already observed by the open
 * detail. A null poll read is a real clear, but it carries no row of its own;
 * keep the last revision as a floor so a late detail response cannot
 * resurrect the cleared marker. A null detail read has no tombstone revision
 * and cannot prove that it is newer than an observed poll. Recreated markers
 * must therefore carry a strictly newer durable revision.
 */
export const mergeMarkeringReadback = (
  current: MarkeringReadbackState,
  next: JobMarkering | null,
  source: MarkeringReadbackSource
): MarkeringReadbackState => {
  if (!current.initialized) {
    return {
      initialized: true,
      markering: next,
      pollClearObserved: source === "poll" && next === null,
      revision: next?.revision ?? null,
    };
  }

  // A first poll can observe a clear before the slower detail request returns
  // an older marker. There is no revision on the clear to reject that detail
  // response, so wait for the next authoritative poll row instead.
  if (shouldIgnoreLateDetailAfterInitialPollClear(current, next, source)) {
    return current;
  }

  const nextRevision = next?.revision;
  if (
    nextRevision !== undefined &&
    current.revision !== null &&
    nextRevision <= current.revision
  ) {
    return current;
  }

  if (next === null) {
    return mergeNullMarkeringReadback(current, source);
  }

  if (nextRevision !== undefined) {
    return {
      initialized: true,
      markering: next,
      pollClearObserved: false,
      revision: nextRevision,
    };
  }

  // A fixture or legacy detail response without a revision must not be able
  // to resurrect a marker after a durable revision has already been cleared.
  if (current.revision !== null) {
    return current;
  }

  if (!current.markering) {
    return { ...current, markering: next, pollClearObserved: false };
  }

  return hasNewerMarkering(current.markering, next)
    ? { ...current, markering: next, pollClearObserved: false }
    : current;
};

const DEFINITIVE_PRE_COMMIT_FAILURE_STATUSES = new Set([
  400, 401, 403, 404, 422,
]);

/**
 * Only errors that prove the mutation was rejected before persistence are
 * failures. Timeouts, conflicts, rate limits, and all other transport/server
 * outcomes may arrive after the server committed and therefore remain
 * uncertain until the scoped readback settles them.
 */
export const markeringMutationOutcome = (
  error: Error
): "failure" | "uncertain" =>
  error instanceof CapabilityRequestError &&
  DEFINITIVE_PRE_COMMIT_FAILURE_STATUSES.has(error.status)
    ? "failure"
    : "uncertain";

interface MarkeringPollingVisibility {
  readonly visibilityState: Document["visibilityState"];
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

interface MarkeringPollingClock {
  setInterval: (handler: () => void, timeout: number) => number;
  clearInterval: (interval: number) => void;
  setTimeout: (handler: () => void, timeout: number) => number;
  clearTimeout: (timeout: number) => void;
}

interface StartMarkeringPollingInput {
  readonly clock?: MarkeringPollingClock;
  readonly getMarkering: (
    resourceId: string,
    signal: AbortSignal
  ) => Promise<JobMarkering | null>;
  readonly intervalMs?: number;
  readonly onMarkering: (markering: JobMarkering | null) => void;
  readonly resourceId: string;
  readonly timeoutMs?: number;
  readonly visibility?: MarkeringPollingVisibility;
}

export const MARKERING_POLL_TIMEOUT_MS = 4000;

/**
 * Start bounded readback for one open resource. The environment is injectable
 * so cleanup, visibility and resource-switch behavior can be tested without a
 * browser renderer.
 */
export const startMarkeringPolling = ({
  clock = window,
  getMarkering,
  intervalMs = 5000,
  onMarkering,
  resourceId,
  timeoutMs = MARKERING_POLL_TIMEOUT_MS,
  visibility = document,
}: StartMarkeringPollingInput): (() => void) => {
  let active = true;
  let inFlight = false;
  let activeController: AbortController | null = null;

  const poll = async () => {
    if (!active || inFlight || visibility.visibilityState === "hidden") {
      return;
    }
    inFlight = true;
    const controller = new AbortController();
    activeController = controller;
    let timeout: number | null = null;
    try {
      // oxlint-disable-next-line promise/avoid-new -- bridges a cancellable native timer into Promise.race.
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = clock.setTimeout(() => {
          controller.abort();
          reject(new Error("Markering readback timed out"));
        }, timeoutMs);
      });
      const markering = await Promise.race([
        getMarkering(resourceId, controller.signal),
        timeoutPromise,
      ]);
      if (active) {
        onMarkering(markering);
      }
    } catch {
      // A transient read failure leaves the last known marker visible. A
      // later poll or visibility reconnect will reconcile it.
    } finally {
      if (timeout !== null) {
        clock.clearTimeout(timeout);
      }
      controller.abort();
      if (activeController === controller) {
        activeController = null;
      }
      inFlight = false;
    }
  };

  const onVisibilityChange = () => {
    if (visibility.visibilityState === "visible") {
      runAsync(poll);
    }
  };
  const schedulePoll = () => {
    runAsync(poll);
  };
  const interval = clock.setInterval(schedulePoll, intervalMs);
  visibility.addEventListener("visibilitychange", onVisibilityChange);
  schedulePoll();

  return () => {
    active = false;
    clock.clearInterval(interval);
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
    activeController?.abort();
  };
};
