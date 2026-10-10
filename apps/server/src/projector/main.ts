import { hostname } from "node:os";

import {
  createBronRuntimeClient,
  drainPostgresOutbox,
  PostgresSearchDocumentLoader,
  PostgresSearchProjectorRuntimeStore,
  PostgresSearchVersionStore,
} from "@ji/db";
import { LockLostError, waitForAdvisoryLock } from "@ji/db/process-lock";
/**
 * On-box search projector process (RJC-387, runbook: docs/runbooks/search-projector.md).
 *
 *   bun run projector
 *
 * Reads the Neon outbox over TLS (pooled DATABASE_URL), holds its session
 * advisory lock over a direct PROJECTOR_DATABASE_URL, and writes to a
 * loopback-only Manticore (MANTICORE_URL). It therefore runs next to
 * Manticore rather than inside the cloud worker — see the runbook for why
 * (ADR-0006 keeps Manticore off the public network).
 */
import { env as projectorEnv } from "@ji/env/projector";
import { ManticoreSearchEngine } from "@ji/search";

import { heartbeatFilePath, writeHeartbeat } from "./heartbeat";
import type { ProjectorCycleLog } from "./loop";
import { runProjectorLoop } from "./loop";
import { createProjectorRuntimeRecorder } from "./runtime";

const POLL_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const DRAIN_LIMIT = 500;
const LOCK_WAIT_POLL_INTERVAL_MS = 2000;
const LOCK_WAIT_LOG_INTERVAL_MS = 30_000;

/**
 * Arbitrary 31-bit key for the projector's singleton `pg_advisory_lock`.
 * Chosen once, kept stable for the process's lifetime (advisory locks are
 * keyed by this literal, not by name) — a repo-wide grep for
 * `pg_advisory_lock` / `pg_try_advisory_lock` at authoring time found no
 * other caller. If a second advisory lock is ever added to this codebase,
 * give it a different constant so the two never collide silently.
 */
const ADVISORY_LOCK_KEY = 847_732_991;

/** Module scope runs at import, i.e. process start, before main() is awaited. */
const PROCESS_STARTED_AT = new Date();

/** `process.stdout` and `process.stderr` differ only in their `fd` literal type — this accepts either. */
interface LogStream {
  write: (chunk: string) => boolean;
}

const logLine = <Fields extends object>(
  stream: LogStream,
  event: string,
  fields: Fields
): void => {
  stream.write(`${JSON.stringify({ event, ...fields })}\n`);
};

const main = async (): Promise<void> => {
  const databaseUrl = projectorEnv.DATABASE_URL;
  const lockDatabaseUrl = projectorEnv.PROJECTOR_DATABASE_URL;
  const manticoreUrl = projectorEnv.MANTICORE_URL;

  const controller = new AbortController();
  // `process.once` would let a second signal (supervisor impatience, a
  // `docker stop` retry, operator double-Ctrl-C) fall through to Bun's
  // default handler and exit immediately mid-cycle. `process.on` catches
  // every signal: the first aborts the loop, every one after is logged and
  // otherwise ignored — the in-flight cycle keeps running to completion.
  // SIGKILL remains the hard stop; nothing in userspace can catch that.
  let shutdownRequested = false;
  const requestShutdown = (signal: string): void => {
    if (shutdownRequested) {
      logLine(process.stdout, "projector_shutdown_in_progress", { signal });
      return;
    }
    shutdownRequested = true;
    controller.abort();
  };
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  const heartbeatFile = heartbeatFilePath();
  // Liveness for the Docker HEALTHCHECK (see heartbeat.ts); a failed write
  // must never take the drain loop down, so it is logged and ignored.
  const recordHeartbeat = async (): Promise<void> => {
    try {
      await writeHeartbeat(heartbeatFile);
    } catch (error) {
      logLine(process.stderr, "projector_heartbeat_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Coolify rolls this application by starting the replacement container,
  // waiting for it to report healthy, then removing the outgoing one. So the
  // replacement waits for the lock instead of exiting, and keeps the
  // heartbeat file fresh while it waits: healthy but idle, holding nothing
  // until the outgoing container's SIGTERM path releases the lock.
  let lastLockWaitLogAt = 0;
  const lock = await waitForAdvisoryLock(lockDatabaseUrl, ADVISORY_LOCK_KEY, {
    databaseUrlVariable: "PROJECTOR_DATABASE_URL",
    onWaiting: async () => {
      await recordHeartbeat();
      const now = Date.now();
      if (now - lastLockWaitLogAt >= LOCK_WAIT_LOG_INTERVAL_MS) {
        lastLockWaitLogAt = now;
        logLine(process.stdout, "projector_lock_waiting", {
          message: "another projector holds the lock",
        });
      }
    },
    pollIntervalMs: LOCK_WAIT_POLL_INTERVAL_MS,
    signal: controller.signal,
  });
  if (!lock) {
    logLine(process.stdout, "projector_shutdown", {});
    return;
  }

  const runtime = createBronRuntimeClient(databaseUrl);
  const versionStore = new PostgresSearchVersionStore(runtime.database);
  const engine = ManticoreSearchEngine.fromUrl(manticoreUrl, versionStore);
  const loader = new PostgresSearchDocumentLoader(runtime.database);

  // Deploy readback (docs/runbooks/search-projector.md): the API serves this
  // row at /projector/runtime so a deploy can confirm which container and
  // release SHA holds the lock. Throttled inside the recorder; a failed write
  // is logged and never takes the drain loop down.
  const runtimeRecorder = createProjectorRuntimeRecorder({
    containerId: hostname(),
    onError: (message) => {
      logLine(process.stderr, "projector_runtime_record_failed", { message });
    },
    releaseSha: projectorEnv.APP_RELEASE_SHA ?? null,
    startedAt: PROCESS_STARTED_AT,
    store: new PostgresSearchProjectorRuntimeStore(runtime.database),
  });

  const onCycle = (log: ProjectorCycleLog): void => {
    logLine(process.stdout, "projector_cycle", log);
    void recordHeartbeat();
    void runtimeRecorder.onCycle();
  };

  try {
    await runProjectorLoop({
      drain: async () => {
        // Heartbeat: the lock connection can drop silently (idle reaping,
        // Neon autosuspend) without the loop ever seeing an error — the
        // next query on that connection just transparently reconnects with
        // no lock held. Re-asserting every cycle is what makes "never runs
        // concurrently" actually true instead of just usually true.
        const stillHeld = await lock.reassert();
        if (!stillHeld) {
          throw new LockLostError(ADVISORY_LOCK_KEY);
        }
        const result = await drainPostgresOutbox({
          database: runtime.database,
          engine,
          limit: DRAIN_LIMIT,
          loader,
          versionStore,
        });
        return { drained: result.drained, indexVersion: result.indexVersion };
      },
      maxBackoffMs: MAX_BACKOFF_MS,
      onCycle,
      pollIntervalMs: POLL_INTERVAL_MS,
      signal: controller.signal,
    });
    logLine(process.stdout, "projector_shutdown", {});
  } catch (error) {
    logLine(process.stderr, "projector_fatal", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await lock.release();
    await runtime.close();
  }
};

await main();
