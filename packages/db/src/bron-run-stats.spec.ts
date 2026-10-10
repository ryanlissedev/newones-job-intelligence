import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type {
  BronRunStatsResult,
  BronRunStatsRow,
} from "@ji/application/registry";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { PostgresBronRunStatsReader } from "./bron-run-stats";
import * as schema from "./schema";
import { aanvraagObservation, bron, scrapeRun, sourceRecord } from "./schema";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
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

/**
 * Fixed clock. Every window is measured back from here, so the fixture's run
 * timestamps stay on the intended side of each boundary no matter when the
 * suite runs.
 */
const NOW = new Date("2026-09-04T12:00:00.000Z");
const minutesAgo = (minutes: number): Date =>
  new Date(NOW.getTime() - minutes * 60 * 1000);
const plusMs = (start: Date, ms: number): Date =>
  new Date(start.getTime() + ms);

/**
 * Source display names must stay unique after bron_naam_lower_uidx (Onbekend
 * audit §4). Stats still key by bron_id so two distinct sources never merge.
 */
const NAAM_A = "RJC407 Bron A";
const NAAM_B = "RJC407 Bron B";

interface Fixture {
  readonly bronIdA: string;
  readonly bronIdB: string;
  readonly bronIdC: string;
  readonly cleanup: () => Promise<void>;
  readonly reader: PostgresBronRunStatsReader;
  readonly runIdA1: string;
}

const seed = async (
  database: PostgresJsDatabase<typeof schema>
): Promise<Fixture> => {
  const bronIdA = crypto.randomUUID();
  const bronIdB = crypto.randomUUID();
  const bronIdC = crypto.randomUUID();

  await database.insert(bron).values([
    {
      categorie: "overheidsportaal",
      id: bronIdA,
      interval: "*/15 * * * *",
      naam: NAAM_A,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    },
    {
      categorie: "overheidsportaal",
      id: bronIdB,
      interval: "0 * * * *",
      naam: NAAM_B,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    },
    {
      categorie: "overheidsportaal",
      id: bronIdC,
      naam: `RJC407 Backfill Bron ${bronIdC.slice(0, 6)}`,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    },
  ]);

  const runIdA1 = crypto.randomUUID();
  const runIdA2 = crypto.randomUUID();
  const runIdA3 = crypto.randomUUID();
  const runIdA4 = crypto.randomUUID();
  const runIdB1 = crypto.randomUUID();
  const runIdC1 = crypto.randomUUID();

  const startA1 = minutesAgo(120);
  const startA2 = minutesAgo(180);
  const startA4 = minutesAgo(7 * 24 * 60 - 120);
  const startB1 = minutesAgo(60);
  const startC1 = minutesAgo(60);

  await database.insert(scrapeRun).values([
    {
      aantalGevonden: 10,
      bronId: bronIdA,
      fouten: 0,
      geindigd: plusMs(startA1, 1000),
      gesloten: 0,
      gestart: startA1,
      gewijzigd: 2,
      id: runIdA1,
      nieuw: 4,
      rejected: 1,
      runKind: "poll",
      status: "succeeded",
    },
    {
      aantalGevonden: 0,
      bronId: bronIdA,
      failureClass: "connector",
      failureCode: "FETCH_FAILED",
      failureMessage: "Connector fetch failed",
      failurePhase: "fetch",
      fouten: 2,
      geindigd: plusMs(startA2, 3000),
      gestart: startA2,
      id: runIdA2,
      runKind: "poll",
      status: "failed",
    },
    // Still running: no `geindigd`, so it must not reach avg/p95.
    {
      bronId: bronIdA,
      gestart: minutesAgo(10),
      id: runIdA3,
      runKind: "poll",
      status: "running",
    },
    // Inside 7d, outside 24u.
    {
      aantalGevonden: 7,
      bronId: bronIdA,
      geindigd: plusMs(startA4, 9000),
      gestart: startA4,
      id: runIdA4,
      nieuw: 7,
      runKind: "poll",
      status: "succeeded",
    },
    {
      aantalGevonden: 5,
      bronId: bronIdB,
      geindigd: plusMs(startB1, 2000),
      gestart: startB1,
      id: runIdB1,
      nieuw: 1,
      runKind: "poll",
      status: "succeeded",
    },
    // Legacy migration import: must stay out of the poll view.
    {
      aantalGevonden: 1000,
      bronId: bronIdC,
      geindigd: plusMs(startC1, 50_000),
      gestart: startC1,
      id: runIdC1,
      nieuw: 900,
      runKind: "backfill",
      status: "succeeded",
    },
  ]);

  // Observations exist only for runA1: 3 unchanged + 2 new. runA2 and runB1
  // get none, which is what proves `ongewijzigd` reports 0 rather than NULL.
  const sourceRecordIds = Array.from({ length: 5 }, () => crypto.randomUUID());
  await database.insert(sourceRecord).values(
    sourceRecordIds.map((id, index) => ({
      bronId: bronIdA,
      bronReferentie: `rjc407-${id}`,
      contentHash: `sha256:rjc407-${index}`,
      id,
      rawPayloadRef: `rjc407/${id}.json`,
      scrapeRunId: runIdA1,
    }))
  );

  await database.insert(aanvraagObservation).values(
    sourceRecordIds.map((sourceRecordId, index) => ({
      bronId: bronIdA,
      contentHash: `sha256:rjc407-obs-${index}`,
      id: crypto.randomUUID(),
      outcome: index < 3 ? "unchanged" : "new",
      payload: { rjc407: true },
      scrapeRunId: runIdA1,
      sourceRecordId,
    }))
  );

  return {
    bronIdA,
    bronIdB,
    bronIdC,
    // Runs, source records and observations all cascade from `curated.bron`,
    // so removing the three seeded sources leaves the database as found.
    cleanup: async () => {
      await database
        .delete(bron)
        .where(inArray(bron.id, [bronIdA, bronIdB, bronIdC]));
    },
    reader: new PostgresBronRunStatsReader(database),
    runIdA1,
  };
};

