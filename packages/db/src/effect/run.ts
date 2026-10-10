import { Cause, Effect, Exit } from "effect";

import {
  DbStoreCancelFault,
  isAbortLike,
  isDbStoreFault,
  mapUnknownToDbStoreFault,
} from "./faults";
import type { DbStoreFault } from "./faults";

export interface RunDbStorePromiseOptions {
  signal?: AbortSignal;
}

/**
 * Promise SDK boundary for opt-in DB store Effect wrappers (CTP-473 Slice 8).
 * Rethrows typed DbStoreFaults; Abort/interrupt maps to DbStoreCancelFault;
 * programmer defects rethrow as-is rather than being swallowed as faults.
 */
export const runDbStorePromise = async <A>(
  effect: Effect.Effect<A, DbStoreFault>,
  options: RunDbStorePromiseOptions = {}
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, {
    signal: options.signal,
  });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (isDbStoreFault(error)) {
    throw error;
  }
  if (
    Cause.hasInterrupts(exit.cause) ||
    options.signal?.aborted ||
    isAbortLike(error)
  ) {
    throw new DbStoreCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (Cause.hasDies(exit.cause)) {
    throw error instanceof Error
      ? error
      : new Error("Programmer defect in DB store Effect wrapper", {
          cause: error,
        });
  }
  throw mapUnknownToDbStoreFault(error);
};
