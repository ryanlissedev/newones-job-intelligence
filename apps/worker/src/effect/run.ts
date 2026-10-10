import { Cause, Effect, Exit } from "effect";

import {
  isAbortLike,
  isWorkerFault,
  mapUnknownToWorkerFault,
  WorkerCancelFault,
} from "./faults";
import type { WorkerFault } from "./faults";

export interface RunWorkerPromiseOptions {
  signal?: AbortSignal;
}

/**
 * Per-task Promise SDK boundary for opt-in worker Effect programs (CTP-476 Slice 10).
 * Rethrows typed WorkerFaults; Abort/interrupt maps to WorkerCancelFault.
 *
 * ADR-0014: Runtime lifetime is per task invocation (via AbortSignal), not process-global.
 * Trigger.dev keeps durability / maxAttempts — this boundary does not replace the Trigger runtime.
 * Production Effect activation stays OFF — callers opt in explicitly.
 */
export const runWorkerPromise = async <A>(
  effect: Effect.Effect<A, WorkerFault>,
  options: RunWorkerPromiseOptions = {}
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, {
    signal: options.signal,
  });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (isWorkerFault(error)) {
    throw error;
  }
  if (
    Cause.hasInterrupts(exit.cause) ||
    options.signal?.aborted ||
    isAbortLike(error)
  ) {
    throw new WorkerCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (Cause.hasDies(exit.cause)) {
    throw error instanceof Error
      ? error
      : new Error("Programmer defect in worker Effect task boundary", {
          cause: error,
        });
  }
  throw mapUnknownToWorkerFault(error);
};
