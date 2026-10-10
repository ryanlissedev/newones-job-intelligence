import type { Scope } from "effect";
import { Cause, Duration, Effect, Exit, Layer, Schedule } from "effect";
import {
  PersistedQueueError,
  PersistedQueueStore,
} from "effect/unstable/persistence/PersistedQueue";
import postgres from "postgres";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- the PersistedQueueStore service contract types queue elements as `unknown`; the queue's own Schema decodes them on take. */

/**
 * Postgres-backed `PersistedQueueStore` over `curated.durable_job` (CTP-622).
 *
 * Same claim/lease/ack mechanics as Effect rc112's `makeStoreSql`, but over
 * the repo's postgres-js client and WITHOUT the bundled Migrator: the table
 * comes from migration `0029_durable_job_queue.sql`, applied through the
 * operator lane, so a worker starts with plain DML rights and no DDL.
 *
 * Semantics, row by row:
 * - `offer` inserts with `ON CONFLICT DO NOTHING`: the `(id, queue_name)` key
 *   dedupes a re-offered job and `durable_job_open_bron_uidx` keeps at most
 *   one open job per bron — that is business idempotency, separate from the
 *   dispatcher's retry mechanics.
 * - `take` claims a row by stamping `acquired_by`/`acquired_at` (the lease),
 *   hands it to the caller inside a scope, and acks in the scope finalizer:
 *   success → `completed` with `last_failure` cleared, failure →
 *   `attempts + 1` and released, interrupt-only → released without spending
 *   an attempt. The failure that reaches `maxAttempts` also closes the row
 *   (`completed = true`, `last_failure` kept), so a partial unique index on
 *   open rows frees the business key instead of pinning it to a dead job;
 *   `completed AND last_failure IS NOT NULL` is the dead letter (CTP-643).
 * - A crashed worker leaves its claim to expire (`acquired_at` older than
 *   `lockExpiration`); the next claim picks the row up. The domain-side
 *   scrape_run fence decides what the replayed job then does.
 *
 * Every statement is a single round trip, so the store is safe behind a
 * pooled endpoint — no session state is ever held across statements.
 */

export interface PersistedQueueStorePostgresOptions {
  /** Claim poll cadence while the queue is empty (default 1000 ms). */
  readonly pollInterval?: Duration.Input | undefined;
  /** How often active leases are re-stamped while a take is in flight (default 30 s). */
  readonly lockRefreshInterval?: Duration.Input | undefined;
  /** How long a claim protects a row before a successor may re-claim it (default 2 min). */
  readonly lockExpiration?: Duration.Input | undefined;
  /**
   * Qualified table name, default `curated.durable_job`. Validated as one or
   * two dot-separated identifiers — never interpolated unchecked.
   */
  readonly tableName?: string | undefined;
  /** Identity written to `acquired_by`; defaults to a fresh worker UUID. */
  readonly workerId?: string | undefined;
  /** Pool size for the dedicated queue client (default 2). */
  readonly maxConnections?: number | undefined;
}

interface ClaimedElement {
  readonly id: string;
  readonly sequence: number;
  readonly queue_name: string;
  element: postgres.JSONValue;
  readonly attempts: number;
}

export type PersistedQueueStorePostgres = PersistedQueueStore["Service"] & {
  /**
   * Raw row listing for operators and specs — the inspectable state the
   * restart matrix is proven against. Not part of the Effect service
   * interface; `PersistedQueueStore` consumers see only offer/take.
   */
  readonly inspect: (
    name: string
  ) => Effect.Effect<readonly ClaimedElement[], PersistedQueueError>;
};

const TABLE_NAME_PATTERN =
  /^[a-zA-Z_][a-zA-Z0-9_]*(?<suffix>\.[a-zA-Z_][a-zA-Z0-9_]*)?$/u;

const toTableSql = (
  sql: postgres.Sql,
  tableName: string
): postgres.Fragment => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `Invalid persisted queue table name: ${JSON.stringify(tableName)}`
    );
  }
  const parts = tableName.split(".");
  // SAFETY: TABLE_NAME_PATTERN accepts only one or two non-empty identifier parts.
  return parts.length === 2
    ? sql`${sql(parts[0] as string)}.${sql(parts[1] as string)}`
    : sql`${sql(tableName)}`;
};

type Statement = () => postgres.PendingQuery<postgres.Row[]>;

