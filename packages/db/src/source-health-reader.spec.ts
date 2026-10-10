import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "./schema";
import { bron, bronHealth, pollerRuntime, scrapeRun } from "./schema";
import { PostgresSourceHealthReader } from "./source-health-reader";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
const NOW = new Date("2026-09-19T12:00:00.000Z");

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

const ago = (milliseconds: number): Date =>
  new Date(NOW.getTime() - milliseconds);

describe("source health reader", () => {
  let postgresAvailable = false;
  let sqlClient: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>> | undefined;
  const bronIds: string[] = [];

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
  });

  afterAll(async () => {
    if (db && bronIds.length > 0) {
      await db.delete(bron).where(inArray(bron.id, bronIds));
    }
    await db?.delete(pollerRuntime);
    await sqlClient?.end({ timeout: 5 });
  });

  const requireDb = (): ReturnType<typeof drizzle<typeof schema>> => {
    if (!postgresAvailable || !db) {
      throw new Error("Test database is unavailable");
    }
    return db;
  };

  const createBron = async (
    options: {
      readonly actief?: boolean;
      readonly interval?: string;
      readonly status?: "blocked" | "deferred" | "ready";
      readonly voorwaardenStatus?: "te_toetsen" | "toegestaan" | "verboden";
    } = {}
  ): Promise<string> => {
    const database = requireDb();
    const id = crypto.randomUUID();
    bronIds.push(id);
    await database.insert(bron).values({
      actief: options.actief ?? true,
      categorie: "test",
      id,
      interval: options.interval ?? "*/5 * * * *",
      naam: `health-reader-${id}`,
      status: options.status ?? "ready",
      voorwaardenStatus: options.voorwaardenStatus ?? "toegestaan",
    });
    return id;
  };

  const writeRuntime = async (
    status: "lock_lost" | "running" | "stopped" = "running"
  ) => {
    const database = requireDb();
    await database
      .insert(pollerRuntime)
      .values({
        advisoryLockMaxAgeMs: 30_000,
        component: "poller",
        curationBudgetMs: 120_000,
        fenceToken: 1,
        heartbeatAt: ago(1000),
        heartbeatMaxAgeMs: 30_000,
        instanceId: "health-reader-test",
        lastLockCheckAt: ago(1000),
        ownerToken: crypto.randomUUID(),
        releaseSha: "test-release",
        runBudgetMs: 60_000,
        startedAt: ago(10_000),
        status,
        updatedAt: ago(1000),
      })
      .onConflictDoUpdate({
        set: {
          advisoryLockMaxAgeMs: 30_000,
          curationBudgetMs: 120_000,
          fenceToken: 1,
          heartbeatAt: ago(1000),
          heartbeatMaxAgeMs: 30_000,
          instanceId: "health-reader-test",
          lastLockCheckAt: ago(1000),
          ownerToken: crypto.randomUUID(),
          releaseSha: "test-release",
          runBudgetMs: 60_000,
          startedAt: ago(10_000),
          status,
          updatedAt: ago(1000),
        },
        target: pollerRuntime.component,
      });
  };

  const writeRun = async (input: {
    readonly bronId: string;
    readonly id?: string;
    readonly status: "cancelled" | "failed" | "running" | "succeeded";
  }): Promise<string> => {
    const database = requireDb();
    const id = input.id ?? crypto.randomUUID();
    const terminal = input.status !== "running";
    const baseValues = {
      bronId: input.bronId,
      fenceToken: 1,
      geindigd: terminal ? ago(1000) : null,
      gestart: ago(10_000),
      id,
      runKind: "poll",
      status: input.status,
    };
    const values =
      input.status === "failed"
        ? {
            ...baseValues,
            failureClass: "internal",
            failureCode: "UNEXPECTED_FAILURE",
            failureMessage: "Connector run failed",
            failurePhase: "unknown",
          }
        : baseValues;
    await database.insert(scrapeRun).values(values);
    return id;
  };

  const writeHealth = async (input: {
    readonly bronId: string;
    readonly activeRunId?: string | null;
    readonly lastCompletionOutcome?:
      | "backlogged"
      | "complete"
      | "failed"
      | "incomplete"
      | "parked"
      | "quarantined"
      | "unknown";
    readonly lastFullySuccessfulAt?: Date | null;
    readonly phaseStartedAt?: Date | null;
    readonly progressAt?: Date | null;
    readonly progressPhase?: "curation" | "fetch" | "persist" | null;
  }): Promise<void> => {
    const database = requireDb();
    await database.insert(bronHealth).values({
      activeRunId: input.activeRunId,
      bronId: input.bronId,
      lastCompletionOutcome: input.lastCompletionOutcome,
      lastFullySuccessfulAt: input.lastFullySuccessfulAt,
      phaseStartedAt: input.phaseStartedAt,
      progressAt: input.progressAt,
      progressPhase: input.progressPhase,
    });
  };

  const read = (bronId: string) =>
    new PostgresSourceHealthReader(requireDb(), () => NOW).getByBronId(bronId);

  it("returns unknown telemetry for a registered source without health or runtime rows", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const bronId = await createBron();
    const result = await read(bronId);
    expect(result?.signals.process).toMatchObject({
      reason: "never_reported",
      state: "unknown",
    });
    expect(result?.signals.advisoryLock.state).toBe("unknown");
    expect(result?.signals.aggregate).toMatchObject({
      reason: "process_telemetry_unknown",
      state: "unknown",
    });
  });

  it("keeps inactive and blocked sources out of green health", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const inactiveId = await createBron({ actief: false });
    const blockedId = await createBron({
      actief: false,
      status: "blocked",
      voorwaardenStatus: "te_toetsen",
    });
    await writeRuntime();
    const reader = new PostgresSourceHealthReader(requireDb(), () => NOW);
    const results = await reader.listByBronIds([inactiveId, blockedId]);
    expect(results).toHaveLength(2);
    const stateByBronId = new Map(
      results.map((item) => [item.bronId, item.signals.aggregate.state])
    );
    expect(stateByBronId.get(inactiveId)).toBe("inactive");
    expect(stateByBronId.get(blockedId)).toBe("blocked");
    expect(
      results.every((item) => item.signals.aggregate.state !== "green")
    ).toBe(true);
  });

  it("reports persisted fetch and curation milestones as progressing with runtime budgets", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const bronId = await createBron();
    await writeRuntime();
    const runId = await writeRun({ bronId, status: "running" });
    await writeHealth({
      activeRunId: runId,
      bronId,
      phaseStartedAt: ago(2000),
      progressAt: ago(1000),
      progressPhase: "fetch",
    });
    const fetchResult = await read(bronId);
    expect(fetchResult?.signals.process.state).toBe("ok");
    expect(fetchResult?.signals.advisoryLock.reason).toBe("lock_held");
    expect(fetchResult?.signals.progress).toMatchObject({
      reason: "progressing",
      state: "progressing",
    });
    expect(fetchResult?.signals.aggregate.state).toBe("progressing");

    const database = requireDb();
    await database
      .update(scrapeRun)
      .set({ geindigd: ago(500), status: "succeeded" })
      .where(eq(scrapeRun.id, runId));
    await database
      .update(bronHealth)
      .set({
        phaseStartedAt: ago(2000),
        progressAt: ago(1000),
        progressPhase: "curation",
      })
      .where(eq(bronHealth.bronId, bronId));
    const curationResult = await read(bronId);
    expect(curationResult?.signals.progress.state).toBe("progressing");
    expect(curationResult?.signals.aggregate.state).toBe("progressing");
  });

  it("does not call failed or cancelled runs progressing", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    await writeRuntime();
    const failedBronId = await createBron();
    const failedRunId = await writeRun({
      bronId: failedBronId,
      status: "failed",
    });
    await writeHealth({
      activeRunId: failedRunId,
      bronId: failedBronId,
      progressAt: ago(1000),
      progressPhase: "fetch",
    });
    const cancelledBronId = await createBron();
    const cancelledRunId = await writeRun({
      bronId: cancelledBronId,
      status: "cancelled",
    });
    await writeHealth({
      activeRunId: cancelledRunId,
      bronId: cancelledBronId,
      progressAt: ago(1000),
      progressPhase: "fetch",
    });

    const reader = new PostgresSourceHealthReader(requireDb(), () => NOW);
    const results = await reader.listByBronIds([failedBronId, cancelledBronId]);
    expect(
      results.every((item) => item.signals.progress.reason === "no_active_run")
    ).toBe(true);
    expect(
      results.every((item) => item.signals.progress.state !== "progressing")
    ).toBe(true);
  });

  it("reports stopped or lock-lost runtime as not held", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const bronId = await createBron();
    await writeRuntime("lock_lost");
    const lockLost = await read(bronId);
    expect(lockLost?.signals.advisoryLock).toMatchObject({
      ageMs: 1000,
      observedAt: ago(1000),
      reason: "lock_lost",
      state: "failed",
    });
    await writeRuntime("stopped");
    await db
      .update(pollerRuntime)
      .set({ lastLockCheckAt: ago(20_000), updatedAt: ago(500) })
      .where(eq(pollerRuntime.component, "poller"));
    const stopped = await read(bronId);
    expect(stopped?.signals.advisoryLock).toMatchObject({
      ageMs: 500,
      observedAt: ago(500),
      state: "failed",
    });
    expect(stopped?.signals.aggregate.state).toBe("red");
  });

  it("keeps incomplete, backlogged, and parked outcomes from becoming green", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    await writeRuntime();
    const ids: string[] = [];
    const outcomes = ["incomplete", "backlogged", "parked"] as const;
    await Promise.all(
      outcomes.map(async (outcome) => {
        const bronId = await createBron();
        ids.push(bronId);
        await writeHealth({
          bronId,
          lastCompletionOutcome: outcome,
          lastFullySuccessfulAt: ago(1000),
        });
      })
    );
    const reader = new PostgresSourceHealthReader(requireDb(), () => NOW);
    const results = await reader.listByBronIds(ids);
    expect(
      results.every((item) => item.signals.freshness.state === "stale")
    ).toBe(true);
    expect(
      results.every((item) => item.signals.aggregate.state !== "green")
    ).toBe(true);
  });

  it("returns policy unknown for an invalid cron freshness schedule", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const bronId = await createBron({ interval: "not-a-cron" });
    await writeRuntime();
    await writeHealth({
      bronId,
      lastFullySuccessfulAt: ago(1000),
    });
    const result = await read(bronId);
    expect(result?.signals.freshness).toMatchObject({
      reason: "freshness_policy_unknown",
      state: "unknown",
    });
  });

  it("maps a failed bulk query to unknown database telemetry", async () => {
    // SAFETY: The reader only invokes select() in this test; this stub models a
    // database boundary that synchronously throws before returning a query.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Minimal failing database stub cannot implement the full Drizzle surface.
    const brokenDatabase = {
      select: () => {
        throw new Error("database unavailable");
      },
    } as unknown as ReturnType<typeof drizzle<typeof schema>>;
    const reader = new PostgresSourceHealthReader(brokenDatabase, () => NOW);
    const [result] = await reader.listByBronIds([crypto.randomUUID()]);
    expect(result?.signals.database).toMatchObject({
      reason: "database_unavailable",
      state: "unknown",
    });
    expect(result?.signals.aggregate.state).toBe("unknown");
  });
});
