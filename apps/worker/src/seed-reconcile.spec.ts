import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { reconcileSourceSeeds, SOURCES } from "@ji/application/sources";
import type { BronRuntimeDatabase } from "@ji/db";
import {
  readBronSeedRows,
  withReadOnlyTransaction,
} from "@ji/db/bron-seed-rows";
import { bron } from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { logSeedDriftAtBoot, reportSeedDrift } from "./seed-reconcile";
import { buildSliceABronSeedValues } from "./smoke-seed";

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

const captureStream = () => {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write: (chunk: string) => {
        lines.push(chunk);
        return true;
      },
    },
  };
};

describe("logSeedDriftAtBoot", () => {
  it("logs a failure line and never throws when the read fails", async () => {
    const { lines, stream } = captureStream();
    await logSeedDriftAtBoot(
      () => Promise.reject(new Error("connection refused")),
      stream
    );
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: "bron_seed_drift_check_failed",
        message: "connection refused",
      },
    ]);
  });
});

describe
  .skipIf(!postgresAvailable)
  .serial("bron seed reconcile against Postgres", () => {
    let database: BronRuntimeDatabase;
    let sqlClient: ReturnType<typeof postgres> | null = null;
    const insertedIds: string[] = [];

    beforeAll(() => {
      sqlClient = postgres(applicationUrl, { max: 2 });
      database = drizzle(sqlClient, { schema });
    });

    afterAll(async () => {
      if (insertedIds.length > 0) {
        await database.delete(bron).where(inArray(bron.id, insertedIds));
      }
      await sqlClient?.end({ timeout: 5 });
    });

    it("reports a reviewed toegestaan row against a te_toetsen seed and leaves every row untouched", async () => {
      // SAFETY: random UUIDs satisfy the BronId shape and keep this DB test isolated.
      const reviewedId = crypto.randomUUID() as typeof SOURCES.eneco.bronId;
      // SAFETY: random UUIDs satisfy the BronId shape and keep this DB test isolated.
      const missingId = crypto.randomUUID() as typeof SOURCES.alliander.bronId;
      // SAFETY: random UUIDs satisfy the BronId shape and keep this DB test isolated.
      const extraId = crypto.randomUUID() as typeof SOURCES.hero.bronId;
      // A unique naam keeps the row clear of bron_naam_lower_uidx in a shared test DB.
      const reviewed = {
        ...SOURCES.eneco,
        bronId: reviewedId,
        naam: `Eneco ${reviewedId}`,
      };
      const missing = { ...SOURCES.alliander, bronId: missingId };
      expect(reviewed.seed.voorwaardenStatus).toBe("te_toetsen");

      await database.insert(bron).values([
        {
          ...buildSliceABronSeedValues(reviewed),
          actief: true,
          status: "ready",
          voorwaardenStatus: "toegestaan",
        },
        {
          ...buildSliceABronSeedValues({ ...SOURCES.hero, bronId: extraId }),
          naam: `Feed bron ${extraId}`,
        },
      ]);
      insertedIds.push(reviewedId, extraId);

      const snapshot = () =>
        database
          .select()
          .from(bron)
          .where(inArray(bron.id, insertedIds))
          .orderBy(bron.id);
      const before = await snapshot();

      const allRows = await readBronSeedRows(database);
      const rows = allRows.filter((row) => insertedIds.includes(row.id));
      const report = reconcileSourceSeeds([reviewed, missing], rows);

      expect(report.voorwaardenDrift).toEqual([
        {
          bronId: reviewedId,
          code: "te_toetsen",
          db: "toegestaan",
          slug: "eneco",
        },
      ]);
      expect(report.missingRows.map((row) => row.bronId)).toEqual([missingId]);
      expect(report.unknownRows.map((row) => row.bronId)).toEqual([extraId]);
      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it("runs the read in a READ ONLY transaction, so Postgres refuses any write", async () => {
      const outcome = await withReadOnlyTransaction(database, async (tx) => {
        const settings = await tx.execute<{ transaction_read_only: string }>(
          sql`SHOW transaction_read_only`
        );
        let writeError = "";
        try {
          // A nested transaction is a savepoint, so the failed write leaves the outer read usable.
          await tx.transaction(async (probe) => {
            await probe.execute(
              sql`UPDATE curated.bron SET actief = false WHERE false`
            );
          });
        } catch (error) {
          // Drizzle wraps the Postgres error; its cause carries SQLSTATE 25006.
          writeError =
            error instanceof Error
              ? `${error.message} ${String(error.cause)}`
              : String(error);
        }
        return { readOnly: settings[0]?.transaction_read_only, writeError };
      });
      expect(outcome.readOnly).toBe("on");
      expect(outcome.writeError).toContain("read-only transaction");
    });

    it("logs one boot line with the registry size", async () => {
      const { lines, stream } = captureStream();
      await logSeedDriftAtBoot(() => reportSeedDrift(database), stream);
      expect(lines).toHaveLength(1);
      const [line] = lines.map((entry) => JSON.parse(entry));
      expect(["bron_seed_drift", "bron_seed_in_sync"]).toContain(line.event);
      expect(line.codeSources).toBe(Object.keys(SOURCES).length);
    });
  });
