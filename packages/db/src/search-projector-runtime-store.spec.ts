import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "./schema";
import { searchProjectorRuntime } from "./schema";
import { PostgresSearchProjectorRuntimeStore } from "./search-projector-runtime-store";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";

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

const uniqueIndexName = (): string => `test-index-${crypto.randomUUID()}`;

describe("projector runtime store", () => {
  let postgresAvailable = false;
  let sqlClient: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

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
    await sqlClient?.end({ timeout: 5 });
  });

  it("reads null before the projector has ever reported", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const store = new PostgresSearchProjectorRuntimeStore(db, {
      indexName: uniqueIndexName(),
    });

    expect(await store.read()).toBeNull();
  });

  it("round trips every field the deploy readback consumes", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const indexName = uniqueIndexName();
    const startedAt = new Date("2026-09-11T08:00:00.000Z");
    const heartbeatAt = new Date("2026-09-11T08:05:30.000Z");
    const store = new PostgresSearchProjectorRuntimeStore(db, { indexName });

    await store.record({
      containerId: "container-abc123",
      cycle: 17,
      heartbeatAt,
      releaseSha: RELEASE_SHA,
      startedAt,
    });

    expect(await store.read()).toEqual({
      containerId: "container-abc123",
      cycle: 17,
      heartbeatAt,
      indexName,
      releaseSha: RELEASE_SHA,
      startedAt,
      // record() sets updatedAt to the heartbeat it just wrote.
      updatedAt: heartbeatAt,
    });
  });

  it("lets a new container overwrite the single row for the index", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const indexName = uniqueIndexName();
    const store = new PostgresSearchProjectorRuntimeStore(db, { indexName });
    await store.record({
      containerId: "container-old",
      cycle: 41,
      heartbeatAt: new Date("2026-09-11T08:00:00.000Z"),
      releaseSha: RELEASE_SHA,
      startedAt: new Date("2026-09-11T07:00:00.000Z"),
    });

    const nextStartedAt = new Date("2026-09-11T09:00:00.000Z");
    const nextHeartbeatAt = new Date("2026-09-11T09:00:10.000Z");
    await store.record({
      containerId: "container-new",
      cycle: 1,
      heartbeatAt: nextHeartbeatAt,
      releaseSha: RELEASE_SHA,
      startedAt: nextStartedAt,
    });

    expect(await store.read()).toEqual({
      containerId: "container-new",
      cycle: 1,
      heartbeatAt: nextHeartbeatAt,
      indexName,
      releaseSha: RELEASE_SHA,
      startedAt: nextStartedAt,
      updatedAt: nextHeartbeatAt,
    });

    const rows = await db
      .select()
      .from(searchProjectorRuntime)
      .where(eq(searchProjectorRuntime.indexName, indexName));
    expect(rows).toHaveLength(1);
  });

  it("stores a missing release SHA as null rather than a placeholder", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const indexName = uniqueIndexName();
    const store = new PostgresSearchProjectorRuntimeStore(db, { indexName });
    await store.record({
      containerId: "container-no-sha",
      cycle: 3,
      heartbeatAt: new Date("2026-09-11T10:00:00.000Z"),
      releaseSha: null,
      startedAt: new Date("2026-09-11T09:59:00.000Z"),
    });

    const stored = await store.read();
    expect(stored?.releaseSha).toBeNull();
  });
});
