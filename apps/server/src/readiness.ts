import type { ObjectStore } from "@ji/connectors";
import type { BronRuntimeDatabase, OutboxLag } from "@ji/db";
import { PostgresSearchVersionStore, readOutboxLag } from "@ji/db";
import type { DbReadinessResult } from "@ji/db/readiness";
import type { SearchVersionCheckpoint } from "@ji/search";
import {
  partitionTable,
  RedisResultCache,
  SEARCH_INDEX_NAME,
  SEARCH_PARTITIONS,
  SEARCH_SCHEMA_HASH,
} from "@ji/search";
import type { ManticoreTableInfo } from "@ji/search/manticore";
import { describeManticoreTable } from "@ji/search/manticore";
import type { Context } from "hono";

/**
 * Component-wise readiness (RJC-391). `/readyz` used to check only Postgres
 * — the server answered 200 while Manticore was unreachable, the RT table
 * was missing, the outbox drain was hours behind, or the raw object store
 * was gone. Every component below is checked independently, on its own
 * timeout, and the worst one decides the overall verdict.
 */

/** Per-check budget (AbortSignal / race). A hung dependency must never hang
 * `/readyz` itself — a timeout always resolves as `failed`/"timeout". */
export const READINESS_CHECK_TIMEOUT_MS = 1500;
/** Composite result cache window: a probe storm (LB health checks, k8s
 * liveness/readiness at short intervals) must not DoS Manticore or S3. */
export const READINESS_CACHE_MS = 2000;
/** Outbox lag above this is reported `degraded` (search is stale but still
 * servable — see the DEC-004-pending threshold note in the runbook). */
export const READINESS_LAG_DEGRADED_SECONDS = 300;
/** Higher lag threshold: still `degraded`, never `unavailable` — decided:
 * stale search stays servable, this only sharpens the alerting reason. */
export const READINESS_LAG_CRITICAL_SECONDS = 3600;
/** Sentinel key probed on the raw object store — never written, so every
 * probe is a pure existence check (S3 HEAD-equivalent / fs stat). */
export const READINESS_RAW_OBJECT_PROBE_PATH = "raw/.readiness-probe";

export type ComponentStatus = "ok" | "degraded" | "failed";
export type ReadinessOverallStatus = "ready" | "degraded" | "unavailable";

export interface ReadinessComponent {
  readonly status: ComponentStatus;
  readonly reason?: string;
  readonly checkedAt: string;
  readonly durationMs: number;
}

export interface SearchProjectionComponent extends ReadinessComponent {
  readonly generation: number | null;
  readonly appliedSequence: string | null;
  readonly lagEvents: number | null;
  readonly lagSeconds: number | null;
  readonly schemaHash: string | null;
}

export type RedisComponent =
  | ReadinessComponent
  | { readonly status: "not-configured" };

export interface ReadinessComponents {
  readonly postgres: ReadinessComponent;
  readonly manticore: ReadinessComponent;
  readonly rawObjectStore: ReadinessComponent;
  readonly redis: RedisComponent;
  readonly searchProjection: SearchProjectionComponent;
}

export interface ReadinessReport {
  readonly status: ReadinessOverallStatus;
  readonly components: ReadinessComponents;
}

/** Sentinel `Promise.race` winner for a timed-out check — resolved, never
 * rejected/thrown, so no raw error (which may embed a connection string)
 * ever has to be caught or re-classified. */
const READINESS_TIMED_OUT = Symbol("readiness-timed-out");

/** Races `promise` against a cancellable native timer (mirrors the pattern
 * in packages/application/src/registry/registry.ts). */
const raceTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | typeof READINESS_TIMED_OUT> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    // oxlint-disable-next-line promise/avoid-new -- a cancellable native timer has no existing promise to reuse.
    const timeoutResult = new Promise<typeof READINESS_TIMED_OUT>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeoutMs, READINESS_TIMED_OUT);
    });
    return await Promise.race([promise, timeoutResult]);
  } finally {
    clearTimeout(timeoutHandle);
  }
};

type TimedOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly checkedAt: string;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly isTimeout: boolean;
      readonly checkedAt: string;
      readonly durationMs: number;
    };

