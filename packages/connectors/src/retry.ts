export interface RetryPolicy {
  initialDelayMs: number;
  jitter?: RetryJitter;
  maxAttempts: number;
  maxDelayMs: number;
  multiplier: number;
  retryable?: (error: Error) => boolean;
}

export type Sleep = (
  milliseconds: number,
  signal?: AbortSignal
) => Promise<void>;
export type RetryJitter = (delayMs: number, attempt: number) => number;

export const fullJitter: RetryJitter = (delayMs) =>
  Math.floor(Math.random() * (delayMs + 1));

const abortError = (): DOMException =>
  new DOMException("The operation was aborted", "AbortError");

export const sleep: Sleep = (milliseconds, signal) => {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  let timer: ReturnType<typeof setTimeout>;
  let rejectPromise: ((reason?: Error) => void) | undefined;
  const onAbort = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    rejectPromise?.(abortError());
  };
  // oxlint-disable-next-line promise/avoid-new -- timers have no promise API
  return new Promise((resolve, reject) => {
    rejectPromise = reject;
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/** Awaits a shared operation without allowing one caller's cancellation to cancel it. */
export const awaitWithSignal = <Result>(
  operation: Promise<Result>,
  signal?: AbortSignal
): Promise<Result> => {
  if (!signal) {
    return operation;
  }
  if (signal.aborted) {
    // The shared operation may reject after this caller has gone away. Keep a
    // rejection observer attached so cancellation does not create an orphan.
    void (async () => {
      try {
        await operation;
      } catch {
        // The caller is already cancelled; this observes the shared rejection.
      }
    })();
    throw abortError();
  }
  // oxlint-disable-next-line promise/avoid-new, promise/param-names -- races a shared promise against a caller-owned signal
  return new Promise<Result>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      try {
        const value = await operation;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      } catch (error: unknown) {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    })();
  });
};

const validateRetryPolicy = (policy: RetryPolicy): void => {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("retry policy maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(policy.initialDelayMs) || policy.initialDelayMs < 0) {
    throw new Error(
      "retry policy initialDelayMs must be a non-negative integer"
    );
  }
  if (!Number.isInteger(policy.maxDelayMs) || policy.maxDelayMs < 0) {
    throw new Error("retry policy maxDelayMs must be a non-negative integer");
  }
  if (policy.initialDelayMs > policy.maxDelayMs) {
    throw new Error(
      "retry policy initialDelayMs cannot exceed retry policy maxDelayMs"
    );
  }
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) {
    throw new Error("retry policy multiplier must be finite and at least one");
  }
};

export const withRetry = async <Result>(
  operation: () => Promise<Result>,
  policy: RetryPolicy,
  wait: Sleep = sleep,
  signal?: AbortSignal
): Promise<Result> => {
  validateRetryPolicy(policy);

  let delayMs = policy.initialDelayMs;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw abortError();
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- retries are deliberately sequential
      return await operation();
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const operationError =
        error instanceof Error ? error : new Error("Connector request failed");
      const retryable = policy.retryable?.(operationError) ?? true;
      if (!retryable || attempt === policy.maxAttempts) {
        throw error;
      }
      const cappedDelayMs = Math.min(delayMs, policy.maxDelayMs);
      const jitteredDelayMs = (policy.jitter ?? fullJitter)(
        cappedDelayMs,
        attempt
      );
      if (
        !Number.isFinite(jitteredDelayMs) ||
        !Number.isInteger(jitteredDelayMs) ||
        jitteredDelayMs < 0 ||
        jitteredDelayMs > cappedDelayMs
      ) {
        throw new Error(
          "retry policy jitter must return an integer within the capped delay",
          { cause: error }
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- backoff must precede the next attempt
      await awaitWithSignal(wait(jitteredDelayMs, signal), signal);
      delayMs = Math.min(
        Math.ceil(delayMs * policy.multiplier),
        policy.maxDelayMs
      );
    }
  }

  throw new Error("retry loop completed without a result");
};
