import { Duration, Effect, Schedule } from "effect";

import { isRetryableReadIoFault } from "./faults";
import type { RateLimitFault, ReadIoFault } from "./faults";

/** Matches ADR-0013 / poll-bron-run request retry ceiling (maxAttempts: 3). */
export const DEFAULT_READ_IO_MAX_ATTEMPTS = 3;
export const DEFAULT_READ_IO_INITIAL_DELAY_MS = 250;
export const DEFAULT_READ_IO_MAX_DELAY_MS = 5000;

export interface ReadIoRetryPolicy {
  initialDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
}

export const defaultReadIoRetryPolicy: ReadIoRetryPolicy = {
  initialDelayMs: DEFAULT_READ_IO_INITIAL_DELAY_MS,
  maxAttempts: DEFAULT_READ_IO_MAX_ATTEMPTS,
  maxDelayMs: DEFAULT_READ_IO_MAX_DELAY_MS,
};

const cappedExponential = (
  policy: ReadIoRetryPolicy
): Schedule.Schedule<Duration.Duration, ReadIoFault> =>
  Schedule.exponential(`${policy.initialDelayMs} millis`).pipe(
    Schedule.setInputType<ReadIoFault>(),
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.millis(policy.maxDelayMs)))
    ),
    Schedule.addDelay(({ input }) => {
      if (input._tag !== "rate_limit") {
        return Effect.succeed(Duration.zero);
      }
      // SAFETY: `_tag === "rate_limit"` narrows the schedule input to RateLimitFault.
      const { retryAfterMs } = input as RateLimitFault;
      if (retryAfterMs === null) {
        return Effect.succeed(Duration.zero);
      }
      return Effect.succeed(Duration.millis(retryAfterMs));
    }),
    Schedule.jittered
  );

/**
 * Retry typed read-I/O faults within the ADR-0013 request budget.
 * `maxAttempts` counts the initial attempt; retries = maxAttempts - 1.
 */
export const withReadIoRetry = <A, R>(
  effect: Effect.Effect<A, ReadIoFault, R>,
  policy: ReadIoRetryPolicy = defaultReadIoRetryPolicy
): Effect.Effect<A, ReadIoFault, R> => {
  const retries = Math.max(0, policy.maxAttempts - 1);
  if (retries === 0) {
    return effect;
  }
  return Effect.retry(effect, {
    schedule: cappedExponential(policy),
    times: retries,
    while: isRetryableReadIoFault,
  });
};
