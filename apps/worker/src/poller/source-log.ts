/**
 * The per-source line the poll cycle writes (`poller_source`).
 *
 * Kept out of `main.ts` so the failure branch is reachable from a spec:
 * `main.ts` runs the poller on import, so nothing there can be tested.
 */
import { describeCauseChain, errorNameOf } from "@ji/db/error-cause-chain";
import { redactConnectionUrls } from "@ji/db/redact-connection-urls";

export interface PollerSourceLog {
  bronSlug: string;
  curated: number;
  durationMs: number;
  /**
   * Redacted and truncated cause chain; absent when there is no detail.
   *
   * Carries `error.message` plus each `cause` message joined with `" <- "`,
   * because the message that identifies the failure is usually not the
   * outermost one (CTP-499: `Curation failed for observation 7100e5cb-...`
   * told an operator nothing, while its cause named the oversized index row).
   */
  errorMessage?: string;
  errorName?: string;
  found: number;
  remaining: number;
  skippedReason?: "already_running";
}

export const alreadyRunningSourceLog = (input: {
  bronSlug: string;
  durationMs: number;
}): PollerSourceLog => ({
  bronSlug: input.bronSlug,
  curated: 0,
  durationMs: input.durationMs,
  found: 0,
  remaining: 0,
  skippedReason: "already_running",
});

/**
 * Long enough to carry an HTTP status plus the failing URL path, short enough
 * that one bad source cannot dominate a cycle's log volume.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Redacts first, then truncates, so a cut can never expose half a secret.
 *
 * The redaction itself lives in `@ji/db` so the poller and `curateScrapeRun`
 * share one policy; only the length cap is this log line's own concern.
 */
export const redactErrorMessage = (message: string): string => {
  const redacted = redactConnectionUrls(message);
  return redacted.length > MAX_ERROR_MESSAGE_LENGTH
    ? redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)
    : redacted;
};

export interface FailedSourceLogInput {
  bronSlug: string;
  durationMs: number;
  error: unknown;
}

/**
 * The `poller_source` line for a source that threw. `errorName` alone was not
 * enough to act on: a production line read `{"errorName":"Error"}` with no
 * indication of what failed. Neither was the outermost message alone -- see
 * `errorMessage` above.
 */
export const failedSourceLog = (
  input: FailedSourceLogInput
): PollerSourceLog => {
  const { bronSlug, durationMs, error } = input;
  const log: PollerSourceLog = {
    bronSlug,
    curated: 0,
    durationMs,
    errorName: errorNameOf({ error }),
    found: 0,
    remaining: 0,
  };
  // Redaction runs over the whole joined chain, not per link, so a connection
  // string cannot survive by straddling a separator.
  const errorMessage = redactErrorMessage(describeCauseChain({ error }));
  if (errorMessage !== "") {
    log.errorMessage = errorMessage;
  }
  return log;
};
