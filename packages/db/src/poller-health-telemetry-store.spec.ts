import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresBronHealthStore } from "./bron-health-stores";
import { PostgresPollerHealthTelemetryStore } from "./poller-health-telemetry-store";
import * as schema from "./schema";
import { bron, bronHealth, pollerRuntime, scrapeRun } from "./schema";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const at = (value: string): Date => new Date(value);

describe("poller health telemetry store", () => {
  let postgresAvailable = false;
  let sqlClient: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>> | undefined;
  let bronId: string;
  let runOneId: string;
  let runTwoId: string;
  let runCollisionId: string;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }

    sqlClient = postgres(testDatabaseUrl, { max: 1 });
    db = drizzle(sqlClient, { schema });
    await migrate(db, { migrationsFolder });

    bronId = crypto.randomUUID();
    runOneId = crypto.randomUUID();
    runTwoId = crypto.randomUUID();
    runCollisionId = crypto.randomUUID();
    await db.insert(bron).values({
      categorie: "test",
      id: bronId,
      naam: `telemetry-${bronId}`,
    });
    await db.insert(scrapeRun).values([
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
      {
        bronId,
        fenceToken: 1,
        id: runCollisionId,
        runKind: "poll",
        status: "running",
      },
    ]);
  });

  afterAll(async () => {
    if (db && bronId) {
      await db.delete(scrapeRun).where(eq(scrapeRun.bronId, bronId));
      await db.delete(bron).where(eq(bron.id, bronId));
    }
    await db?.delete(pollerRuntime);
    await sqlClient?.end({ timeout: 5 });
  });

  it("keeps newly added source telemetry nullable for historical rows", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    await db.insert(bronHealth).values({ bronId });
    const [row] = await db
      .select({
        activeRunId: bronHealth.activeRunId,
        lastCompletionOutcome: bronHealth.lastCompletionOutcome,
        lastFullySuccessfulAt: bronHealth.lastFullySuccessfulAt,
        phaseStartedAt: bronHealth.phaseStartedAt,
        progressAt: bronHealth.progressAt,
        progressPhase: bronHealth.progressPhase,
      })
      .from(bronHealth)
      .where(eq(bronHealth.bronId, bronId));

    expect(row).toEqual({
      activeRunId: null,
      lastCompletionOutcome: null,
      lastFullySuccessfulAt: null,
      phaseStartedAt: null,
      progressAt: null,
      progressPhase: null,
    });
  });

  it("fences runtime heartbeats and increments the successor fence", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const store = new PostgresPollerHealthTelemetryStore(db);
    const oldOwner = crypto.randomUUID();
    const newOwner = crypto.randomUUID();
    const first = await store.claimRuntime({
      advisoryLockAcquired: true,
      advisoryLockMaxAgeMs: 300_000,
      curationBudgetMs: 120_000,
      heartbeatAt: at("2026-09-19T08:00:00.000Z"),
      heartbeatMaxAgeMs: 300_000,
      instanceId: "old-instance",
      lastLockCheckAt: at("2026-09-19T08:00:00.000Z"),
      ownerToken: oldOwner,
      releaseSha: "old-release",
      runBudgetMs: 3_600_000,
      startedAt: at("2026-09-19T07:59:00.000Z"),
    });
    expect(first.fenceToken).toBeGreaterThan(0);
    expect(
      await store.heartbeat({
        at: at("2026-09-19T08:00:01.000Z"),
        fenceToken: first.fenceToken,
        ownerToken: oldOwner,
      })
    ).toBe(true);

    expect(first.record).toMatchObject({
      advisoryLockMaxAgeMs: 300_000,
      curationBudgetMs: 120_000,
      heartbeatMaxAgeMs: 300_000,
      runBudgetMs: 3_600_000,
    });

    const second = await store.claimRuntime({
      advisoryLockAcquired: true,
      advisoryLockMaxAgeMs: 300_000,
      curationBudgetMs: 120_000,
      heartbeatAt: at("2026-09-19T08:01:00.000Z"),
      heartbeatMaxAgeMs: 300_000,
      instanceId: "new-instance",
      lastLockCheckAt: at("2026-09-19T08:01:00.000Z"),
      ownerToken: newOwner,
      releaseSha: "new-release",
      runBudgetMs: 3_600_000,
      startedAt: at("2026-09-19T08:00:59.000Z"),
    });
    expect(second.fenceToken).toBe(first.fenceToken + 1);
    expect(
      await store.heartbeat({
        at: at("2026-09-19T08:01:01.000Z"),
        fenceToken: first.fenceToken,
        ownerToken: oldOwner,
      })
    ).toBe(false);
    expect(
      await store.recordLockCheck({
        at: at("2026-09-19T08:01:02.000Z"),
        fenceToken: first.fenceToken,
        ownerToken: oldOwner,
      })
    ).toBe(false);
    const runtime = await store.readRuntime();
    expect(runtime?.ownerToken).toBe(newOwner);
  });

  it("replaces source ownership and blocks stale same-fence writers", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const store = new PostgresPollerHealthTelemetryStore(db);
    expect(
      await store.claimSourceOwnership({
        bronId,
        fenceToken: 1,
        phase: "fetch",
        phaseStartedAt: at("2026-09-19T09:00:00.000Z"),
        runId: runOneId,
      })
    ).toBe(true);
    expect(
      await store.recordSourceProgress({
        at: at("2026-09-19T09:01:00.000Z"),
        bronId,
        fenceToken: 1,
        phase: "fetch",
        runId: runOneId,
      })
    ).toBe(true);

    expect(
      await store.claimSourceOwnership({
        bronId,
        fenceToken: 2,
        phase: "fetch",
        phaseStartedAt: at("2026-09-19T10:00:00.000Z"),
        runId: runTwoId,
      })
    ).toBe(true);
    expect(
      await store.recordSourceProgress({
        at: at("2026-09-19T10:01:00.000Z"),
        bronId,
        fenceToken: 1,
        phase: "fetch",
        runId: runOneId,
      })
    ).toBe(false);

    expect(
      await store.claimSourceOwnership({
        bronId,
        fenceToken: 1,
        phase: "fetch",
        phaseStartedAt: at("2026-09-19T11:00:00.000Z"),
        runId: runCollisionId,
      })
    ).toBe(true);
    expect(
      await store.recordSourceProgress({
        at: at("2026-09-19T11:01:00.000Z"),
        bronId,
        fenceToken: 2,
        phase: "fetch",
        runId: runTwoId,
      })
    ).toBe(false);
    expect(
      await store.recordSourceProgress({
        at: at("2026-09-19T11:02:00.000Z"),
        bronId,
        fenceToken: 1,
        phase: "fetch",
        runId: runCollisionId,
      })
    ).toBe(true);
  });

  it("fences stale health writes and completion after a successor takes ownership", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const takeoverBronId = crypto.randomUUID();
    const oldRunId = crypto.randomUUID();
    const newRunId = crypto.randomUUID();
    await db.insert(bron).values({
      categorie: "test",
      id: takeoverBronId,
      naam: "source-takeover-regression",
    });
    await db.insert(scrapeRun).values([
      {
        bronId: takeoverBronId,
        fenceToken: 1,
        id: oldRunId,
        runKind: "poll",
        status: "running",
      },
      {
        bronId: takeoverBronId,
        fenceToken: 2,
        id: newRunId,
        runKind: "poll",
        status: "running",
      },
    ]);
    try {
      const telemetry = new PostgresPollerHealthTelemetryStore(db);
      const health = new PostgresBronHealthStore(db);
      const s1CompletedAt = at("2026-09-19T11:30:00.000Z");
      const s2CompletedAt = at("2026-09-19T11:32:00.000Z");

      expect(
        await telemetry.claimSourceOwnership({
          bronId: takeoverBronId,
          fenceToken: 1,
          phase: "fetch",
          phaseStartedAt: at("2026-09-19T11:00:00.000Z"),
          runId: oldRunId,
        })
      ).toBe(true);
      await db
        .update(scrapeRun)
        .set({ geindigd: s1CompletedAt, status: "succeeded" })
        .where(
          and(eq(scrapeRun.id, oldRunId), eq(scrapeRun.bronId, takeoverBronId))
        );

      expect(
        await telemetry.claimSourceOwnership({
          bronId: takeoverBronId,
          fenceToken: 2,
          phase: "fetch",
          phaseStartedAt: at("2026-09-19T11:31:00.000Z"),
          runId: newRunId,
        })
      ).toBe(true);

      expect(
        await health.upsertForRun({
          bronId: takeoverBronId,
          fenceToken: 1,
          record: {
            bronId: takeoverBronId,
            circuitStatus: "closed",
            lastRunAt: s1CompletedAt,
            lastRunStatus: "succeeded",
            silenceAlertOpen: true,
          },
          runId: oldRunId,
        })
      ).toBeNull();

      const [afterStaleHealthWrite] = await db
        .select({
          activeRunId: bronHealth.activeRunId,
          lastRunAt: bronHealth.lastRunAt,
          lastRunStatus: bronHealth.lastRunStatus,
          silenceAlertOpen: bronHealth.silenceAlertOpen,
        })
        .from(bronHealth)
        .where(eq(bronHealth.bronId, takeoverBronId));
      expect(afterStaleHealthWrite).toEqual({
        activeRunId: newRunId,
        lastRunAt: null,
        lastRunStatus: null,
        silenceAlertOpen: false,
      });

      expect(
        await telemetry.finishSource({
          bronId: takeoverBronId,
          completedAt: s1CompletedAt,
          discoveryComplete: true,
          drained: true,
          fenceToken: 1,
          hasFailures: false,
          hasQuarantined: false,
          outcome: "complete",
          runId: oldRunId,
        })
      ).toBe(false);

      await db
        .update(scrapeRun)
        .set({ geindigd: s2CompletedAt, status: "succeeded" })
        .where(
          and(eq(scrapeRun.id, newRunId), eq(scrapeRun.bronId, takeoverBronId))
        );
      expect(
        await telemetry.claimSourceOwnership({
          bronId: takeoverBronId,
          fenceToken: 2,
          phase: "curation",
          phaseStartedAt: at("2026-09-19T11:31:30.000Z"),
          runId: newRunId,
        })
      ).toBe(true);
      expect(
        await telemetry.finishSource({
          bronId: takeoverBronId,
          completedAt: s2CompletedAt,
          discoveryComplete: true,
          drained: true,
          fenceToken: 2,
          hasFailures: false,
          hasQuarantined: false,
          outcome: "complete",
          runId: newRunId,
        })
      ).toBe(true);

      const [afterSuccessorFinish] = await db
        .select({
          activeRunId: bronHealth.activeRunId,
          lastCompletionOutcome: bronHealth.lastCompletionOutcome,
          lastFullySuccessfulAt: bronHealth.lastFullySuccessfulAt,
        })
        .from(bronHealth)
        .where(eq(bronHealth.bronId, takeoverBronId));
      expect(afterSuccessorFinish).toEqual({
        activeRunId: null,
        lastCompletionOutcome: "complete",
        lastFullySuccessfulAt: s2CompletedAt,
      });
    } finally {
      await db.delete(scrapeRun).where(eq(scrapeRun.bronId, takeoverBronId));
      await db.delete(bronHealth).where(eq(bronHealth.bronId, takeoverBronId));
      await db.delete(bron).where(eq(bron.id, takeoverBronId));
    }
  });

  it("records freshness only for complete, drained, failure-free curation", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const store = new PostgresPollerHealthTelemetryStore(db);
    await db
      .update(scrapeRun)
      .set({ geindigd: at("2026-09-19T12:00:00.000Z"), status: "succeeded" })
      .where(and(eq(scrapeRun.id, runTwoId), eq(scrapeRun.bronId, bronId)));

    expect(
      await store.claimSourceOwnership({
        bronId,
        fenceToken: 2,
        phase: "curation",
        phaseStartedAt: at("2026-09-19T12:01:00.000Z"),
        runId: runTwoId,
      })
    ).toBe(true);
    expect(
      await store.beginSourcePhase({
        bronId,
        fenceToken: 2,
        phase: "curation",
        phaseStartedAt: at("2026-09-19T12:01:15.000Z"),
        runId: runTwoId,
      })
    ).toBe(true);
    await expect(
      store.finishSource({
        bronId,
        completedAt: at("2026-09-19T12:01:30.000Z"),
        discoveryComplete: true,
        drained: true,
        fenceToken: 2,
        hasFailures: true,
        hasQuarantined: false,
        outcome: "complete",
        runId: runTwoId,
      })
    ).rejects.toThrow("Complete source outcome requires");
    expect(
      await store.finishSource({
        bronId,
        completedAt: at("2026-09-19T12:01:30.000Z"),
        discoveryComplete: false,
        drained: false,
        fenceToken: 2,
        hasFailures: true,
        hasQuarantined: false,
        outcome: "failed",
        runId: runTwoId,
      })
    ).toBe(true);
    const incompleteRow = await db
      .select({
        lastCompletionOutcome: bronHealth.lastCompletionOutcome,
        lastFullySuccessfulAt: bronHealth.lastFullySuccessfulAt,
      })
      .from(bronHealth)
      .where(eq(bronHealth.bronId, bronId));
    expect(incompleteRow[0]).toEqual({
      lastCompletionOutcome: "failed",
      lastFullySuccessfulAt: null,
    });

    expect(
      await store.claimSourceOwnership({
        bronId,
        fenceToken: 2,
        phase: "curation",
        phaseStartedAt: at("2026-09-19T12:01:45.000Z"),
        runId: runTwoId,
      })
    ).toBe(true);
    const completedAt = at("2026-09-19T12:02:00.000Z");
    expect(
      await store.finalizeSource({
        bronId,
        completedAt,
        discoveryComplete: true,
        drained: true,
        fenceToken: 2,
        hasFailures: false,
        hasQuarantined: false,
        outcome: "complete",
        runId: runTwoId,
      })
    ).toBe(true);

    const [row] = await db
      .select({
        activeRunId: bronHealth.activeRunId,
        lastCompletionOutcome: bronHealth.lastCompletionOutcome,
        lastFullySuccessfulAt: bronHealth.lastFullySuccessfulAt,
        phaseStartedAt: bronHealth.phaseStartedAt,
        progressAt: bronHealth.progressAt,
        progressPhase: bronHealth.progressPhase,
      })
      .from(bronHealth)
      .where(eq(bronHealth.bronId, bronId));
    expect(row).toEqual({
      activeRunId: null,
      lastCompletionOutcome: "complete",
      lastFullySuccessfulAt: completedAt,
      phaseStartedAt: null,
      progressAt: null,
      progressPhase: null,
    });
  });
});
