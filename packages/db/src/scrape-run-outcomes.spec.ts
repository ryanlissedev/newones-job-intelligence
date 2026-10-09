import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { emptyRunMetrics } from "@ji/connectors";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresBronRunStatsReader } from "./bron-run-stats";
import { PostgresRunStore } from "./bron-runtime";
import * as schema from "./schema";
import { bron, scrapeRun } from "./schema";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

describe("scrape_run outcome taxonomy (migration 0030)", () => {
  let available = false;
  let migratorClient: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    available = await isPostgresAvailable();
    if (!available) {
      if (databaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    migratorClient = postgres(migratorUrl, { max: 1 });
    await migrate(drizzle(migratorClient, { schema }), { migrationsFolder });
  });

  afterAll(async () => {
    await migratorClient?.end({ timeout: 5 });
  });

  it("persists outcomes, unchanged and failure kind, restores them on resume and surfaces them in run stats", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 2 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const store = new PostgresRunStore(database);
    const metrics = {
      ...emptyRunMetrics(),
      found: 10,
      new: 1,
      outcomes: { rejected_gone: 2, skipped_known: 6 },
      rejected: 2,
      unchanged: 1,
    };

    try {
      await database.insert(bron).values({
        actief: true,
        categorie: "runtime-test",
        id: bronId,
        naam: `Outcomes ${bronId}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      const started = await store.start({
        key,
        mode: "reset",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: new Date(),
      });
      await store.fail({
        failure: {
          class: "connector",
          code: "FETCH_FAILED",
          message: "Connector fetch failed",
          phase: "fetch",
        },
        failureKind: "blocked",
        fenceToken: started.fenceToken,
        finishedAt: new Date(),
        key,
        progress: { checkpoint: { page: 2 }, metrics },
      });

      const [failedRow] = await database
        .select()
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));
      expect(failedRow).toMatchObject({
        failureKind: "blocked",
        ongewijzigd: 1,
        outcomeCounts: { rejected_gone: 2, skipped_known: 6 },
        status: "failed",
      });
      const loaded = await store.load(key);
      expect(loaded?.metrics).toEqual(metrics);

      const stats = await new PostgresBronRunStatsReader(database).bronRunStats(
        { bronIds: [bronId], window: "24u" }
      );
      expect(stats.bronnen[0]).toMatchObject({
        lastFailureKind: "blocked",
        overgeslagen: 6,
      });

      const resumed = await store.start({
        key,
        mode: "resume",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: new Date(),
      });
      expect(resumed.progress.metrics).toEqual(metrics);
      const [reopenedRow] = await database
        .select()
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));
      expect(reopenedRow).toMatchObject({
        failureKind: null,
        status: "running",
      });
    } finally {
      await database.delete(scrapeRun).where(eq(scrapeRun.id, scrapeRunId));
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("rejects a failure kind on a non-failed run and a non-object outcome_counts", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const constraintViolated = async (
      values: Partial<typeof scrapeRun.$inferInsert>
    ): Promise<string | undefined> => {
      try {
        await database.insert(scrapeRun).values({ bronId, ...values });
        return undefined;
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        return cause instanceof Error ? cause.message : String(error);
      }
    };
    try {
      await database.insert(bron).values({
        actief: true,
        categorie: "runtime-test",
        id: bronId,
        naam: `Kind check ${bronId}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      expect(
        await constraintViolated({ failureKind: "blocked", status: "running" })
      ).toContain("scrape_run_failure_kind_check");
      expect(await constraintViolated({ outcomeCounts: [] })).toContain(
        "scrape_run_outcome_counts_object_check"
      );
    } finally {
      await database.delete(scrapeRun).where(eq(scrapeRun.bronId, bronId));
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });
});
