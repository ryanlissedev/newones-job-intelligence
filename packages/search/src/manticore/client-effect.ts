/* oxlint-disable anti-slop/no-unknown-parameters -- Effect tryPromise catch and Cause.squash deliver unknown at the Manticore I/O boundary; classify TimeoutError → ManticoreTimeoutError here (native parity). */
import { Cause, Effect, Exit } from "effect";

import type {
  ManticoreHttpClient,
  ManticoreRequestOptions,
  ManticoreTableInfo,
} from "./client";
import { parseManticoreBulkPayload, parseManticoreSearchPayload } from "./json";
import type {
  ManticoreBulkPayload,
  ManticoreDeleteBody,
  ManticoreReplaceBody,
  ManticoreSearchPayload,
  ManticoreSearchRequestBody,
} from "./json";
import { tableExistsInShowTables } from "./show-tables";
import { ManticoreTimeoutError } from "./timeout-error";

/**
 * Transport-level timeout for the fetch call itself (RJC-380) — a backstop
 * for Manticore never responding at all (hung process, network partition),
 * which max_query_time (client.ts) cannot protect against since it only
 * bounds query execution *inside* a request Manticore is actually
 * processing. Set comfortably above DEFAULT_MAX_QUERY_TIME_MS so a healthy
 * server has room to hit its own query-time budget and reply with a partial
 * result before the transport gives up; the ~3s gap covers network latency
 * and parsing a near-max_matches response body.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_DESCRIBE_TABLE_TIMEOUT_MS = 1500;

export type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface FetchManticoreEffectClientOptions {
  fetchImpl?: FetchImpl;
  /** Optional outer AbortSignal for the Promise SDK boundary. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

const mergeSignals = (
  outer: AbortSignal | undefined,
  effectSignal: AbortSignal
): AbortSignal =>
  outer === undefined ? effectSignal : AbortSignal.any([outer, effectSignal]);

const mapPostError = (
  url: string,
  timeoutMs: number,
  error: unknown
): Error => {
  // catch bindings / Effect catch callbacks are always `unknown` by language rule
  // — narrow with instanceof rather than trusting a typed decoder.
  const isAbortTimeout =
    error instanceof DOMException && error.name === "TimeoutError";
  if (isAbortTimeout) {
    return new ManticoreTimeoutError(url, timeoutMs);
  }
  return error instanceof Error ? error : new Error(String(error));
};

/**
 * Promise/JSON SDK boundary for search Effect programs (Slice 7).
 * Preserves ManticoreTimeoutError and other Errors; maps interrupt/abort.
 */
export const runManticorePromise = async <A>(
  effect: Effect.Effect<A, Error>,
  options: { signal?: AbortSignal } = {}
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, {
    signal: options.signal,
  });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (Cause.hasInterrupts(exit.cause) || options.signal?.aborted) {
    const reason = options.signal?.reason;
    throw reason instanceof Error
      ? reason
      : new DOMException("Aborted", "AbortError");
  }
  if (error instanceof Error) {
    throw error;
  }
  if (Cause.hasDies(exit.cause)) {
    throw error instanceof Error
      ? error
      : new Error("Programmer defect in Manticore Effect client", {
          cause: error,
        });
  }
  throw error instanceof Error ? error : new Error(String(error));
};

export const postManticoreEffect = (input: {
  body: string;
  contentType: string;
  fetchImpl?: FetchImpl;
  timeoutMs: number;
  url: string;
}): Effect.Effect<Response, Error> =>
  Effect.tryPromise({
    catch: (error) => mapPostError(input.url, input.timeoutMs, error),
    try: async (signal) => {
      const fetchImpl = input.fetchImpl ?? fetch;
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const merged = mergeSignals(timeoutSignal, signal);
      if (merged.aborted) {
        // Prefer TimeoutError when the timeout side already fired so callers
        // keep seeing ManticoreTimeoutError (native parity).
        if (timeoutSignal.aborted) {
          throw new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError"
          );
        }
        throw new DOMException("Aborted", "AbortError");
      }
      return await fetchImpl(input.url, {
        body: input.body,
        headers: { "Content-Type": input.contentType },
        method: "POST",
        signal: merged,
      });
    },
  });

