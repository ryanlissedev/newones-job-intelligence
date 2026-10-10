import { Cause, Effect, Exit } from "effect";

import {
  isAbortLike,
  isUseCaseFault,
  mapUnknownToUseCaseFault,
  UseCaseCancelFault,
} from "./faults";
import type { UseCaseFault } from "./faults";

export interface RunUseCaseOptions {
  signal?: AbortSignal;
}

/**
 * Promise SDK boundary for application Effect programs (Slice 3).
 * Rethrows typed UseCaseFaults; Abort/interrupt → UseCaseCancelFault.
 */
export const runUseCasePromise = async <A>(
  effect: Effect.Effect<A, UseCaseFault>,
  options: RunUseCaseOptions = {}
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, {
    signal: options.signal,
  });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (isUseCaseFault(error)) {
    throw error;
  }
  if (
    Cause.hasInterrupts(exit.cause) ||
    options.signal?.aborted ||
    isAbortLike(error)
  ) {
    throw new UseCaseCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (Cause.hasDies(exit.cause)) {
    throw error instanceof Error
      ? error
      : new Error("Programmer defect in application Effect use-case", {
          cause: error,
        });
  }
  throw mapUnknownToUseCaseFault(error);
};
