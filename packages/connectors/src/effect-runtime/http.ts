import { Effect } from "effect";

import { resolveEgressFetch } from "../egress";
import {
  mapHttpStatusToFault,
  mapUnknownToReadIoFault,
  ValidationFault,
} from "./faults";
import type { ReadIoFault } from "./faults";
import { defaultReadIoRetryPolicy, withReadIoRetry } from "./retry";

export type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface EffectHttpRequest {
  fetchImpl?: FetchImpl;
  init?: RequestInit;
  /** When true, non-2xx responses become typed faults (default true). */
  mapHttpErrors?: boolean;
  /** Source slug used for per-source egress routing when no fetchImpl is given (CTP-602). */
  sourceSlug?: string;
  url: string;
}

const mergeSignals = (
  outer: AbortSignal | undefined,
  effectSignal: AbortSignal
): AbortSignal => {
  if (!outer) {
    return effectSignal;
  }
  if (outer.aborted || effectSignal.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  outer.addEventListener("abort", onAbort, { once: true });
  effectSignal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
};

/** Single HTTP attempt with AbortSignal plumbing from Effect interruption. */
export const httpRequestOnce = (
  request: EffectHttpRequest
): Effect.Effect<Response, ReadIoFault> =>
  Effect.tryPromise({
    catch: mapUnknownToReadIoFault,
    try: async (signal) => {
      const fetchImpl =
        request.fetchImpl ?? resolveEgressFetch(request.sourceSlug);
      const merged = mergeSignals(request.init?.signal ?? undefined, signal);
      if (merged.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return await fetchImpl(request.url, {
        ...request.init,
        signal: merged,
      });
    },
  }).pipe(
    Effect.flatMap((response) => {
      if (request.mapHttpErrors === false || response.ok) {
        return Effect.succeed(response);
      }
      return Effect.fail(
        mapHttpStatusToFault({
          message: `HTTP ${response.status} for ${request.url}`,
          retryAfterHeader: response.headers.get("Retry-After"),
          status: response.status,
        })
      );
    })
  );

export const httpRequest = (
  request: EffectHttpRequest
): Effect.Effect<Response, ReadIoFault> =>
  withReadIoRetry(httpRequestOnce(request), defaultReadIoRetryPolicy);

export const readTextBody = (
  response: Response
): Effect.Effect<string, ReadIoFault> =>
  Effect.tryPromise({
    catch: mapUnknownToReadIoFault,
    try: async (signal) => {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return await response.text();
    },
  });

export const readJsonBody = <Payload>(
  response: Response
): Effect.Effect<Payload, ReadIoFault> =>
  readTextBody(response).pipe(
    Effect.flatMap((text) => {
      try {
        // SAFETY: callers validate fixture/DTO shape in adapter tests.
        return Effect.succeed(JSON.parse(text) as Payload);
      } catch (error) {
        return Effect.fail(
          new ValidationFault({
            cause: error,
            message: "Invalid JSON payload",
            status: response.status,
          })
        );
      }
    })
  );

/** Runs `onFinalize` after success, failure, or interrupt (scoped resource). */
export const withAbortFinalizer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  onFinalize: () => void
): Effect.Effect<A, E, R> =>
  Effect.acquireRelease(Effect.void, () => Effect.sync(onFinalize)).pipe(
    Effect.andThen(effect),
    Effect.scoped
  );
