import { isReadIoFault } from "./effect-runtime";
import type { ReadIoFault } from "./effect-runtime";
import { HttpTimeoutError } from "./http-timeout";
import { HttpStatusError } from "./json-ld/live-fetch";
import { SourceBlockedError } from "./source-blocked";

/**
 * Why a connector rejected one item instead of persisting it. Recorded per
 * run so an operator can tell "the source removed 40 jobs" from "our parser
 * stopped finding JobPosting on 40 pages" without reading free-text reasons.
 */
export type RejectKind = "gone" | "http_5xx" | "invalid" | "no_structured_data";

/**
 * Per-run counters of what happened to discovered items, beyond the
 * new/changed/rejected columns `scrape_run` already carries. `skipped_known`
 * is a fetch the connector short-circuited (known listing hash, e.g. an
 * unchanged sitemap lastmod) — the item was seen but never requested.
 */
export interface RunOutcomeCounts {
  readonly rejected_gone?: number;
  readonly rejected_http_5xx?: number;
  readonly rejected_invalid?: number;
  readonly rejected_no_structured_data?: number;
  readonly skipped_known?: number;
}

export type RunOutcome = keyof RunOutcomeCounts;

export const RUN_OUTCOMES = [
  "rejected_gone",
  "rejected_http_5xx",
  "rejected_invalid",
  "rejected_no_structured_data",
  "skipped_known",
] as const satisfies readonly RunOutcome[];

export const rejectOutcome = (kind: RejectKind | undefined): RunOutcome =>
  `rejected_${kind ?? "invalid"}`;

export const incrementOutcome = (
  counts: RunOutcomeCounts | undefined,
  outcome: RunOutcome
): RunOutcomeCounts => ({
  ...counts,
  [outcome]: (counts?.[outcome] ?? 0) + 1,
});

export const mergeOutcomeCounts = (
  left: RunOutcomeCounts | undefined,
  right: RunOutcomeCounts | undefined
): RunOutcomeCounts | undefined => {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  const merged: Partial<Record<RunOutcome, number>> = {};
  for (const outcome of RUN_OUTCOMES) {
    const total = (left?.[outcome] ?? 0) + (right?.[outcome] ?? 0);
    if (total > 0) {
      merged[outcome] = total;
    }
  }
  return merged;
};

/**
 * How a *succeeded* run ended. `status = 'succeeded'` alone hides partial
 * runs: a poll cut off by its run budget closes as succeeded with a
 * checkpoint, which made Techniekwerkt (8 of 9 runs at its 5.5 h budget)
 * look healthy. `budget_exhausted` is an abort caused by the run-budget
 * timer; `aborted` is any other abort (shutdown).
 */
export type RunCompletion =
  | "complete"
  | "budget_exhausted"
  | "aborted"
  | "truncated"
  | "resumed"
  | "empty";

export const RUN_COMPLETIONS = [
  "complete",
  "budget_exhausted",
  "aborted",
  "truncated",
  "resumed",
  "empty",
] as const satisfies readonly RunCompletion[];

/** Completions that mean the run did not see the source's whole listing. */
export const PARTIAL_RUN_COMPLETIONS = [
  "budget_exhausted",
  "aborted",
  "truncated",
] as const satisfies readonly RunCompletion[];

/**
 * True when an abort came from a timer (`AbortSignal.timeout`, which the
 * poller uses for the run budget) rather than from shutdown.
 */
export const isTimeoutAbort = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true &&
  signal.reason instanceof DOMException &&
  signal.reason.name === "TimeoutError";

/**
 * What kind of trouble failed a run, orthogonal to the phase envelope
 * (`failure_phase`/`failure_code` say *where*, this says *what*). The poller
 * and dashboard use it to tell a block from a timeout from a parser break.
 */
export type RunFailureKind =
  | "blocked"
  | "rate_limited"
  | "timeout"
  | "http_5xx"
  | "http_4xx"
  | "not_found"
  | "network"
  | "internal";

export const RUN_FAILURE_KINDS = [
  "blocked",
  "rate_limited",
  "timeout",
  "http_5xx",
  "http_4xx",
  "not_found",
  "network",
  "internal",
] as const satisfies readonly RunFailureKind[];

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

const kindForStatus = (status: number): RunFailureKind => {
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return "rate_limited";
  }
  if (status === HTTP_FORBIDDEN) {
    return "blocked";
  }
  if (status === HTTP_NOT_FOUND) {
    return "not_found";
  }
  if (status >= HTTP_SERVER_ERROR_MIN) {
    return "http_5xx";
  }
  if (status >= HTTP_CLIENT_ERROR_MIN) {
    return "http_4xx";
  }
  return "internal";
};

const READ_IO_FAULT_KINDS = {
  auth: "blocked",
  cancel: "internal",
  not_found: "not_found",
  rate_limit: "rate_limited",
  server_5xx: "http_5xx",
  transient_network: "network",
  validation: "http_4xx",
} as const satisfies Record<ReadIoFault["_tag"], RunFailureKind>;

const kindForReadIoFault = (fault: ReadIoFault): RunFailureKind =>
  READ_IO_FAULT_KINDS[fault._tag];

const MAX_CAUSE_DEPTH = 5;

/**
 * Classifies the error that failed a run. Walks `cause` because the runner
 * wraps connector errors in its phase envelope; the first recognised error
 * in the chain wins.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-boundary classifier for whatever a connector threw
export const classifyRunFailure = (error: unknown): RunFailureKind => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof SourceBlockedError) {
      return "blocked";
    }
    if (current instanceof HttpTimeoutError) {
      return "timeout";
    }
    if (current instanceof HttpStatusError) {
      return kindForStatus(current.status);
    }
    if (isReadIoFault(current)) {
      return kindForReadIoFault(current);
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      break;
    }
    current = current.cause;
  }
  return "internal";
};
