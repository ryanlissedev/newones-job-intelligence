import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { PollerHealthTelemetry } from "@ji/db/poller-health-telemetry-store";
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
import { Effect } from "effect";
import postgres from "postgres";

import { createPollerRuntimeHealth } from "./runtime-health";
import { createSourceHealthCallbacks } from "./source-health";

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

const BASE = new Date("2026-09-19T12:00:00.000Z");
const BRON_ID = crypto.randomUUID();
const RUN_ID = crypto.randomUUID();
const SOURCE_FENCE_TOKEN = 1;
const POLLER_ADVISORY_LOCK_KEY = 613_204_877;

describe
  .skipIf(!postgresAvailable)
  .serial("poller health vertical flow", () => {
    let sqlClient: ReturnType<typeof postgres>;
    let database: ReturnType<typeof drizzle<typeof schema>>;
    let lockSql: ReturnType<typeof postgres>;
    let runtime: Awaited<ReturnType<typeof createPollerRuntimeHealth>>;
    let now = BASE;

    beforeAll(async () => {
      sqlClient = postgres(testDatabaseUrl, { max: 1 });
      lockSql = postgres(testDatabaseUrl, { max: 1 });
      database = drizzle(sqlClient, { schema });
      await migrate(database, { migrationsFolder });
      const [lock] = await lockSql`
      SELECT pg_try_advisory_lock(${POLLER_ADVISORY_LOCK_KEY}) AS held
    `;
      expect(lock?.held).toBe(true);
      await database.insert(bron).values({
        actief: true,
        categorie: "test",
        id: BRON_ID,
        interval: "*/5 * * * *",
        naam: "poller-health-flow",
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      await database.insert(scrapeRun).values({
        bronId: BRON_ID,
        fenceToken: SOURCE_FENCE_TOKEN,
        gestart: BASE,
        id: RUN_ID,
        runKind: "poll",
        status: "running",
      });
      runtime = await createPollerRuntimeHealth({
        advisoryLockMaxAgeMs: 120_000,
        curationBudgetMs: 120_000,
        databaseUrl: testDatabaseUrl,
        heartbeatAt: BASE,
        heartbeatMaxAgeMs: 120_000,
        instanceId: `health-flow-${BRON_ID}`,
        lastLockCheckAt: BASE,
        releaseSha: "a".repeat(40),
        runBudgetMs: 60_000,
        startedAt: BASE,
        telemetryClientOptions: { operationTimeoutMs: 2000 },
      });
    });

    afterAll(async () => {
      await runtime?.close();
      await database?.delete(scrapeRun).where(eq(scrapeRun.id, RUN_ID));
      await database?.delete(bronHealth).where(eq(bronHealth.bronId, BRON_ID));
      await database?.delete(bron).where(eq(bron.id, BRON_ID));
      if (runtime) {
        await database
          ?.delete(pollerRuntime)
          .where(eq(pollerRuntime.ownerToken, runtime.ownerToken));
      }
      if (lockSql) {
        await lockSql`SELECT pg_advisory_unlock_all()`;
        await lockSql.end({ timeout: 5 });
      }
      await sqlClient?.end({ timeout: 5 });
    });

    it("persists milestones, detects a stale run, and records telemetry lock loss", async () => {
      const claimSourceOwnership = Effect.runPromise(
        Effect.gen(function* claimSource() {
          const telemetry = yield* PollerHealthTelemetry;
          return yield* telemetry.claimSourceOwnership({
            bronId: BRON_ID,
            fenceToken: SOURCE_FENCE_TOKEN,
            phase: "fetch",
            phaseStartedAt: BASE,
            runId: RUN_ID,
          });
        }).pipe(Effect.provide(runtime.layer))
      );
      expect(await claimSourceOwnership).toBe(true);

      const health = createSourceHealthCallbacks(runtime.layer, () => now);
      now = new Date("2026-09-19T12:00:01.000Z");
      await health.callbacks.onProgress?.({
        fenceToken: SOURCE_FENCE_TOKEN,
        key: { bronId: BRON_ID, scrapeRunId: RUN_ID },
        observedAt: new Date("2026-09-19T12:00:01.000Z"),
        phase: "fetch",
      });

      const reader = new PostgresSourceHealthReader(database, () => now);
      const progressing = await reader.getByBronId(BRON_ID);
      expect(progressing?.signals.progress).toMatchObject({
        reason: "progressing",
        state: "progressing",
      });
      expect(progressing?.signals.process.state).toBe("ok");

      now = new Date("2026-09-19T12:01:02.000Z");
      await runtime.recordTelemetry({ heartbeatAt: now, lastLockCheckAt: now });
      const stale = await reader.getByBronId(BRON_ID);
      expect(stale?.signals.progress).toMatchObject({
        reason: "progress_stalled",
        state: "stale",
      });
      expect(stale?.signals.aggregate).toMatchObject({
        reason: "progress_stalled",
        state: "red",
      });
      expect(stale?.signals.process.state).toBe("ok");

      // This exercises the telemetry boundary after the poller reports lock loss;
      // advisory-lock reassertion and shutdown cancellation are separate paths.
      expect(await runtime.markLockLost(now)).toBe(true);
      const lockLost = await reader.getByBronId(BRON_ID);
      expect(lockLost?.signals.advisoryLock).toMatchObject({
        reason: "lock_lost",
        state: "failed",
      });
      expect(lockLost?.signals.aggregate).toMatchObject({
        reason: "advisory_lock_not_owned",
        state: "red",
      });
    });
  });
