/**
 * RJC-369: guard against the shared `ji_test` database silently
 * accumulating residue again.
 *
 * Isolation (tools/postgres/test-isolation.ts) means no spec should ever
 * write to the shared `ji_test` database again — every DB spec now runs
 * against a fresh per-process database. This spec is the tripwire for that
 * invariant: it connects directly to the literal shared `ji_test` database
 * using the admin role (deliberately ignoring `DATABASE_TEST_URL`, which the
 * isolation preload has already repointed at the isolated database — this
 * guard must always look at the real shared database, not wherever other
 * specs currently run), and fails if it finds rows matching the residue
 * patterns discovered while investigating RJC-369:
 *   - curated.search_projection_checkpoint rows with an index_name of
 *     `test-index-*` (packages/db/src/search-version-store.spec.ts) or
 *     `drain-*` (packages/db/src/outbox-drain.spec.ts).
 *   - staging.source_record rows belonging to a curated.bron row whose
 *     categorie is the test-only marker `runtime-test`
 *     (packages/db/src/bron-runtime.spec.ts).
 *
 * This does not claim to catch every possible test fixture shape that could
 * leak into the shared database (bron fixtures also reuse real-looking
 * categorie values like "overheidsportaal" or "jobboard" with no fixture
 * marker — see docs/runbooks/postgres-test-isolation.md for that gap). It
 * catches the two patterns actually found accumulating in `ji_test`
 * (2,633 / 1,239 rows respectively as of 2026-09-01) and any regression
 * that reintroduces them.
 *
 * On a fresh CI runner `ji_test` is created by the container init script
 * with roles but no schema (isolation now runs the real migrations against
 * the per-process database instead) — its tables genuinely do not exist.
 * A missing table trivially holds no residue, so each check confirms the
 * table exists (`to_regclass`) before counting, and treats "does not
 * exist" as a pass. It must NOT swallow every error this way: a real query
 * failure (permission denied, connection dropped) still throws and fails
 * the test — only a confirmed-absent table short-circuits to a pass.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import postgres from "postgres";

const adminUser = process.env.POSTGRES_ADMIN_USER ?? "ji_admin";
const adminPassword = process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local";
const hostPort = Number(process.env.POSTGRES_HOST_PORT ?? "5432");
// Deliberately hardcoded, not process.env.DATABASE_TEST_URL: this guard
// must always check the shared database regardless of where isolated test
// runs currently point.
const sharedDatabaseName = process.env.POSTGRES_DB ?? "ji_test";

const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_ADMIN_TEST_URL !== undefined;

const isPostgresAvailable = async (
  client: ReturnType<typeof postgres>
): Promise<boolean> => {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
};

// Table existence, not table content: to_regclass returns NULL for a
// relation that doesn't exist and never throws, so this is a real
// existence check, not an error-swallowing try/catch.
const tableExists = async (
  client: ReturnType<typeof postgres>,
  qualifiedName: string
): Promise<boolean> => {
  const [row] = await client`SELECT to_regclass(${qualifiedName}) AS relation`;
  return row?.relation !== null;
};

describe("shared ji_test residue guard", () => {
  let postgresAvailable = false;
  let client: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    client = postgres({
      connect_timeout: 3,
      database: sharedDatabaseName,
      host: "127.0.0.1",
      max: 1,
      password: adminPassword,
      port: hostPort,
      username: adminUser,
    });
    postgresAvailable = await isPostgresAvailable(client);
    if (!postgresAvailable && databaseRequired) {
      throw new Error("Required shared test database is unavailable");
    }
  });

  afterAll(async () => {
    await client?.end({ timeout: 3 });
  });

  it("has no leftover search_projection_checkpoint rows from test/drain fixtures", async () => {
    if (!postgresAvailable || !client) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    if (!(await tableExists(client, "curated.search_projection_checkpoint"))) {
      // Not migrated yet (fresh CI runner) -- no table means no residue.
      expect(true).toBe(true);
      return;
    }

    const [row] = await client`
      SELECT count(*)::int AS residue_count
      FROM curated.search_projection_checkpoint
      WHERE index_name LIKE 'test-index-%' OR index_name LIKE 'drain-%'
    `;

    expect(row?.residue_count).toBe(0);
  });

  it("has no leftover source_record rows from runtime-test bron fixtures", async () => {
    if (!postgresAvailable || !client) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const [sourceRecordExists, bronExists] = await Promise.all([
      tableExists(client, "staging.source_record"),
      tableExists(client, "curated.bron"),
    ]);
    if (!(sourceRecordExists && bronExists)) {
      // Not migrated yet (fresh CI runner) -- no tables means no residue.
      expect(true).toBe(true);
      return;
    }

    const [row] = await client`
      SELECT count(*)::int AS residue_count
      FROM staging.source_record AS source_record
      JOIN curated.bron AS bron ON bron.id = source_record.bron_id
      WHERE bron.categorie = 'runtime-test'
    `;

    expect(row?.residue_count).toBe(0);
  });
});
