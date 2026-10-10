import { parseDirectDatabaseUrl } from "@ji/env/projector-database-url";
import postgres from "postgres";

import { abortableSleep } from "./abortable-sleep";

/**
 * Thrown when a cycle's lock heartbeat (`reassert`) finds the lock gone and
 * held by someone else. Fatal, not transient: the holder must stop rather
 * than keep working without the lock.
 */
export class LockLostError extends Error {
  constructor(lockKey: number) {
    super(
      `Advisory lock ${lockKey} was lost and is now held by another session`
    );
    this.name = "LockLostError";
  }
}

const LOCK_PROBE_TIMEOUT_NAME = "LockProbeTimeoutError";
const LOCK_RELEASE_TIMEOUT_MS = 2000;
const LOCK_CONNECTION_END_TIMEOUT_SECONDS = 1;

const ignorePostgresError = (_error: Error): void => {
  // The connection is being torn down; cancellation/end errors are already
  // represented by the owning lock probe or release operation.
};

const lockProbeTimeoutError = (timeoutMs: number): Error => {
  const error = new Error(`Advisory lock probe timed out after ${timeoutMs}ms`);
  error.name = LOCK_PROBE_TIMEOUT_NAME;
  return error;
};

/** Bounds a postgres query while keeping its eventual rejection observed. */
export const runBoundedLockQuery = async <Result>(
  query: PromiseLike<Result>,
  timeoutMs: number,
  timeoutError: Error,
  onTimeout: () => void
): Promise<Result> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // oxlint-disable-next-line promise/avoid-new -- bridge a postgres query to a bounded timeout
    return await new Promise<Result>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(timeoutError);
      }, timeoutMs);
      // oxlint-disable-next-line promise/prefer-catch -- both query outcomes settle the timeout bridge
      query.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export interface AdvisoryLockHandle {
  readonly acquired: boolean;
  /** No-op when `acquired` is false. */
  release: () => Promise<void>;
  /**
   * Re-runs `pg_try_advisory_lock` on the same connection: true while this
   * session still holds it (idempotent/harmless — Postgres advisory locks
   * are re-entrant per session), true if it had silently dropped (idle
   * connection reaped by the pool/proxy/Neon autosuspend) and was free to
   * retake, false if another session grabbed it in between.
   */
  reassert: (options?: { timeoutMs?: number }) => Promise<boolean>;
}

/**
 * Postgres session-level advisory lock (RJC-387). `pg_try_advisory_lock` is
 * scoped to the connection that took it, so this opens one dedicated
 * connection and holds it for the lock's lifetime — a pooled client would
 * let the lock migrate across connections and defeat the single-instance
 * guarantee. `max_lifetime`/`idle_timeout` are disabled on this connection
 * so the common case doesn't churn, but that is not the guarantee: the
 * caller must call `reassert()` every cycle because postgres.js
 * or Neon can still drop an idle connection underneath us, silently
 * releasing the session-level lock. Call `release()` on shutdown; it also
 * closes the connection.
 */
