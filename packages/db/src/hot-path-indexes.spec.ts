import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
const concurrentlyScript = path.join(
  import.meta.dir,
  "../../../tools/postgres/indexes/0031-hot-path-indexes-concurrently.sql"
);

const HOT_PATH_INDEXES = [
  "outbox_event_processed_at_idx",
  "aanvraag_observation_bron_status_created_idx",
  "aanvraag_bron_status_idx",
  "aanvraag_dedup_groep_bron_idx",
  "scrape_run_bron_gestart_idx",
] as const;

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

const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

/** Splits the operator script into statements the way psql would run them, one per autocommit. */
const scriptStatements = (script: string): string[] =>
  script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

describe
  .skipIf(!postgresAvailable)
  .serial("hot path indexes (migration 0031)", () => {
    let client: ReturnType<typeof postgres>;

    beforeAll(async () => {
      client = postgres(migratorUrl, { max: 1, onnotice: () => {} });
      await migrate(drizzle(client), { migrationsFolder });
    });

    afterAll(async () => {
      await client.end({ timeout: 5 });
    });

    it("creates every index, valid and additive", async () => {
      const rows = await client<{ indexname: string; valid: boolean }[]>`
        SELECT c.relname AS indexname, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN ${client(HOT_PATH_INDEXES)}
        ORDER BY c.relname`;
      expect(rows.map((row) => row.indexname)).toEqual(
        [...HOT_PATH_INDEXES].toSorted()
      );
      expect(rows.every((row) => row.valid)).toBe(true);
    });

    it("lets the outbox prune use a range scan on processed_at instead of a full scan", async () => {
      const plan = await client.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        const lines = await tx.unsafe<{ "QUERY PLAN": string }[]>(`
          EXPLAIN DELETE FROM curated.outbox_event
          WHERE id IN (
            SELECT id FROM curated.outbox_event
            WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days'
            LIMIT 500
          )`);
        return lines.map((line) => line["QUERY PLAN"]).join("\n");
      });
      expect(plan).toContain("outbox_event_processed_at_idx");
    });

    it("keeps the operator CONCURRENTLY script runnable statement by statement, as a no-op once 0031 is applied", async () => {
      const statements = scriptStatements(
        await readFile(concurrentlyScript, "utf-8")
      );
      expect(
        statements.filter((statement) =>
          statement.startsWith("CREATE INDEX CONCURRENTLY IF NOT EXISTS")
        )
      ).toHaveLength(HOT_PATH_INDEXES.length);
      expect(statements[2]).toContain("outbox_event_processed_at_idx");
      let invalid: unknown[] = [];
      for (const statement of statements) {
        // oxlint-disable-next-line no-await-in-loop -- psql runs them in order, one autocommit each
        invalid = await client.unsafe(statement);
      }
      // The last statement is the invalid-index check; it must be empty.
      expect(invalid).toEqual([]);
    });
  });
