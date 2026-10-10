import { expect, it } from "bun:test";
import path from "node:path";

import { acquireAdvisoryLock, LockLostError } from "@ji/db/process-lock";
import {
  bron,
  bronHealth,
  pollerRuntime,
  scrapeRun,
} from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { PostgresSourceHealthReader } from "@ji/db/source-health-reader";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { runWithPollerLiveness } from "./liveness";
import { createPollerRuntimeHealth } from "./runtime-health";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const migrationsFolder = path.join(
  import.meta.dir,
  "../../../../packages/db/src/migrations"
);
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
};
const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

const STARTED_AT = new Date("2026-09-19T12:00:00.000Z");
const LOST_AT = new Date("2026-09-19T12:00:01.000Z");

const bestEffortCleanup = async (
  operation: () => Promise<void>,
  cleanupErrors: unknown[]
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    cleanupErrors.push(error);
  }
};

it.skipIf(!postgresAvailable)(
  "aborts source work and persists health after a real lock probe loses ownership",
  async () => {
    const bronId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const lockKey = 613_300_000 + Math.floor(Math.random() * 100_000);
    const sqlClient = postgres(testDatabaseUrl, { max: 1 });
    const admin = postgres(testDatabaseUrl, { max: 1 });
    const rival = postgres(testDatabaseUrl, { max: 1 });
    const database = drizzle(sqlClient, { schema });
    const controller = new AbortController();
    const takeoverReady = Promise.withResolvers<null>();
    const secondProbeReady = Promise.withResolvers<null>();
    const firstProbeComplete = Promise.withResolvers<null>();
    const abortObserved = Promise.withResolvers<null>();
    let lockHandle: Awaited<ReturnType<typeof acquireAdvisoryLock>> | undefined;
    let runtime:
      | Awaited<ReturnType<typeof createPollerRuntimeHealth>>
      | undefined;
    let liveness: Promise<unknown> | undefined;
    let probeCount = 0;
    let testFailure: unknown;

    controller.signal.addEventListener(
      "abort",
      () => abortObserved.resolve(null),
      { once: true }
    );

    try {
      await migrate(database, { migrationsFolder });
      lockHandle = await acquireAdvisoryLock(
        testDatabaseUrl,
        lockKey,
        "DATABASE_TEST_URL"
      );
      expect(lockHandle.acquired).toBe(true);

      await database.insert(bron).values({
        actief: true,
        categorie: "test",
        id: bronId,
        interval: "*/5 * * * *",
        naam: `liveness-${bronId}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      await database.insert(scrapeRun).values({
        bronId,
        fenceToken: 1,
        gestart: STARTED_AT,
        id: runId,
        runKind: "poll",
        status: "running",
      });
      runtime = await createPollerRuntimeHealth({
        advisoryLockMaxAgeMs: 120_000,
        curationBudgetMs: 120_000,
        databaseUrl: testDatabaseUrl,
        heartbeatAt: STARTED_AT,
        heartbeatMaxAgeMs: 120_000,
        instanceId: `liveness-${bronId}`,
        lastLockCheckAt: STARTED_AT,
        releaseSha: "a".repeat(40),
        runBudgetMs: 60_000,
        startedAt: STARTED_AT,
        telemetryClientOptions: { operationTimeoutMs: 2000 },
      });
      const activeLockHandle = lockHandle;
      const activeRuntime = runtime;

      const controllerSignal = controller.signal;
      liveness = runWithPollerLiveness(
        {
          heartbeat: () => Promise.resolve(),
          intervalMs: 1,
          lockKey,
          lockReassert: async (options) => {
            probeCount += 1;
            if (probeCount === 2) {
              secondProbeReady.resolve(null);
              await takeoverReady.promise;
            }
            const held = await activeLockHandle.reassert(options);
            if (probeCount === 1) {
              firstProbeComplete.resolve(null);
            }
            return held === true;
          },
          onLockLoss: (error) => controller.abort(error),
          signal: controllerSignal,
        },
        async () => {
          await abortObserved.promise;
          return "drained";
        }
      );

      await firstProbeComplete.promise;
      await secondProbeReady.promise;

      const lockRows = await admin<{ pid: number }[]>`
      SELECT pid
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (
          SELECT oid FROM pg_database WHERE datname = current_database()
        )
        AND classid = 0
        AND objid = ${lockKey}
        AND objsubid = 1
        AND granted
    `;
      expect(lockRows).toHaveLength(1);
      const ownLockPid = lockRows[0]?.pid;
      expect(ownLockPid).toBeDefined();
      await admin`SELECT pg_terminate_backend(${ownLockPid ?? 0})`;

      const [rivalLock] = await rival<{ held: boolean }[]>`
      SELECT pg_try_advisory_lock(${lockKey}) AS held
    `;
      expect(rivalLock?.held).toBe(true);
      takeoverReady.resolve(null);

      await expect(liveness).rejects.toBeInstanceOf(LockLostError);
      expect(controller.signal.aborted).toBe(true);

      expect(await activeRuntime.markLockLost(LOST_AT)).toBe(true);
      const reader = new PostgresSourceHealthReader(database, () => LOST_AT);
      const health = await reader.getByBronId(bronId);
      expect(health?.signals.advisoryLock).toMatchObject({
        reason: "lock_lost",
        state: "failed",
      });
      expect(health?.signals.aggregate).toMatchObject({
        reason: "advisory_lock_not_owned",
        state: "red",
      });
    } catch (error) {
      testFailure = error;
    }

    controller.abort();
    takeoverReady.resolve(null);
    const cleanupErrors: unknown[] = [];
    if (liveness) {
      await bestEffortCleanup(async () => {
        await liveness?.catch(() => {});
      }, cleanupErrors);
    }
    if (runtime) {
      const runtimeOwnerToken = runtime.ownerToken;
      await bestEffortCleanup(async () => {
        await runtime?.close();
      }, cleanupErrors);
      await bestEffortCleanup(async () => {
        await database
          .delete(pollerRuntime)
          .where(eq(pollerRuntime.ownerToken, runtimeOwnerToken));
      }, cleanupErrors);
    }
    if (lockHandle) {
      await bestEffortCleanup(async () => {
        await lockHandle?.release();
      }, cleanupErrors);
    }
    await bestEffortCleanup(async () => {
      await rival`SELECT pg_advisory_unlock_all()`;
    }, cleanupErrors);
    await bestEffortCleanup(async () => {
      await database.delete(bronHealth).where(eq(bronHealth.bronId, bronId));
    }, cleanupErrors);
    await bestEffortCleanup(async () => {
      await database.delete(scrapeRun).where(eq(scrapeRun.id, runId));
    }, cleanupErrors);
    await bestEffortCleanup(async () => {
      await database.delete(bron).where(eq(bron.id, bronId));
    }, cleanupErrors);
    await bestEffortCleanup(async () => {
      await rival.end({ timeout: 5 });
    }, cleanupErrors);
    await bestEffortCleanup(async () => {
      await admin.end({ timeout: 5 });
    }, cleanupErrors);
    await bestEffortCleanup(async () => {
      await sqlClient.end({ timeout: 5 });
    }, cleanupErrors);
    if (testFailure !== undefined) {
      throw testFailure;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Liveness test cleanup failed");
    }
  }
);
