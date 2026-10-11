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
  "../../../tools/postgres/indexes/0035-aanvraag-observation-source-record-hash-concurrently.sql"
);
const INDEX_NAME = "aanvraag_observation_source_record_hash_idx";

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
  .serial("dominated sweep index (migration 0035)", () => {
    let client: ReturnType<typeof postgres>;

    beforeAll(async () => {
      client = postgres(migratorUrl, { max: 1, onnotice: () => {} });
      await migrate(drizzle(client), { migrationsFolder });
    });

    afterAll(async () => {
      await client.end({ timeout: 5 });
    });

    it("creates the index valid, on (source_record_id, content_hash)", async () => {
      const rows = await client<{ definition: string; valid: boolean }[]>`
        SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ${INDEX_NAME}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.valid).toBe(true);
      expect(rows[0]?.definition).toContain(
        "ON staging.aanvraag_observation USING btree (source_record_id, content_hash)"
      );
    });

    it("serves the same-content sibling probe", async () => {
      // With few rows the planner may pick the older single-column
      // source_record_id index at equal cost (seen in the full gate, where
      // earlier specs leave rows behind). Take that index out of the running
      // inside a transaction that is always rolled back, so the assertion is
      // about this index serving the probe on both columns.
      const reserved = await client.reserve();
      let plan = "";
      try {
        await reserved`BEGIN`;
        await reserved`SET LOCAL enable_seqscan = off`;
        await reserved`DROP INDEX staging.aanvraag_observation_source_record_id_idx`;
        const lines = await reserved.unsafe<{ "QUERY PLAN": string }[]>(`
          EXPLAIN SELECT id FROM staging.aanvraag_observation
          WHERE source_record_id = '00000000-0000-4000-8000-000000000000'
            AND content_hash = 'probe'`);
        plan = lines.map((line) => line["QUERY PLAN"]).join("\n");
      } finally {
        await reserved`ROLLBACK`;
        reserved.release();
      }
      expect(plan).toContain(INDEX_NAME);
      expect(plan).toContain("content_hash");
    });

    it("keeps the operator CONCURRENTLY script runnable statement by statement, as a no-op once 0035 is applied", async () => {
      const statements = scriptStatements(
        await readFile(concurrentlyScript, "utf-8")
      );
      expect(statements[0]).toBe("SET lock_timeout = '5s'");
      expect(
        statements.filter((statement) =>
          statement.startsWith("CREATE INDEX CONCURRENTLY IF NOT EXISTS")
        )
      ).toHaveLength(1);
      let invalid: unknown[] = [];
      for (const statement of statements) {
        // oxlint-disable-next-line no-await-in-loop -- psql runs them in order, one autocommit each
        invalid = await client.unsafe(statement);
      }
      // The last statement is the invalid-index check; it must be empty.
      expect(invalid).toEqual([]);
    });
  });