/** Runs `run` under the shared per-check timeout, always resolving (never
 * rejecting) with a tagged outcome carrying timing but never the raw error
 * — the caller decides the safe, fixed reason string per failure mode.
 *
 * `run` receives an `AbortSignal` that fires at the same `timeoutMs` — a
 * check whose transport can observe it (Manticore's fetch, via
 * `describeManticoreTable`) stops the underlying call instead of leaving it
 * to linger after we've already reported `"timeout"`. A check whose
 * transport can't take a signal (postgres-js, Bun's S3Client, node-redis's
 * `ping()`) just never reads it — documented at each call site — and relies
 * on that transport's own connect/socket timeout to eventually release the
 * resource, same as before this change. */
const timeCheck = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<TimedOutcome<T>> => {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const result = await raceTimeout(
      run(AbortSignal.timeout(timeoutMs)),
      timeoutMs
    );
    if (result === READINESS_TIMED_OUT) {
      return {
        checkedAt,
        durationMs: Date.now() - startedAt,
        isTimeout: true,
        ok: false,
      };
    }
    return {
      checkedAt,
      durationMs: Date.now() - startedAt,
      ok: true,
      value: result,
    };
  } catch {
    return {
      checkedAt,
      durationMs: Date.now() - startedAt,
      isTimeout: false,
      ok: false,
    };
  }
};

const READINESS_CHECK_ERRORED = "check_error" as const;
const READINESS_UNREACHABLE = "unreachable" as const;
const READINESS_TIMEOUT = "timeout" as const;

export interface ReadinessDeps {
  readonly checkDbReadiness: (
    signal: AbortSignal
  ) => Promise<DbReadinessResult>;
  readonly checkManticore: (signal: AbortSignal) => Promise<ManticoreTableInfo>;
  /** Resolves when the raw object store answered; rejects otherwise. The
   * filesystem-in-production hard rule is evaluated before this ever runs. */
  readonly checkRawObjectStore: (signal: AbortSignal) => Promise<void>;
  readonly checkSearchProjection: (signal: AbortSignal) => Promise<{
    readonly checkpoint: SearchVersionCheckpoint;
    readonly lag: OutboxLag;
  }>;
  readonly rawObjectStoreKind: "s3" | "filesystem";
  readonly nodeEnv: string;
  readonly redisUrl?: string;
  /** Overridable only for tests — production always uses the module constant. */
  readonly checkTimeoutMs?: number;
  /** Overridable only for tests — production always uses the module constant. */
  readonly cacheMs?: number;
}

const evaluatePostgres = async (
  checkDbReadiness: (signal: AbortSignal) => Promise<DbReadinessResult>,
  timeoutMs: number
): Promise<ReadinessComponent> => {
  const outcome = await timeCheck(checkDbReadiness, timeoutMs);
  if (!outcome.ok) {
    return {
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: outcome.isTimeout ? READINESS_TIMEOUT : READINESS_UNREACHABLE,
      status: "failed",
    };
  }
  if (outcome.value.ready) {
    return {
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      status: "ok",
    };
  }
  return {
    checkedAt: outcome.checkedAt,
    durationMs: outcome.durationMs,
    reason: outcome.value.reason,
    status: "failed",
  };
};

const evaluateManticore = async (
  checkManticore: (signal: AbortSignal) => Promise<ManticoreTableInfo>,
  timeoutMs: number
): Promise<ReadinessComponent> => {
  const outcome = await timeCheck(checkManticore, timeoutMs);
  if (!outcome.ok) {
    return {
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: outcome.isTimeout ? READINESS_TIMEOUT : READINESS_UNREACHABLE,
      status: "failed",
    };
  }
  if (outcome.value.exists) {
    return {
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      status: "ok",
    };
  }
  return {
    checkedAt: outcome.checkedAt,
    durationMs: outcome.durationMs,
    reason: "table_missing",
    status: "failed",
  };
};

