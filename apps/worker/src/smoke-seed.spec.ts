import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { SOURCES } from "@ji/application/sources";
import type { BronRuntimeDatabase } from "@ji/db";
import { bron } from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  buildSliceABronSeedValues,
  ensureMissingSliceABronnen,
} from "./smoke-seed";

const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
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

describe("Slice A smoke seed defaults", () => {
  it("leaves sources whose terms need review deferred on a fresh seed", () => {
    expect(buildSliceABronSeedValues(SOURCES.linkedin)).toMatchObject({
      status: "deferred",
      voorwaardenStatus: "te_toetsen",
    });
    expect(buildSliceABronSeedValues(SOURCES.tenderned)).toMatchObject({
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
  });
});

describe.skipIf(!postgresAvailable).serial("Slice A smoke seeding", () => {
  let database: BronRuntimeDatabase;
  let sqlClient: ReturnType<typeof postgres> | null = null;

  beforeAll(() => {
    sqlClient = postgres(applicationUrl, { max: 2 });
    database = drizzle(sqlClient, { schema });
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  it("keeps an approved operator row and inserts missing registry defaults", async () => {
    // SAFETY: random UUIDs satisfy the BronId shape and keep this DB test isolated.
    const heroId = `${crypto.randomUUID()}` as typeof SOURCES.hero.bronId;
    // SAFETY: random UUIDs satisfy the BronId shape and keep this DB test isolated.
    const ctmId = `${crypto.randomUUID()}` as typeof SOURCES.ctm.bronId;
    const hero = { ...SOURCES.hero, bronId: heroId };
    const ctm = { ...SOURCES.ctm, bronId: ctmId };
    const heroSeed = buildSliceABronSeedValues(hero);
    const ctmSeed = buildSliceABronSeedValues(ctm);

    await database.insert(bron).values({
      ...heroSeed,
      actief: true,
      crawlDelayMs: 7500,
      interval: "0 4 * * *",
      rateLimitPerMinute: 12,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });

    try {
      await ensureMissingSliceABronnen(database, [hero, ctm]);
      const rows = await database
        .select()
        .from(bron)
        .where(inArray(bron.id, [heroId, ctmId]));
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(heroId)).toMatchObject({
        actief: true,
        crawlDelayMs: 7500,
        interval: "0 4 * * *",
        rateLimitPerMinute: 12,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      expect(byId.get(ctmId)).toMatchObject(ctmSeed);
    } finally {
      await database.delete(bron).where(eq(bron.id, heroId));
      await database.delete(bron).where(eq(bron.id, ctmId));
    }
  });
});