export const requestManticoreEffect = (input: {
  baseUrl: string;
  body: ManticoreDeleteBody | ManticoreReplaceBody | ManticoreSearchRequestBody;
  fetchImpl?: FetchImpl;
  path: string;
  timeoutMs: number;
}): Effect.Effect<ManticoreSearchPayload, Error> => {
  const url = `${input.baseUrl}${input.path}`;
  return postManticoreEffect({
    body: JSON.stringify(input.body),
    contentType: "application/json",
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    url,
  }).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        try: async () => {
          const raw = await response.text();
          if (!response.ok) {
            let message = response.statusText;
            try {
              message = parseManticoreSearchPayload(raw).error ?? message;
            } catch {
              // non-JSON error body — statusText already set above
            }
            throw new Error(
              `Manticore request failed (${response.status}): ${message}`
            );
          }
          return parseManticoreSearchPayload(raw);
        },
      })
    )
  );
};

export const bulkManticoreEffect = (input: {
  baseUrl: string;
  fetchImpl?: FetchImpl;
  lines: readonly string[];
  timeoutMs: number;
}): Effect.Effect<ManticoreBulkPayload, Error> => {
  const url = `${input.baseUrl}/bulk`;
  return postManticoreEffect({
    body: `${input.lines.join("\n")}\n`,
    contentType: "application/x-ndjson",
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    url,
  }).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        try: async () => {
          const raw = await response.text();
          try {
            return parseManticoreBulkPayload(raw);
          } catch (error) {
            if (response.ok) {
              throw error;
            }
            throw new Error(
              `Manticore bulk request failed (${response.status}): ${response.statusText}`,
              { cause: error }
            );
          }
        },
      })
    )
  );
};

export const describeManticoreTableEffect = (input: {
  baseUrl: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  tableName: string;
  timeoutMs?: number;
}): Effect.Effect<ManticoreTableInfo, Error> => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_DESCRIBE_TABLE_TIMEOUT_MS;
  const url = `${input.baseUrl}/sql?mode=raw`;
  return Effect.tryPromise({
    catch: (error) => mapPostError(url, timeoutMs, error),
    try: async (effectSignal) => {
      const fetchImpl = input.fetchImpl ?? fetch;
      const timeoutSignal =
        input.signal === undefined ? AbortSignal.timeout(timeoutMs) : undefined;
      const outer = input.signal ?? timeoutSignal;
      const merged = mergeSignals(outer, effectSignal);
      if (merged.aborted) {
        if (timeoutSignal?.aborted) {
          throw new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError"
          );
        }
        throw new DOMException("Aborted", "AbortError");
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          body: `query=${encodeURIComponent("SHOW TABLES")}`,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
          signal: merged,
        });
      } catch (error) {
        throw mapPostError(url, timeoutMs, error);
      }
      if (!response.ok) {
        throw new Error(
          `Manticore SHOW TABLES failed (${response.status}): ${response.statusText}`
        );
      }
      const raw = await response.text();
      return { exists: tableExistsInShowTables(raw, input.tableName) };
    },
  });
};

/**
 * Effect-backed Manticore HTTP client behind the {@link ManticoreHttpClient}
 * Promise SDK surface. The only search transport since CTP-627:
 * `ManticoreSearchEngine.fromUrl` always constructs it.
 */
export class FetchManticoreEffectClient implements ManticoreHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl | undefined;
  private readonly outerSignal: AbortSignal | undefined;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
    options: FetchManticoreEffectClientOptions = {}
  ) {
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? timeoutMs;
    this.fetchImpl = options.fetchImpl;
    this.outerSignal = options.signal;
  }

  bulk(lines: readonly string[]): Promise<ManticoreBulkPayload> {
    return runManticorePromise(
      bulkManticoreEffect({
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl,
        lines,
        timeoutMs: this.timeoutMs,
      }),
      { signal: this.outerSignal }
    );
  }

  request(
    path: string,
    body:
      | ManticoreDeleteBody
      | ManticoreReplaceBody
      | ManticoreSearchRequestBody,
    options: ManticoreRequestOptions = {}
  ): Promise<ManticoreSearchPayload> {
    return runManticorePromise(
      requestManticoreEffect({
        baseUrl: this.baseUrl,
        body,
        fetchImpl: this.fetchImpl,
        path,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
      }),
      { signal: this.outerSignal }
    );
  }
}

/** Promise helper wrapping {@link describeManticoreTableEffect} (opt-in). */
export const describeManticoreTableViaEffect = (
  baseUrl: string,
  tableName: string,
  timeoutMs: number = DEFAULT_DESCRIBE_TABLE_TIMEOUT_MS,
  signal?: AbortSignal,
  fetchImpl?: FetchImpl
): Promise<ManticoreTableInfo> =>
  runManticorePromise(
    describeManticoreTableEffect({
      baseUrl,
      fetchImpl,
      signal,
      tableName,
      timeoutMs,
    }),
    { signal }
  );