/**
 * Filesystem in production is a hard, no-network failure (RJC-386: the
 * worker-local filesystem store shares no disk with the server; production
 * startup already refuses to boot on this, so reaching it live would mean
 * that guard was bypassed). Everything else — S3 reachable, or filesystem
 * in dev — degrades rather than takes the whole service down: ingest reads
 * break, search itself keeps working.
 */
const evaluateRawObjectStore = async (
  checkRawObjectStore: (signal: AbortSignal) => Promise<void>,
  kind: "s3" | "filesystem",
  nodeEnv: string,
  timeoutMs: number
): Promise<ReadinessComponent> => {
  if (kind === "filesystem" && nodeEnv === "production") {
    return {
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      reason: "filesystem_backend_in_production",
      status: "failed",
    };
  }

  const outcome = await timeCheck(checkRawObjectStore, timeoutMs);
  if (!outcome.ok) {
    return {
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: outcome.isTimeout ? READINESS_TIMEOUT : READINESS_UNREACHABLE,
      status: "degraded",
    };
  }
  return {
    checkedAt: outcome.checkedAt,
    durationMs: outcome.durationMs,
    status: "ok",
  };
};

/**
 * Redis dying after boot (as opposed to being unreachable at startup, which
 * `createResultCache` already refuses to boot on in production) only
 * degrades the search-result cache, never the service — see RJC-388.
 */
const evaluateRedis = async (
  redisUrl: string | undefined,
  timeoutMs: number
): Promise<RedisComponent> => {
  if (!redisUrl) {
    return { status: "not-configured" };
  }

  // node-redis v4's connect()/ping() don't accept a per-call AbortSignal, so
  // the signal parameter is unused here — see the timeCheck doc comment.
  const outcome = await timeCheck(async () => {
    const cache = await RedisResultCache.connect(redisUrl);
    if (!cache) {
      throw new Error("redis unreachable");
    }
    try {
      await cache.ping();
    } finally {
      await cache.close();
    }
  }, timeoutMs);

  if (!outcome.ok) {
    return {
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: outcome.isTimeout ? READINESS_TIMEOUT : READINESS_UNREACHABLE,
      status: "degraded",
    };
  }
  return {
    checkedAt: outcome.checkedAt,
    durationMs: outcome.durationMs,
    status: "ok",
  };
};

const NULL_SEARCH_PROJECTION_FACTS = {
  appliedSequence: null,
  generation: null,
  lagEvents: null,
  lagSeconds: null,
  schemaHash: null,
} as const;

/**
 * The one component whose `failed` state is a business rule, not just a
 * transport error: a schema-hash mismatch means the drain halted itself
 * (SearchIndexSchemaMismatchError) and results are from a stale generation
 * — an operator must start a new generation and reindex (see
 * docs/runbooks/search-schema-migration.md), so this is `unavailable`
 * exactly like Postgres or Manticore being down. Elevated lag, by
 * contrast, is `degraded`: stale search stays servable (decided).
 *
 * A slow or failed READ of the checkpoint/lag (Postgres itself is up —
 * `postgres` already covers that — but this specific query is slow on a
 * large outbox, or errors) is also only `degraded`: it takes a metrics
 * query off the critical path, not the whole instance out of rotation.
 */
const evaluateSearchProjection = async (
  checkSearchProjection: (signal: AbortSignal) => Promise<{
    readonly checkpoint: SearchVersionCheckpoint;
    readonly lag: OutboxLag;
  }>,
  timeoutMs: number
): Promise<SearchProjectionComponent> => {
  const outcome = await timeCheck(checkSearchProjection, timeoutMs);
  if (!outcome.ok) {
    return {
      ...NULL_SEARCH_PROJECTION_FACTS,
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: outcome.isTimeout ? READINESS_TIMEOUT : "projection_read_failed",
      status: "degraded",
    };
  }

  const { checkpoint, lag } = outcome.value;
  const facts = {
    appliedSequence: String(checkpoint.appliedSequence),
    generation: checkpoint.generation,
    lagEvents: lag.events,
    lagSeconds: lag.seconds,
    schemaHash: checkpoint.schemaHash,
  };

  if (checkpoint.schemaHash !== SEARCH_SCHEMA_HASH) {
    return {
      ...facts,
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: "schema_hash_mismatch",
      status: "failed",
    };
  }
  if (lag.seconds > READINESS_LAG_CRITICAL_SECONDS) {
    return {
      ...facts,
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: "lag_critical",
      status: "degraded",
    };
  }
  if (lag.seconds > READINESS_LAG_DEGRADED_SECONDS) {
    return {
      ...facts,
      checkedAt: outcome.checkedAt,
      durationMs: outcome.durationMs,
      reason: "lag_elevated",
      status: "degraded",
    };
  }
  return {
    ...facts,
    checkedAt: outcome.checkedAt,
    durationMs: outcome.durationMs,
    status: "ok",
  };
};

