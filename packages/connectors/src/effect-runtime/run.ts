import { Cause, Effect, Exit } from "effect";

import { CancelFault, isReadIoFault, mapUnknownToReadIoFault } from "./faults";
import type { ReadIoFault } from "./faults";

export interface RunReadIoOptions {
  signal?: AbortSignal;
}

/**
 * Promise/JSON SDK boundary: run an Effect and rethrow typed ReadIoFaults
 * (or wrap unknowns). Programmer defects stay recognizable via Cause.
 */
export const runReadIoPromise = async <A>(
  effect: Effect.Effect<A, ReadIoFault>,
  options: RunReadIoOptions = {}
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, {
    signal: options.signal,
  });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (isReadIoFault(error)) {
    throw error;
  }
  if (Cause.hasInterrupts(exit.cause) || options.signal?.aborted) {
    throw new CancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  // Preserve programmer errors (defects) rather than swallowing as network.
  if (Cause.hasDies(exit.cause)) {
    throw error instanceof Error
      ? error
      : new Error("Programmer defect in Effect read-I/O", { cause: error });
  }
  throw mapUnknownToReadIoFault(error);
};
