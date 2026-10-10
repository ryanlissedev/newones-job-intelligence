import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { emptyRunMetrics, RunAlreadyInProgressError } from "@ji/connectors";
import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { PostgresRunStore } from "./bron-runtime";
import * as schema from "./schema";
import { bron, bronHealth, scrapeRun } from "./schema";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

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

const NOW = new Date("2026-09-16T12:00:00.000Z");
const STALE_AFTER_MS = 60_000;
const progress = { checkpoint: null, metrics: emptyRunMetrics() };

describe("Postgres poll-run launch fencing", () => {
  let available = false;
  let client: ReturnType<typeof postgres> | null = null;
  let database: PostgresJsDatabase<typeof schema> | null = null;
  const bronIds: string[] = [];

  beforeAll(async () => {
    available = await isPostgresAvailable();
    if (!available) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    client = postgres(applicationUrl, { max: 4 });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (database && bronIds.length > 0) {
      await database.delete(bron).where(inArray(bron.id, bronIds));
    }
    await client?.end({ timeout: 5 });
  });

  const seedBron = async (): Promise<string> => {
    if (!database) {
      throw new Error("Postgres fixture is unavailable");
    }
    const bronId = crypto.randomUUID();
    bronIds.push(bronId);
    await database.insert(bron).values({
      actief: true,
      categorie: "overheidsportaal",
      id: bronId,
      interval: "*/15 * * * *",
      naam: `CTP-511 ${bronId}`,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
    return bronId;
  };

  it("allows exactly one of two concurrent starts for the same bron", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const bronId = await seedBron();
    const store = new PostgresRunStore(database, {
      now: () => NOW,
      pollRunStaleAfterMs: STALE_AFTER_MS,
    });
    const starts = [crypto.randomUUID(), crypto.randomUUID()].map(
      (scrapeRunId) =>
        store.start({
          key: { bronId, scrapeRunId },
          mode: "reset",
          progress,
          runKind: "poll",
          startedAt: NOW,
        })
    );

    const results = await Promise.allSettled(starts);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejected?.reason).toBeInstanceOf(RunAlreadyInProgressError);
    expect(rejected?.reason).toMatchObject({
      bronId,
      code: "RUN_ALREADY_IN_PROGRESS",
    });

    const [persisted] = await database
      .select({ value: count() })
      .from(scrapeRun)
      .where(
        and(
          eq(scrapeRun.bronId, bronId),
          eq(scrapeRun.runKind, "poll"),
          eq(scrapeRun.status, "running")
        )
      );
    expect(persisted?.value).toBe(1);
    const [health] = await database
      .select()
      .from(bronHealth)
      .where(eq(bronHealth.bronId, bronId));
    const [running] = await database
      .select({ id: scrapeRun.id })
      .from(scrapeRun)
      .where(
        and(eq(scrapeRun.bronId, bronId), eq(scrapeRun.status, "running"))
      );
    expect(health?.activeRunId).toBe(running?.id);
    expect(health?.progressAt).toBeNull();
    expect(health?.phaseStartedAt).toEqual(NOW);
    expect(health?.progressPhase).toBe("fetch");
    expect(health?.lastFullySuccessfulAt).toBeNull();
  });

  it("allows a fresh start when the only running poll is stale", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const bronId = await seedBron();
    await database.insert(scrapeRun).values({
      bronId,
      gestart: new Date(NOW.getTime() - STALE_AFTER_MS - 1),
      id: crypto.randomUUID(),
      runKind: "poll",
      status: "running",
    });
    const store = new PostgresRunStore(database, {
      now: () => NOW,
      pollRunStaleAfterMs: STALE_AFTER_MS,
    });

    await expect(
      store.start({
        key: { bronId, scrapeRunId: crypto.randomUUID() },
        mode: "reset",
        progress,
        runKind: "poll",
        startedAt: NOW,
      })
    ).resolves.toMatchObject({ fenceToken: 1 });
  });
  it("replaces a failed active run when the next distinct run also starts at fence one", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const bronId = await seedBron();
    const store = new PostgresRunStore(database, {
      now: () => NOW,
      pollRunStaleAfterMs: STALE_AFTER_MS,
    });
    const oldRunId = crypto.randomUUID();
    const first = await store.start({
      key: { bronId, scrapeRunId: oldRunId },
      mode: "reset",
      progress,
      runKind: "poll",
      startedAt: NOW,
    });
    await store.fail({
      failure: {
        class: "internal",
        code: "UNEXPECTED_FAILURE",
        message: "Connector run failed",
        phase: "unknown",
      },
      fenceToken: first.fenceToken,
      finishedAt: NOW,
      key: { bronId, scrapeRunId: oldRunId },
      progress,
    });
    const newRunId = crypto.randomUUID();
    const second = await store.start({
      key: { bronId, scrapeRunId: newRunId },
      mode: "reset",
      progress,
      runKind: "poll",
      startedAt: NOW,
    });
    expect(first.fenceToken).toBe(1);
    expect(second.fenceToken).toBe(1);
    const [health] = await database
      .select()
      .from(bronHealth)
      .where(eq(bronHealth.bronId, bronId));
    expect(health?.activeRunId).toBe(newRunId);
    expect(health?.progressAt).toBeNull();
    expect(health?.lastFullySuccessfulAt).toBeNull();
  });
});