// postgres-js PendingQuery starts eagerly, so every statement is a thunk:
// a retried or re-issued effect must build a fresh query, not re-await a
// settled one.
const runStatement = (
  evaluate: Statement
): Effect.Effect<postgres.Row[], PersistedQueueError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new PersistedQueueError({
        cause,
        message: "Persisted queue statement failed",
      }),
    try: evaluate,
  });

const runRows = <Row extends postgres.Row>(
  evaluate: () => postgres.PendingQuery<Row[]>
): Effect.Effect<readonly Row[], PersistedQueueError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new PersistedQueueError({
        cause,
        message: "Persisted queue statement failed",
      }),
    try: evaluate,
  });

/** A claim failure (DB outage) is a wait, not a lost job — log and poll again.
 * An interrupt is neither: it must end the take so shutdown can finish. */
export const recoverClaimFailure = (
  cause: Cause.Cause<PersistedQueueError>
): Effect.Effect<readonly ClaimedElement[], PersistedQueueError> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause)
    : Effect.logWarning("persisted queue claim failed; retrying", cause).pipe(
        Effect.as<readonly ClaimedElement[]>([])
      );

export const makePostgresPersistedQueueStore = (
  databaseUrl: string,
  options: PersistedQueueStorePostgresOptions = {}
): Effect.Effect<PersistedQueueStorePostgres, never, Scope.Scope> =>
  Effect.gen(function* makeStore() {
    const sql = postgres(databaseUrl, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: options.maxConnections ?? 2,
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => sql.end({ timeout: 5 }))
    );

    const tableSql = toTableSql(
      sql,
      options.tableName ?? "curated.durable_job"
    );
    const pollInterval = Duration.max(
      options.pollInterval
        ? Duration.fromInputUnsafe(options.pollInterval)
        : Duration.millis(1000),
      Duration.millis(1)
    );
    const lockRefreshInterval = Duration.max(
      options.lockRefreshInterval
        ? Duration.fromInputUnsafe(options.lockRefreshInterval)
        : Duration.seconds(30),
      Duration.millis(1)
    );
    const lockExpirationSeconds = Math.max(
      1,
      Math.ceil(
        Duration.toSeconds(
          Duration.max(
            options.lockExpiration
              ? Duration.fromInputUnsafe(options.lockExpiration)
              : Duration.minutes(2),
            Duration.millis(1)
          )
        )
      )
    );
    const workerId = options.workerId ?? crypto.randomUUID();
    const claimExpiry = sql`now() - (${lockExpirationSeconds} * interval '1 second')`;

    const activeSequences = new Set<number>();

    const refreshLocks: Effect.Effect<void, PersistedQueueError> =
      Effect.suspend((): Effect.Effect<void, PersistedQueueError> => {
        if (activeSequences.size === 0) {
          return Effect.void;
        }
        const ids = [...activeSequences];
        return runStatement(
          () => sql`
          UPDATE ${tableSql}
          SET acquired_at = now()
          WHERE sequence IN ${sql(ids)}
          AND acquired_by = ${workerId}::uuid
        `
        ).pipe(Effect.asVoid);
      });

    // A lost ack (DB outage, dying connection) must not lose the row: retry a
    // few times, then die — the lease expiry is the guaranteed recovery path.
    const finalize = (statement: Statement): Effect.Effect<void> =>
      runStatement(statement).pipe(
        Effect.retry({
          schedule: Schedule.exponential(100, 1.5),
          times: 5,
        }),
        Effect.orDie
      );

    const complete = (sequence: number, attempts: number) => {
      activeSequences.delete(sequence);
      return finalize(
        () => sql`
        UPDATE ${tableSql}
        SET acquired_at = NULL, acquired_by = NULL, updated_at = now(), completed = true, attempts = ${attempts}, last_failure = NULL
        WHERE sequence = ${sequence}
        AND acquired_by = ${workerId}::uuid
      `
      );
    };

    const retryAttempt = (
      sequence: number,
      attempts: number,
      maxAttempts: number,
      cause: Cause.Cause<unknown>
    ) => {
      activeSequences.delete(sequence);
      return finalize(
        () => sql`
        UPDATE ${tableSql}
        SET acquired_at = NULL, acquired_by = NULL, updated_at = now(), attempts = ${attempts}, completed = ${attempts >= maxAttempts}, last_failure = ${Cause.pretty(cause)}
        WHERE sequence = ${sequence}
        AND acquired_by = ${workerId}::uuid
      `
      );
    };

    const interrupt = (sequence: number) => {
      activeSequences.delete(sequence);
      return finalize(
        () => sql`
        UPDATE ${tableSql}
        SET acquired_at = NULL, acquired_by = NULL
        WHERE sequence = ${sequence}
        AND acquired_by = ${workerId}::uuid
      `
      );
    };

    yield* refreshLocks.pipe(
      Effect.tapCause(Effect.logWarning),
      Effect.retry(Schedule.spaced(500)),
      Effect.schedule(Schedule.fixed(lockRefreshInterval)),
      Effect.annotateLogs({
        fiber: "refreshLocks",
        module: "ji/db/persisted-queue-store",
      }),
      Effect.forkScoped
    );

    const claimNext = Effect.fnUntraced(function* claimNext(
      name: string,
      maxAttempts: number
    ) {
      while (true) {
        const rows = yield* runRows<ClaimedElement>(
          () => sql<ClaimedElement[]>`
          WITH cte AS (
            UPDATE ${tableSql}
            SET acquired_at = now(), acquired_by = ${workerId}::uuid
            WHERE sequence IN (
              SELECT sequence FROM ${tableSql}
              WHERE queue_name = ${name}
              AND completed = false
              AND attempts < ${maxAttempts}
              AND (acquired_at IS NULL OR acquired_at < ${claimExpiry})
              ORDER BY updated_at ASC, sequence ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            RETURNING sequence, id, queue_name, element, attempts, updated_at
          )
          SELECT sequence, id, queue_name, element, attempts FROM cte
          ORDER BY updated_at ASC, sequence ASC
        `
        ).pipe(Effect.catchCause(recoverClaimFailure));
        const [claimed] = rows;
        if (claimed !== undefined) {
          return claimed;
        }
        yield* Effect.sleep(pollInterval);
      }
    });

    const service: PersistedQueueStorePostgres = {
      inspect: (name) =>
        runRows<ClaimedElement>(
          () => sql<ClaimedElement[]>`
          SELECT sequence, id, queue_name, element, attempts
          FROM ${tableSql}
          WHERE queue_name = ${name}
          ORDER BY sequence ASC
        `
        ),
      offer: ({ element, id, name }) =>
        runStatement(
          // SAFETY: the queue encodes elements through Schema.toCodecJson, so
          // the store contract's `unknown` is always a JSON value here. Using
          // sql.json keeps the stored jsonb a real object — a manual
          // JSON.stringify(...)::jsonb double-encodes to a jsonb string, which
          // defeats both the bronId dedupe index and the take-side decode.
          () => sql`
          INSERT INTO ${tableSql} (id, queue_name, element, created_at, updated_at)
          VALUES (${id}, ${name}, ${sql.json(element as postgres.JSONValue)}, now(), now())
          ON CONFLICT DO NOTHING
        `
        ).pipe(
          Effect.mapError(
            // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Effect error channel, not a promise callback
            (error) =>
              new PersistedQueueError({
                cause: error,
                message: "Failed to offer element to persisted queue",
              })
          )
        ),
      take: ({ maxAttempts, name }) =>
        Effect.uninterruptibleMask((restore) =>
          restore(claimNext(name, maxAttempts)).pipe(
            Effect.tap((element) => {
              activeSequences.add(element.sequence);
              return Effect.addFinalizer(
                Exit.match({
                  onFailure: (cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? interrupt(element.sequence)
                      : retryAttempt(
                          element.sequence,
                          element.attempts + 1,
                          maxAttempts,
                          cause
                        ),
                  onSuccess: () =>
                    complete(element.sequence, element.attempts + 1),
                })
              );
            }),
            Effect.map((element) => ({
              attempts: element.attempts,
              element: element.element,
              id: element.id,
            }))
          )
        ),
    };
    return service;
  });

export const layerPostgresPersistedQueueStore = (
  databaseUrl: string,
  options: PersistedQueueStorePostgresOptions = {}
): Layer.Layer<PersistedQueueStore, never, Scope.Scope> =>
  Layer.effect(
    PersistedQueueStore,
    makePostgresPersistedQueueStore(databaseUrl, options)
  );