const rowFor = (
  result: BronRunStatsResult,
  bronId: string
): BronRunStatsRow => {
  const row = result.bronnen.find((candidate) => candidate.bronId === bronId);
  if (row === undefined) {
    throw new Error(`no bron_run_stats row for ${bronId}`);
  }
  return row;
};

describe("PostgresBronRunStatsReader", () => {
  let sqlClient: ReturnType<typeof postgres> | null = null;
  let fixture: Fixture | null = null;

  beforeAll(async () => {
    const available = await isPostgresAvailable();
    if (!available) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    sqlClient = postgres(testDatabaseUrl, { max: 2 });
    fixture = await seed(drizzle(sqlClient, { schema }));
  });

  afterAll(async () => {
    await fixture?.cleanup();
    await sqlClient?.end({ timeout: 5 });
  });

  const stats = async (
    overrides: Partial<
      Parameters<PostgresBronRunStatsReader["bronRunStats"]>[0]
    > = {}
  ): Promise<BronRunStatsResult | null> => {
    if (!fixture) {
      return null;
    }
    return await fixture.reader.bronRunStats({
      bronIds: [fixture.bronIdA, fixture.bronIdB, fixture.bronIdC],
      now: NOW,
      window: "24u",
      ...overrides,
    });
  };

  it("counts runs per bron and rolls them into a totaal row", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    expect(rowFor(result, fixture.bronIdA).runs).toBe(3);
    expect(rowFor(result, fixture.bronIdB).runs).toBe(1);
    expect(result.totaal.runs).toBe(4);
    expect(result.totaal.bronId).toBeNull();
  });

  it("keeps every additive column consistent between the bron rows and totaal", async () => {
    const result = await stats();
    if (!result) {
      expect(fixture).toBeNull();
      return;
    }

    const additive = [
      "aantalGevonden",
      "cancelled",
      "failed",
      "fouten",
      "gesloten",
      "gewijzigd",
      "nieuw",
      "ongewijzigd",
      "rejected",
      "runs",
      "running",
      "succeeded",
    ] as const;

    for (const column of additive) {
      const summed = result.bronnen.reduce(
        (total, row) => total + row[column],
        0
      );
      expect(`${column}=${summed}`).toBe(`${column}=${result.totaal[column]}`);
    }
  });

  it("reads ongewijzigd from observations and reports 0 for runs without them", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    // runA1 carries 3 unchanged observations; runA2 and runA3 carry none.
    expect(rowFor(result, fixture.bronIdA).ongewijzigd).toBe(3);
    expect(rowFor(result, fixture.bronIdB).ongewijzigd).toBe(0);
    expect(result.totaal.ongewijzigd).toBe(3);
  });

  it("does not let observations multiply the run's own volume columns", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    // runA1 has 5 observations. A naive join would report 50 found, not 10.
    expect(rowFor(result, fixture.bronIdA).aantalGevonden).toBe(10);
    expect(rowFor(result, fixture.bronIdA).nieuw).toBe(4);
    expect(rowFor(result, fixture.bronIdA).gewijzigd).toBe(2);
    expect(rowFor(result, fixture.bronIdA).rejected).toBe(1);
  });

  it("ignores running runs in avg and p95 duration", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    const rowA = rowFor(result, fixture.bronIdA);
    // Completed durations are 1000ms and 3000ms; the running run has none.
    expect(rowA.avgDurationMs).toBeCloseTo(2000, 6);
    expect(rowA.p95DurationMs).toBeCloseTo(2900, 6);
    expect(rowA.running).toBe(1);
  });

  it("counts only succeeded as success and excludes running from the denominator", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    // bronA: 1 succeeded, 1 failed, 1 running -> 1/2.
    expect(rowFor(result, fixture.bronIdA).successRate).toBeCloseTo(0.5, 6);
    expect(rowFor(result, fixture.bronIdB).successRate).toBeCloseTo(1, 6);
  });

  it("reports successRate null when nothing finished in the window", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    // bronC only has a backfill run, which the poll view excludes.
    const rowC = rowFor(result, fixture.bronIdC);
    expect(rowC.runs).toBe(0);
    expect(rowC.successRate).toBeNull();
  });

  it("excludes backfill runs from poll stats but exposes them via run_kind", async () => {
    const pollView = await stats();
    const backfillView = await stats({ runKind: "backfill" });
    const allView = await stats({ runKind: "all" });
    if (!(pollView && backfillView && allView && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    expect(rowFor(pollView, fixture.bronIdC).runs).toBe(0);
    expect(pollView.totaal.aantalGevonden).toBe(15);

    expect(rowFor(backfillView, fixture.bronIdC).runs).toBe(1);
    expect(rowFor(backfillView, fixture.bronIdA).runs).toBe(0);

    expect(allView.totaal.runs).toBe(5);
    expect(allView.totaal.aantalGevonden).toBe(1015);
  });

  it("keeps sources with distinct namen keyed by bron_id", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    expect(rowFor(result, fixture.bronIdA).naam).toBe(NAAM_A);
    expect(rowFor(result, fixture.bronIdB).naam).toBe(NAAM_B);
    expect(rowFor(result, fixture.bronIdA).runs).toBe(3);
    expect(rowFor(result, fixture.bronIdB).runs).toBe(1);
  });

  it("rejects a second bron row with the same lower(naam)", async () => {
    if (!sqlClient) {
      expect(sqlClient).toBeNull();
      return;
    }
    const database = drizzle(sqlClient, { schema });
    const duplicateId = crypto.randomUUID();
    let rejection = "";
    try {
      await database.insert(bron).values({
        categorie: "overheidsportaal",
        id: duplicateId,
        naam: NAAM_A.toUpperCase(),
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
    } catch (error) {
      // Drizzle wraps the Postgres error as "Failed query: …"; constraint /
      // SQLSTATE live on Error.cause.
      const chunks: string[] = [];
      let current: Error | undefined =
        error instanceof Error ? error : undefined;
      for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
        chunks.push(current.message);
        current = current.cause instanceof Error ? current.cause : undefined;
      }
      rejection = chunks.join("\n");
    }
    expect(rejection).toMatch(
      /bron_naam_lower_uidx|unique|duplicate key|23505/iu
    );
  });

  it("scopes each window rather than reporting lifetime totals", async () => {
    const day = await stats({ window: "24u" });
    const week = await stats({ window: "7d" });
    const month = await stats({ window: "30d" });
    if (!(day && week && month && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    // runA4 started 5 days ago: outside 24u, inside 7d and 30d.
    expect(rowFor(day, fixture.bronIdA).runs).toBe(3);
    expect(rowFor(week, fixture.bronIdA).runs).toBe(4);
    expect(rowFor(month, fixture.bronIdA).runs).toBe(4);
    expect(day.since.getTime()).toBeGreaterThan(week.since.getTime());
  });

  it("surfaces the most recent failure envelope, not a free-text error list", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    const rowA = rowFor(result, fixture.bronIdA);
    expect(rowA.lastFailurePhase).toBe("fetch");
    expect(rowA.lastFailureClass).toBe("connector");
    expect(rowA.lastFailureCode).toBe("FETCH_FAILED");
    expect(rowA.lastFailureMessage).toBe("Connector fetch failed");
    // The newest run is `running`; the failure reason must survive it.
    expect(rowA.lastRunStatus).toBe("running");
    expect(rowA.topFailures).toEqual([{ code: "FETCH_FAILED", count: 1 }]);
  });

  it("carries the register metadata each card needs", async () => {
    const result = await stats();
    if (!(result && fixture)) {
      expect(fixture).toBeNull();
      return;
    }

    const rowA = rowFor(result, fixture.bronIdA);
    expect(rowA.naam).toBe(NAAM_A);
    expect(rowA.interval).toBe("*/15 * * * *");
    expect(rowA.actief).toBe(false);
    expect(rowA.lastRunAt).toBeInstanceOf(Date);
  });

  it("buckets the timeseries per bron with unchanged from observations", async () => {
    const seeded = fixture;
    if (!seeded) {
      expect(fixture).toBeNull();
      return;
    }

    const points = await seeded.reader.bronRunTimeseries({
      bronIds: [seeded.bronIdA, seeded.bronIdB, seeded.bronIdC],
      now: NOW,
      window: "24u",
    });

    const forA = points.filter((point) => point.bronId === seeded.bronIdA);
    expect(forA.length).toBeGreaterThan(0);
    expect(forA.reduce((total, point) => total + point.runs, 0)).toBe(3);
    expect(forA.reduce((total, point) => total + point.ongewijzigd, 0)).toBe(3);
    // Backfill stays out of the default poll view here too.
    expect(points.some((point) => point.bronId === seeded.bronIdC)).toBe(false);
  });

  it("supports hour buckets for the 24u window", async () => {
    const seeded = fixture;
    if (!seeded) {
      expect(fixture).toBeNull();
      return;
    }

    const points = await seeded.reader.bronRunTimeseries({
      bronIds: [seeded.bronIdA],
      bucket: "hour",
      now: NOW,
      window: "24u",
    });

    // Three runs at 10, 120 and 180 minutes ago land in three distinct hours.
    expect(new Set(points.map((point) => point.bucket.getTime())).size).toBe(3);
  });
});