const failedComponentFallback = (): ReadinessComponent => ({
  checkedAt: new Date().toISOString(),
  durationMs: 0,
  reason: READINESS_CHECK_ERRORED,
  status: "failed",
});

const degradedRedisFallback = (): RedisComponent => ({
  checkedAt: new Date().toISOString(),
  durationMs: 0,
  reason: READINESS_CHECK_ERRORED,
  status: "degraded",
});

const degradedSearchProjectionFallback = (): SearchProjectionComponent => ({
  ...NULL_SEARCH_PROJECTION_FACTS,
  checkedAt: new Date().toISOString(),
  durationMs: 0,
  reason: READINESS_CHECK_ERRORED,
  status: "degraded",
});

const unwrap = <T>(result: PromiseSettledResult<T>, fallback: () => T): T =>
  result.status === "fulfilled" ? result.value : fallback();

/**
 * postgres/manticore/rawObjectStore/searchProjection each check their own
 * `failed` independently decides `unavailable` — the whole point of
 * component-wise readiness is that a database problem and a search-index
 * problem no longer look identical to a load balancer. `degraded` (raw
 * object store on S3, redis, or elevated projection lag) never escalates
 * past `degraded`: those are all "the product still serves search."
 */
const computeOverallStatus = (
  components: ReadinessComponents
): ReadinessOverallStatus => {
  const anyUnavailable =
    components.postgres.status === "failed" ||
    components.manticore.status === "failed" ||
    components.rawObjectStore.status === "failed" ||
    components.searchProjection.status === "failed";
  if (anyUnavailable) {
    return "unavailable";
  }

  const redisDegraded =
    components.redis.status !== "not-configured" &&
    components.redis.status === "degraded";
  const anyDegraded =
    components.rawObjectStore.status === "degraded" ||
    redisDegraded ||
    components.searchProjection.status === "degraded";
  return anyDegraded ? "degraded" : "ready";
};

export const createReadinessHandler = (deps: ReadinessDeps) => {
  const timeoutMs = deps.checkTimeoutMs ?? READINESS_CHECK_TIMEOUT_MS;
  const cacheMs = deps.cacheMs ?? READINESS_CACHE_MS;
  // Singleflight: the cache slot holds the PENDING promise from the moment a
  // computation starts (set below, before any check runs), not just the
  // finished report. N concurrent cold /readyz requests within the same
  // tick all see this slot already filled and await the one in-flight
  // evaluation instead of each starting five checks of their own — a probe
  // storm (unauthenticated LB/k8s traffic) can't pile up DB/S3/Redis/
  // Manticore calls this way. Cleared on throw so a failed computation
  // doesn't poison the next 2s window (computeReport itself never rejects
  // today — every check is caught inside timeCheck — but this is the
  // correct behavior if that ever changes).
  let cached:
    | {
        readonly reportPromise: Promise<ReadinessReport>;
        readonly startedAtMs: number;
      }
    | undefined;
  // Identifies which in-flight computation a rejection belongs to, without
  // the pending promise having to reference its own binding (TS can't prove
  // that's assigned yet inside its own initializer).
  let generation = 0;

  const computeReport = async (): Promise<ReadinessReport> => {
    const [
      postgresResult,
      manticoreResult,
      rawObjectStoreResult,
      redisResult,
      searchProjectionResult,
    ] = await Promise.allSettled([
      evaluatePostgres(deps.checkDbReadiness, timeoutMs),
      evaluateManticore(deps.checkManticore, timeoutMs),
      evaluateRawObjectStore(
        deps.checkRawObjectStore,
        deps.rawObjectStoreKind,
        deps.nodeEnv,
        timeoutMs
      ),
      evaluateRedis(deps.redisUrl, timeoutMs),
      evaluateSearchProjection(deps.checkSearchProjection, timeoutMs),
    ]);

    const components: ReadinessComponents = {
      manticore: unwrap(manticoreResult, failedComponentFallback),
      postgres: unwrap(postgresResult, failedComponentFallback),
      rawObjectStore: unwrap(rawObjectStoreResult, failedComponentFallback),
      redis: unwrap(redisResult, degradedRedisFallback),
      searchProjection: unwrap(
        searchProjectionResult,
        degradedSearchProjectionFallback
      ),
    };

    return { components, status: computeOverallStatus(components) };
  };

  return async (context: Context): Promise<Response> => {
    const now = Date.now();
    if (!cached || now - cached.startedAtMs >= cacheMs) {
      generation += 1;
      const myGeneration = generation;
      const reportPromise: Promise<ReadinessReport> = (async () => {
        try {
          return await computeReport();
        } catch (error) {
          // Only clear the slot if a newer computation hasn't already
          // replaced it (this rejection would otherwise be stale).
          if (generation === myGeneration) {
            cached = undefined;
          }
          throw error;
        }
      })();
      cached = { reportPromise, startedAtMs: now };
    }

    const report = await cached.reportPromise;
    const httpStatus = report.status === "unavailable" ? 503 : 200;
    return context.json(report, httpStatus);
  };
};

