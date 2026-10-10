export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
/** Maximum delay accepted by the Node/Bun timer implementation. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class HttpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

export const resolveHttpTimeoutMs = (timeoutMs?: number): number => {
  const resolved = timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("timeoutMs must be a positive finite number");
  }
  // setTimeout overflows above the signed 32-bit delay range. Keep the public
  // shape as any positive finite number while ensuring the timer stays bounded.
  return Math.min(resolved, MAX_TIMER_DELAY_MS);
};

/**
 * Runs one HTTP operation with a cancellable deadline. The same signal is
 * passed to fetch and remains active while the operation consumes its body.
 * Native fetch aborts both an in-flight request and its response stream, so
 * cancellation is the boundary rather than an uncancellable Promise.race.
 */
export const withHttpTimeout = async <Payload>(
  operation: (signal: AbortSignal) => Promise<Payload>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<Payload> => {
  const resolvedTimeoutMs = resolveHttpTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new HttpTimeoutError(resolvedTimeoutMs)),
    resolvedTimeoutMs
  );

  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
};
