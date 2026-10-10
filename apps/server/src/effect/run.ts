import { Cause, Effect, Exit } from "effect";

import {
  isAbortLike,
  isTransportFault,
  mapUnknownToTransportFault,
  TransportCancelFault,
} from "./faults";
import type { TransportFault } from "./faults";

export interface RunTransportPromiseOptions {
  signal?: AbortSignal;
}

/**
 * Per-request Promise SDK boundary for opt-in server/API Effect programs
 * (CTP-474 Slice 9). Rethrows typed TransportFaults; Abort/interrupt maps to
 * TransportCancelFault; programmer defects rethrow as-is.
 *
 * ADR-0014: Runtime lifetime is per request (via AbortSignal), not process-global.
 * Production Effect activation stays OFF — callers opt in explicitly.
 */
export const runTransportPromise = async <A>(
  effect: Effect.Effect<A, TransportFault>,
  options: RunTransportPromiseOptions = {}
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, {
    signal: options.signal,
  });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (isTransportFault(error)) {
    throw error;
  }
  if (
    Cause.hasInterrupts(exit.cause) ||
    options.signal?.aborted ||
    isAbortLike(error)
  ) {
    throw new TransportCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (Cause.hasDies(exit.cause)) {
    throw error instanceof Error
      ? error
      : new Error("Programmer defect in server/API Effect transport boundary", {
          cause: error,
        });
  }
  throw mapUnknownToTransportFault(error);
};