/** Wires the real checkers (Manticore HTTP probe, raw object store sentinel
 * read, search-projection checkpoint + outbox lag) from already-computed
 * facts — `apps/server/src/index.ts` only supplies these facts, it never
 * constructs a checker itself. */
export interface CreateReadinessDepsInput {
  readonly checkDbReadiness: () => Promise<DbReadinessResult>;
  readonly database: BronRuntimeDatabase;
  readonly manticoreUrl: string;
  readonly nodeEnv: string;
  readonly objectStore: Pick<ObjectStore, "get">;
  readonly rawObjectStoreKind: "s3" | "filesystem";
  readonly redisUrl?: string;
}

export const createReadinessDeps = (
  input: CreateReadinessDepsInput
): ReadinessDeps => ({
  // getDbReadiness (@ji/db) takes no signal — postgres-js has no per-query
  // cancellation here; it relies on its own connect_timeout (packages/db's
  // sqlClient config) to eventually release a stuck connection.
  checkDbReadiness: () => input.checkDbReadiness(),
  // The only checker whose transport actually observes the signal: it
  // aborts the underlying fetch instead of leaving it to complete after
  // readiness has already reported "timeout".
  // RJC-383: the index is two RT tables (active + archive); readiness is
  // "ok" only when both exist — a missing archive would make every
  // scope=all search and every archive count fail.
  checkManticore: async (signal) => {
    const tables = await Promise.all(
      SEARCH_PARTITIONS.map((partition) =>
        describeManticoreTable(
          input.manticoreUrl,
          partitionTable(SEARCH_INDEX_NAME, partition),
          READINESS_CHECK_TIMEOUT_MS,
          signal
        )
      )
    );
    return { exists: tables.every((table) => table.exists) };
  },
  // ObjectStore.get() (packages/connectors) takes no signal — Bun's
  // S3Client/fs read relies on its own transport timeout.
  checkRawObjectStore: async () => {
    await input.objectStore.get(READINESS_RAW_OBJECT_PROBE_PATH);
  },
  // readOutboxLag / PostgresSearchVersionStore.read() take no signal — same
  // postgres-js limitation as checkDbReadiness above.
  checkSearchProjection: async () => {
    const [checkpoint, lag] = await Promise.all([
      new PostgresSearchVersionStore(input.database).read(),
      readOutboxLag(input.database),
    ]);
    return { checkpoint, lag };
  },
  nodeEnv: input.nodeEnv,
  rawObjectStoreKind: input.rawObjectStoreKind,
  redisUrl: input.redisUrl,
});
