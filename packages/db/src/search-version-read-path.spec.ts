import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "./schema";
import { PostgresSearchVersionStore } from "./search-version-store";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

const WRITE_STATEMENT = /^\s*(?:insert|update|delete)/iu;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {
      // Probe teardown failures are irrelevant to availability.
    });
    return false;
  }
};

/**
 * `SearchAdapter.search()` reads this checkpoint before it can build a cache
 * key, so every statement `read()` issues sits on the search read path — a
 * Neon round trip per query in production. These tests pin the statement
 * count so a helpful-looking `await ensureCheckpoint()` cannot quietly put a
 * write back in front of every search.
 */
describe("search version read path cost", () => {
  let postgresAvailable = false;
  let sqlClient: ReturnType<typeof postgres> | undefined;
  let database: ReturnType<typeof drizzle<typeof schema>> | undefined;
  const statements: string[] = [];

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }

    sqlClient = postgres(testDatabaseUrl, {
      debug: (_connection, query) => {
        statements.push(query);
      },
      max: 5,
    });
    database = drizzle(sqlClient, { schema });
    await migrate(database, { migrationsFolder });
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  const recorded = <T>(run: () => Promise<T>): Promise<T> => {
    statements.length = 0;
    return run();
  };

  /** Only checkpoint traffic; the pool issues its own connection setup. */
  const checkpointStatements = (): string[] =>
    statements.filter((statement) =>
      statement.includes("search_projection_checkpoint")
    );

  const writes = (): string[] =>
    checkpointStatements().filter((statement) =>
      WRITE_STATEMENT.test(statement)
    );

  it("bootstraps the checkpoint once, then reads without writing", async () => {
    if (!(postgresAvailable && database)) {
      return;
    }
    const store = new PostgresSearchVersionStore(database, {
      indexName: `read-path-${crypto.randomUUID()}`,
    });

    await recorded(() => store.read());
    expect(writes()).toHaveLength(1);

    await recorded(() => store.read());
    expect(writes()).toHaveLength(0);
    expect(checkpointStatements()).toHaveLength(1);

    await recorded(() => store.read());
    expect(checkpointStatements()).toHaveLength(1);
  });

  it("does not re-issue the bootstrap insert per concurrent read", async () => {
    if (!(postgresAvailable && database)) {
      return;
    }
    const store = new PostgresSearchVersionStore(database, {
      indexName: `read-path-${crypto.randomUUID()}`,
    });
    await store.read();

    await recorded(() =>
      Promise.all([store.read(), store.read(), store.read(), store.read()])
    );

    expect(writes()).toHaveLength(0);
    expect(checkpointStatements()).toHaveLength(4);
  });

  it("retries the bootstrap when it failed, rather than caching the failure", async () => {
    if (!(postgresAvailable && database)) {
      return;
    }
    const indexName = `read-path-${crypto.randomUUID()}`;
    const failing = postgres(
      "postgresql://ji_app:wrong-password@127.0.0.1:1/x",
      {
        connect_timeout: 1,
        max: 1,
      }
    );
    const store = new PostgresSearchVersionStore(drizzle(failing, { schema }), {
      indexName,
    });

    await expect(store.read()).rejects.toThrow();
    // A memoised failure would resolve here instead of attempting again.
    await expect(store.read()).rejects.toThrow();

    await failing.end({ timeout: 1 }).catch(() => {
      // Teardown of an intentionally broken client.
    });
  });
});
