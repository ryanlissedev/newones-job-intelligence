import { TRPCError } from "@trpc/server";
import { Cause, Effect, Exit } from "effect";

import {
  ApiCancelFault,
  isAbortLike,
  isApiFault,
  mapUnknownToApiFault,
} from "./faults";
import type { ApiFault } from "./faults";

export interface RunApiPromiseOptions {
  signal?: AbortSignal;
}

export const apiFaultToTrpcCode = (
  fault: ApiFault
):
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "INTERNAL_SERVER_ERROR"
  | "CLIENT_CLOSED_REQUEST" => {
  switch (fault._tag) {
    case "unauthenticated": {
      return "UNAUTHORIZED";
    }
    case "forbidden": {
      return "FORBIDDEN";
    }
    case "validation": {
      return "BAD_REQUEST";
    }
    case "not_found": {
      return "NOT_FOUND";
    }
    case "cancel": {
      return "CLIENT_CLOSED_REQUEST";
    }
    default: {
      return "INTERNAL_SERVER_ERROR";
    }
  }
};

export const apiFaultToTrpcError = (fault: ApiFault): TRPCError =>
  new TRPCError({
    cause: fault,
    code: apiFaultToTrpcCode(fault),
    message: fault.message,
  });

/**
 * Per-request Promise SDK boundary for opt-in tRPC Effect programs (CTP-474).
 * Rethrows typed ApiFaults; Abort/interrupt → ApiCancelFault.
 * Use runApiPromiseAsTrpc to surface faults as TRPCError at the procedure edge.
 */
export const runApiPromise = async <A>(
  effect: Effect.Effect<A, ApiFault>,
  options: RunApiPromiseOptions = {}
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, {
    signal: options.signal,
  });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (isApiFault(error)) {
    throw error;
  }
  if (
    Cause.hasInterrupts(exit.cause) ||
    options.signal?.aborted ||
    isAbortLike(error)
  ) {
    throw new ApiCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (Cause.hasDies(exit.cause)) {
    throw error instanceof Error
      ? error
      : new Error("Programmer defect in @ji/api Effect boundary", {
          cause: error,
        });
  }
  throw mapUnknownToApiFault(error);
};

/**
 * Opt-in tRPC edge: run an Effect and map ApiFault → TRPCError.
 * Default protectedProcedure / publicProcedure stay Promise-native.
 */
export const runApiPromiseAsTrpc = async <A>(
  effect: Effect.Effect<A, ApiFault>,
  options: RunApiPromiseOptions = {}
): Promise<A> => {
  try {
    return await runApiPromise(effect, options);
  } catch (error) {
    if (isApiFault(error)) {
      throw apiFaultToTrpcError(error);
    }
    throw error;
  }
};
