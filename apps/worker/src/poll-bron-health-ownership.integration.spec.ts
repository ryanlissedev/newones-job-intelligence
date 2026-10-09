import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { PostgresAlertStore } from "@ji/db/bron-health-stores";
import { PostgresPollerHealthTelemetryStore } from "@ji/db/poller-health-telemetry-store";
import { alert, bron, bronHealth, scrapeRun } from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
process.env.DATABASE_URL ??= testDatabaseUrl;
const {
  createPollBronRuntime,
  handleSilenceAndHealth,
  recordDiscoveryFloorBreach,
} = await import("./poll-bron-run");
const migrationsFolder = path.join(
  import.meta.dir,
  "../../../packages/db/src/migrations"
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

const at = (value: string): Date => new Date(value);

type PollBronRunResult = Parameters<typeof handleSilenceAndHealth>[0];

describe
  .skipIf(!postgresAvailable)
  .serial("poll-bron health ownership integration", () => {
    let sqlClient: ReturnType<typeof postgres>;
    let database: ReturnType<typeof drizzle<typeof schema>>;
    let runtime: ReturnType<typeof createPollBronRuntime>;
    let bronId: string;
    let runOneId: string;
    let runTwoId: string;

    beforeAll(async () => {
      sqlClient = postgres(testDatabaseUrl, { max: 2 });
      database = drizzle(sqlClient, { schema });
      await migrate(database, { migrationsFolder });

      bronId = crypto.randomUUID();
      runOneId = crypto.randomUUID();
      runTwoId = crypto.randomUUID();
      await database.insert(bron).values({
        categorie: "test",
        id: bronId,
        naam: `health-ownership-${bronId.slice(0, 8)}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      await database.insert(scrapeRun).values([
        {
          bronId,
          fenceToken: 1,
          id: runOneId,
          runKind: "poll",
          status: "running",
        },
        {
          bronId,
          fenceToken: 2,
          id: runTwoId,
          runKind: "poll",
          status: "running",
        },
      ]);

      const telemetry = new PostgresPollerHealthTelemetryStore(database);
      expect(
        await telemetry.claimSourceOwnership({
          bronId,
          fenceToken: 1,
          phase: "fetch",
          phaseStartedAt: at("2026-09-19T13:00:00.000Z"),
          runId: runOneId,
        })
      ).toBe(true);
      await database
        .update(scrapeRun)
        .set({
          geindigd: at("2026-09-19T13:01:00.000Z"),
          status: "succeeded",
        })
        .where(eq(scrapeRun.id, runOneId));
      expect(
        await telemetry.claimSourceOwnership({
          bronId,
          fenceToken: 2,
          phase: "fetch",
          phaseStartedAt: at("2026-09-19T13:02:00.000Z"),
          runId: runTwoId,
        })
      ).toBe(true);

      runtime = createPollBronRuntime(testDatabaseUrl);
      runtime.loadBaseline = () =>
        Promise.resolve([
          // Two zero polls at the head: the floor only arms on a third
          // consecutive zero, so a healthy baseline alone would return before
          // reaching the ownership gate this spec exists to exercise.
          ...Array.from({ length: 2 }, (_, index) => ({
            at: new Date(Date.now() - (index + 1) * 15 * 60_000),
            changed: 0,
            found: 0,
            new: 0,
          })),
          ...Array.from({ length: 5 }, (_, index) => ({
            at: new Date(Date.now() - (index + 1) * 86_400_000),
            changed: 4,
            found: 40,
            new: 8,
          })),
        ]);
    });

    afterAll(async () => {
      await runtime?.close();
      await database?.delete(alert).where(eq(alert.bronId, bronId));
      await database?.delete(scrapeRun).where(eq(scrapeRun.bronId, bronId));
      await database?.delete(bronHealth).where(eq(bronHealth.bronId, bronId));
      await database?.delete(bron).where(eq(bron.id, bronId));
      await sqlClient?.end({ timeout: 5 });
    });

    it("rejects stale S1 health and alert paths after S2 takes ownership", async () => {
      const staleRun: PollBronRunResult = {
        bronId,
        bronSlug: "tenderned",
        completeness: null,
        fenceToken: 1,
        lifecycle: null,
        metrics: {
          changed: 0,
          error: 0,
          found: 10,
          new: 0,
          rejected: 0,
          unchanged: 10,
        },
        scrapeRunId: runOneId,
        status: "succeeded",
        writtenRecords: 0,
      };

      const before = await database
        .select({
          activeRunId: bronHealth.activeRunId,
          lastRunAt: bronHealth.lastRunAt,
          lastRunStatus: bronHealth.lastRunStatus,
          silenceAlertOpen: bronHealth.silenceAlertOpen,
        })
        .from(bronHealth)
        .where(eq(bronHealth.bronId, bronId));
      expect(before[0]).toEqual({
        activeRunId: runTwoId,
        lastRunAt: null,
        lastRunStatus: null,
        silenceAlertOpen: false,
      });

      const { RunOwnershipLostError } = await import("@ji/connectors");
      await expect(
        handleSilenceAndHealth(staleRun, runtime, "poll")
      ).rejects.toBeInstanceOf(RunOwnershipLostError);
      await expect(
        recordDiscoveryFloorBreach(
          { ...staleRun, metrics: { ...staleRun.metrics, found: 0 } },
          runtime,
          "poll"
        )
      ).rejects.toBeInstanceOf(RunOwnershipLostError);
      const [oldRunAfter] = await database
        .select({
          failureCode: scrapeRun.failureCode,
          status: scrapeRun.status,
        })
        .from(scrapeRun)
        .where(eq(scrapeRun.id, runOneId));
      expect(oldRunAfter).toEqual({ failureCode: null, status: "succeeded" });

      // S2 owns the source but is still running: the terminal-state guard must
      // roll back its preceding health update when it cannot mark this run failed.
      await expect(
        recordDiscoveryFloorBreach(
          {
            ...staleRun,
            fenceToken: 2,
            metrics: { ...staleRun.metrics, found: 0 },
            scrapeRunId: runTwoId,
          },
          runtime,
          "poll"
        )
      ).rejects.toBeInstanceOf(RunOwnershipLostError);

      const after = await database
        .select({
          activeRunId: bronHealth.activeRunId,
          lastRunAt: bronHealth.lastRunAt,
          lastRunStatus: bronHealth.lastRunStatus,
          silenceAlertOpen: bronHealth.silenceAlertOpen,
        })
        .from(bronHealth)
        .where(eq(bronHealth.bronId, bronId));
      expect(after).toEqual(before);
      const alerts = await new PostgresAlertStore(database).listOpen();
      expect(alerts.filter((row) => row.bronId === bronId)).toEqual([]);
    });

    it("clears a budget-cut completion when a floor breach fails the owning run", async () => {
      const ownedRunId = crypto.randomUUID();
      await database.insert(scrapeRun).values({
        bronId,
        fenceToken: 3,
        id: ownedRunId,
        runKind: "poll",
        status: "running",
      });
      const telemetry = new PostgresPollerHealthTelemetryStore(database);
      expect(
        await telemetry.claimSourceOwnership({
          bronId,
          fenceToken: 3,
          phase: "fetch",
          phaseStartedAt: at("2026-09-19T13:03:00.000Z"),
          runId: ownedRunId,
        })
      ).toBe(true);
      await database
        .update(scrapeRun)
        .set({
          completion: "budget_exhausted",
          geindigd: at("2026-09-19T13:04:00.000Z"),
          status: "succeeded",
        })
        .where(eq(scrapeRun.id, ownedRunId));

      const breach = await recordDiscoveryFloorBreach(
        {
          bronId,
          bronSlug: "tenderned",
          completeness: null,
          fenceToken: 3,
          lifecycle: null,
          metrics: {
            changed: 0,
            error: 0,
            found: 0,
            new: 0,
            rejected: 0,
            unchanged: 0,
          },
          scrapeRunId: ownedRunId,
          status: "succeeded",
          writtenRecords: 0,
        },
        runtime,
        "poll"
      );
      expect(breach).not.toBeNull();

      const [failedRun] = await database
        .select({ completion: scrapeRun.completion, status: scrapeRun.status })
        .from(scrapeRun)
        .where(eq(scrapeRun.id, ownedRunId));
      expect(failedRun).toEqual({ completion: null, status: "failed" });
    });
  });
