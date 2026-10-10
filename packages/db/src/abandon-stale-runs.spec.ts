import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { abandonStaleRuns } from "./abandon-stale-runs";
import * as schema from "./schema";
import { bron, scrapeRun } from "./schema";

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

/** Fixed clock: every row sits on the intended side of the cutoff. */
const NOW = new Date("2026-09-12T12:00:00.000Z");
const OLDER_THAN_MS = 6 * 60 * 60 * 1000;
const hoursAgo = (hours: number): Date =>
  new Date(NOW.getTime() - hours * 60 * 60 * 1000);

interface Fixture {
  readonly bronId: string;
  readonly cleanup: () => Promise<void>;
  readonly database: PostgresJsDatabase<typeof schema>;
  readonly freshRunId: string;
  readonly staleRunId: string;
  readonly succeededRunId: string;
}

const seed = async (
  database: PostgresJsDatabase<typeof schema>
): Promise<Fixture> => {
  const bronId = crypto.randomUUID();
  await database.insert(bron).values({
    categorie: "overheidsportaal",
    id: bronId,
    interval: "*/15 * * * *",
    naam: `CTP490 Bron ${bronId.slice(0, 8)}`,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  });

  const staleRunId = crypto.randomUUID();
  const freshRunId = crypto.randomUUID();
  const succeededRunId = crypto.randomUUID();
  const succeededStart = hoursAgo(9);

  await database.insert(scrapeRun).values([
    // Died mid-flight nine hours ago: the row CTP-490 had to repair by hand.
    {
      bronId,
      gestart: hoursAgo(9),
      id: staleRunId,
      runKind: "poll",
      status: "running",
    },
    // Running for an hour: a healthy long poll, must survive untouched.
    {
      bronId,
      gestart: hoursAgo(1),
      id: freshRunId,
      runKind: "poll",
      status: "running",
    },
    // Old but closed: the cutoff must not reopen finished history.
    {
      aantalGevonden: 3,
      bronId,
      geindigd: new Date(succeededStart.getTime() + 4000),
      gestart: succeededStart,
      id: succeededRunId,
      nieuw: 3,
      runKind: "poll",
      status: "succeeded",
    },
  ]);

  return {
    bronId,
    // Runs cascade from curated.bron, so one delete leaves the lane as found.
    cleanup: async () => {
      await database.delete(bron).where(eq(bron.id, bronId));
    },
    database,
    freshRunId,
    staleRunId,
    succeededRunId,
  };
};

const runsById = async (seeded: Fixture) => {
  const rows = await seeded.database
    .select()
    .from(scrapeRun)
    .where(
      inArray(scrapeRun.id, [
        seeded.staleRunId,
        seeded.freshRunId,
        seeded.succeededRunId,
      ])
    );
  return new Map(rows.map((row) => [row.id, row]));
};

describe("abandonStaleRuns", () => {
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

  it("fails a stale running run with the unknown-failure tuple", async () => {
    const seeded = fixture;
    if (!seeded) {
      expect(fixture).toBeNull();
      return;
    }

    const abandoned = await abandonStaleRuns(seeded.database, {
      now: NOW,
      olderThanMs: OLDER_THAN_MS,
    });
    expect(abandoned).toContain(seeded.staleRunId);

    const rows = await runsById(seeded);
    const stale = rows.get(seeded.staleRunId);
    expect(stale?.status).toBe("failed");
    expect(stale?.failurePhase).toBe("unknown");
    expect(stale?.failureClass).toBe("internal");
    expect(stale?.failureCode).toBe("UNEXPECTED_FAILURE");
    expect(stale?.failureMessage).toBe("Connector run failed");
    expect(stale?.geindigd?.toISOString()).toBe(NOW.toISOString());
    expect(stale?.fenceToken).toBe(1);
  });

  it("leaves a run that is still inside the threshold running", async () => {
    const seeded = fixture;
    if (!seeded) {
      expect(fixture).toBeNull();
      return;
    }

    const abandoned = await abandonStaleRuns(seeded.database, {
      now: NOW,
      olderThanMs: OLDER_THAN_MS,
    });
    expect(abandoned).not.toContain(seeded.freshRunId);

    const rows = await runsById(seeded);
    const fresh = rows.get(seeded.freshRunId);
    expect(fresh?.status).toBe("running");
    expect(fresh?.geindigd).toBeNull();
    expect(fresh?.failureCode).toBeNull();
  });

  it("leaves an old succeeded run untouched", async () => {
    const seeded = fixture;
    if (!seeded) {
      expect(fixture).toBeNull();
      return;
    }

    const abandoned = await abandonStaleRuns(seeded.database, {
      now: NOW,
      olderThanMs: OLDER_THAN_MS,
    });
    expect(abandoned).not.toContain(seeded.succeededRunId);

    const rows = await runsById(seeded);
    const succeeded = rows.get(seeded.succeededRunId);
    expect(succeeded?.status).toBe("succeeded");
    expect(succeeded?.failureCode).toBeNull();
  });

  it("returns nothing on a second pass, so the count is real work", async () => {
    const seeded = fixture;
    if (!seeded) {
      expect(fixture).toBeNull();
      return;
    }

    await abandonStaleRuns(seeded.database, {
      now: NOW,
      olderThanMs: OLDER_THAN_MS,
    });
    const second = await abandonStaleRuns(seeded.database, {
      now: NOW,
      olderThanMs: OLDER_THAN_MS,
    });

    expect(second).not.toContain(seeded.staleRunId);
  });
});