export const acquireAdvisoryLock = async (
  databaseUrl: string,
  lockKey: number,
  databaseUrlVariable: string,
  createClient: typeof postgres = postgres
): Promise<AdvisoryLockHandle> => {
  // Validate at the lock boundary too: callers cannot accidentally bypass
  // the typed process env and put a session lock behind Neon's pooler.
  const directDatabaseUrl = parseDirectDatabaseUrl(
    databaseUrl,
    databaseUrlVariable
  );
  const sql = createClient(directDatabaseUrl, {
    idle_timeout: 0,
    max: 1,
    max_lifetime: null,
  });
  const rows = await sql<{ locked: boolean }[]>`
    select pg_try_advisory_lock(${lockKey}) as locked
  `;
  const acquired = rows[0]?.locked === true;

  if (!acquired) {
    await sql.end({ timeout: 5 });
    return {
      acquired: false,
      reassert: () => Promise.resolve(false),
      release: () => Promise.resolve(),
    };
  }

  const tryLockQuery = () =>
    sql<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${lockKey}) as locked
    `;
  let lockConnectionPoisoned = false;
  let lockConnectionTeardown: Promise<void> | undefined;
  const endLockConnection = (): Promise<void> => {
    if (!lockConnectionTeardown) {
      lockConnectionTeardown = (async () => {
        try {
          await sql.end({ timeout: LOCK_CONNECTION_END_TIMEOUT_SECONDS });
        } catch (error) {
          ignorePostgresError(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      })();
    }
    return lockConnectionTeardown;
  };

  const runLockQuery = async (
    timeoutMs: number
  ): Promise<{ locked: boolean }[]> => {
    if (lockConnectionPoisoned) {
      throw lockProbeTimeoutError(timeoutMs);
    }
    return await runBoundedLockQuery(
      tryLockQuery(),
      timeoutMs,
      lockProbeTimeoutError(timeoutMs),
      () => {
        lockConnectionPoisoned = true;
        // Closing the dedicated connection settles the in-flight query and
        // prevents a retry from running on a poisoned session.
        void endLockConnection();
      }
    );
  };

  // ponytail: the query issued right as the connection dies (idle reap,
  // Neon autosuspend, or a killed backend) can reject once or twice while
  // postgres.js finishes tearing down the dead socket before it opens a
  // fresh one — a handful of short retries rides that out. If it never
  // recovers, the last rejection propagates and the caller (main.ts) exits,
  // which is the correct fallback anyway.
  const RECONNECT_RETRIES = 3;
  const RECONNECT_RETRY_DELAY_MS = 25;
  const reassert = async (
    options: { timeoutMs?: number } = {}
  ): Promise<boolean> => {
    const timeoutMs = options.timeoutMs ?? 5000;
    for (let attempt = 0; attempt < RECONNECT_RETRIES; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- each retry must wait for the previous attempt to settle before trying again
        const retryRows = await runLockQuery(timeoutMs);
        return retryRows[0]?.locked === true;
      } catch (error) {
        if (error instanceof Error && error.name === LOCK_PROBE_TIMEOUT_NAME) {
          // Do not start a retry while the dedicated connection is being
          // torn down after a timed-out query.
          throw error;
        }
        if (attempt === RECONNECT_RETRIES - 1) {
          throw error;
        }
        // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- deliberate pacing between reconnect attempts; timers have no promise API
        await new Promise((resolve) => {
          setTimeout(resolve, RECONNECT_RETRY_DELAY_MS);
        });
      }
    }
    // Unreachable: the loop above always returns or throws.
    return false;
  };

  return {
    acquired: true,
    reassert,
    release: async () => {
      if (lockConnectionPoisoned) {
        await endLockConnection();
        return;
      }
      // pg_advisory_lock is reference-counted per session — every
      // `reassert()` call while already holding it adds another count on
      // the same session. `unlock_all` drops the session's entire advisory
      // lock stack in one call instead of needing N matching unlocks.
      try {
        await runBoundedLockQuery(
          sql`select pg_advisory_unlock_all()`,
          LOCK_RELEASE_TIMEOUT_MS,
          new Error(
            `Advisory lock release timed out after ${LOCK_RELEASE_TIMEOUT_MS}ms`
          ),
          () => {
            lockConnectionPoisoned = true;
            void endLockConnection();
          }
        );
      } finally {
        await endLockConnection();
      }
    },
  };
};

export interface WaitForAdvisoryLockOptions {
  /** Env variable name that supplied `databaseUrl`, for boundary messages. */
  readonly databaseUrlVariable: string;
  /** Awaited after every failed attempt, before the sleep. */
  readonly onWaiting: () => Promise<void>;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
}

/**
 * Blocks until the advisory lock is free, then takes it. A rolling deploy
 * starts the replacement container while the outgoing one still holds the
 * lock, so exiting on a held lock would fail the handoff; waiting lets the
 * new container stay healthy (that is what `onWaiting` is for) until the old
 * one's shutdown releases the lock. Resolves `undefined` when `signal`
 * aborts before acquisition, having taken nothing. Each failed attempt
 * closes its own connection inside `acquireAdvisoryLock`, so a long wait
 * never accumulates sessions.
 */
export const waitForAdvisoryLock = async (
  databaseUrl: string,
  lockKey: number,
  options: WaitForAdvisoryLockOptions
): Promise<AdvisoryLockHandle | undefined> => {
  const { databaseUrlVariable, onWaiting, pollIntervalMs, signal } = options;
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- one attempt at a time by design; attempts must not overlap
    const handle = await acquireAdvisoryLock(
      databaseUrl,
      lockKey,
      databaseUrlVariable
    );
    if (handle.acquired) {
      return handle;
    }
    // oxlint-disable-next-line no-await-in-loop -- the waiting side effect must complete before the poll interval starts
    await onWaiting();
    // oxlint-disable-next-line no-await-in-loop -- the poll interval must elapse before the next attempt
    await abortableSleep(pollIntervalMs, signal);
  }
  return undefined;
};
