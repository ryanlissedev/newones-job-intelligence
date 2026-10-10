/**
 * RJC-369: give every `bun test` run its own Postgres database instead of
 * letting every DB spec share the long-lived `ji_test` database.
 *
 * This module is loaded once via `bunfig.toml`'s `[test].preload` — Bun runs
 * a preloaded module's top-level code (including top-level `await`) before
 * any test file, and treats a `beforeAll`/`afterAll` registered outside a
 * `describe` block as GLOBAL: they run exactly once, before the first test
 * file and after the last, no matter how many spec files match. That is the
 * mechanism this file relies on (verified empirically before relying on it:
 * a two-file smoke test showed the preload's beforeAll firing before file
 * one's first test and its afterAll firing after file two's last test).
 *
 * What it does:
 *   1. If `DATABASE_TEST_URL` is already set in the environment, do nothing
 *      — the caller (crabbox-exe-dev-shadow.sh, a developer pointing tests
 *      somewhere specific) has taken responsibility for that database.
 *   2. Otherwise, probe the admin Postgres connection. If it's completely
 *      unreachable: do nothing when `REQUIRE_DATABASE_TESTS` isn't "1" (the
 *      individual specs already skip gracefully in that case); throw when
 *      it is "1" (never silently fall back to a shared database — that is
 *      exactly the failure mode RJC-395 fixed for the migration-upgrade
 *      suite, and this module owes the same guarantee to every other DB
 *      spec).
 *   3. When Postgres is reachable, create a fresh `ji_test_iso_<pid>_<rand>`
 *      database, re-run the same least-privilege role grants
 *      `tools/postgres/init/10-bootstrap-roles.sh` applies at container
 *      init (CREATE DATABASE does not copy per-database GRANTs), run the
 *      Drizzle migrations against it as the migrator role, and point
 *      `DATABASE_TEST_URL` / `DATABASE_APP_TEST_URL` / `DATABASE_ADMIN_TEST_URL`
 *      at it. Every spec's existing
 *      `process.env.DATABASE_TEST_URL ?? "<shared ji_test URL>"` fallback
 *      then picks up the isolated database with no per-spec changes.
 *   4. The global `afterAll` drops the isolated database (`WITH (FORCE)` —
 *      Postgres 13+ — to terminate any lingering pooled connections first).
 *
 * One database per test PROCESS, not per suite or per file: `bun test` (as
 * invoked by `tools/quality/gate.sh` and every developer's `bun test`) runs
 * every file in a single process, so this is the natural boundary, and two
 * concurrent `bun test` invocations get two different process ids and so
 * two different isolated databases — the collision this ticket exists to
 * fix. Per-suite/per-file databases were considered and rejected: the
 * `migrate()` cost (12 migrations) is real (measured below in the PR
 * description) and paying it once per process is far cheaper than paying it
 * ~10+ times per run for zero additional isolation benefit within a single
 * `bun test` invocation.
 */
import { afterAll } from "bun:test";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { requireMigrationUpgradeDatabaseUrl } from "../../packages/db/src/migration-upgrade-guard";

// This preload runs before every test file. Validate an explicitly supplied
// migration-upgrade target before this module creates even its admin probe
// client, including when the caller selects only one sibling suite.
requireMigrationUpgradeDatabaseUrl(process.env.DATABASE_UPGRADE_TEST_URL);

const ROLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

const adminUser = process.env.POSTGRES_ADMIN_USER ?? "ji_admin";
const adminPassword = process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local";
const migratorUser = process.env.POSTGRES_MIGRATOR_USER ?? "ji_migrator";
const migratorPassword =
  process.env.POSTGRES_MIGRATOR_PASSWORD ?? "ji_migrator_local";
const appUser = process.env.POSTGRES_APP_USER ?? "ji_app";
const appPassword = process.env.POSTGRES_APP_PASSWORD ?? "ji_app_local";
const hostPort = Number(process.env.POSTGRES_HOST_PORT ?? "5432");

const migrationsFolder = path.join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "db",
  "src",
  "migrations"
);

const databaseUrl = (
  username: string,
  password: string,
  database: string
): string => {
  const url = new URL(`postgresql://127.0.0.1:${hostPort}/${database}`);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url.toString();
};

const requireRoleName = (name: string, label: string): void => {
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new Error(
      `test-isolation: ${label} '${name}' is not a valid role name`
    );
  }
};

// UNREACHABLE_ERROR_CODES mirrors tools/postgres/ensure-migration-upgrade-db.ts:
// only "the server itself can't be reached" may become a silent no-op when
// REQUIRE_DATABASE_TESTS isn't set. Anything else (auth, permissions, a
// malformed database) is a real problem and must fail loudly.
const UNREACHABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
]);

let isolatedDatabaseName: string | undefined;

// Identifiers below are plain double-quoted string interpolation, matching
// the precedent in tools/postgres/ensure-migration-upgrade-db.ts: Postgres
// identifiers cannot be bind-parameterized, so every name interpolated here
// is validated first (ROLE_NAME_PATTERN for role names; databaseName is
// generated by this module from a fixed charset, never user input).
const DATABASE_NAME_PATTERN = /^ji_test_iso_[a-z0-9_]+$/u;

const requireDatabaseName = (name: string): void => {
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      `test-isolation: '${name}' is not a valid isolated database name`
    );
  }
};

const bootstrapRoleGrants = async (
  admin: ReturnType<typeof postgres>,
  databaseName: string
): Promise<void> => {
  requireRoleName(migratorUser, "POSTGRES_MIGRATOR_USER");
  requireRoleName(appUser, "POSTGRES_APP_USER");
  requireDatabaseName(databaseName);

  await admin.unsafe(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`);
  await admin.unsafe(
    `GRANT CONNECT, CREATE ON DATABASE "${databaseName}" TO "${migratorUser}"`
  );
  await admin.unsafe(
    `GRANT CONNECT ON DATABASE "${databaseName}" TO "${appUser}"`
  );
};

const bootstrapSchemaGrants = async (
  migrator: ReturnType<typeof postgres>
): Promise<void> => {
  requireRoleName(migratorUser, "POSTGRES_MIGRATOR_USER");
  requireRoleName(appUser, "POSTGRES_APP_USER");

  await migrator.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  await migrator.unsafe(
    `GRANT USAGE, CREATE ON SCHEMA public TO "${migratorUser}"`
  );
  await migrator.unsafe(`GRANT USAGE ON SCHEMA public TO "${appUser}"`);
  await migrator.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${migratorUser}" GRANT USAGE ON SCHEMAS TO "${appUser}"`
  );
  await migrator.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${migratorUser}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appUser}"`
  );
  await migrator.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${migratorUser}" GRANT USAGE, SELECT ON SEQUENCES TO "${appUser}"`
  );
};

const setupIsolatedDatabase = async (): Promise<void> => {
  if (process.env.DATABASE_TEST_URL !== undefined) {
    // Caller already pointed tests at a specific database — respect it.
    return;
  }

  const requireDatabaseTests = process.env.REQUIRE_DATABASE_TESTS === "1";
  const admin = postgres({
    connect_timeout: 3,
    database: "postgres",
    host: "127.0.0.1",
    max: 1,
    password: adminPassword,
    port: hostPort,
    username: adminUser,
  });

  try {
    await admin`SELECT 1`;
  } catch (error) {
    // Best-effort cleanup after a probe failure; the probe error itself
    // (thrown below) is what matters more than a cleanup failure here.
    await admin.end({ timeout: 1 }).catch((cleanupError) => {
      console.error("test-isolation: admin cleanup failed", cleanupError);
    });
    const detail = error instanceof Error ? error.message : String(error);
    // SAFETY: Node and postgres.js attach a string `code` to connection
    // errors (ECONNREFUSED, ENOTFOUND, ...) and to PostgresError instances
    // (28P01, 42501, ...), mirroring
    // tools/postgres/ensure-migration-upgrade-db.ts. Narrowed only after
    // confirming `error` is an Error carrying a `code` property.
    const code =
      error instanceof Error && "code" in error
        ? (error as Error & { code: string }).code
        : undefined;
    if (
      code !== undefined &&
      UNREACHABLE_ERROR_CODES.has(code) &&
      !requireDatabaseTests
    ) {
      return;
    }
    throw new Error(
      `test-isolation: Postgres admin connection failed (${detail})`,
      {
        cause: error,
      }
    );
  }

  const databaseName = `ji_test_iso_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  requireDatabaseName(databaseName);

  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    await bootstrapRoleGrants(admin, databaseName);
  } finally {
    await admin.end({ timeout: 3 });
  }

  const migratorUrl = databaseUrl(migratorUser, migratorPassword, databaseName);
  const appUrl = databaseUrl(appUser, appPassword, databaseName);
  const adminUrl = databaseUrl(adminUser, adminPassword, databaseName);

  // Schema-level grants (unlike database-level grants) must run against a
  // connection to the new database itself, and only its owner (the admin
  // role that just created it) can REVOKE/GRANT on its `public` schema —
  // the migrator role has no privilege to do that to itself.
  const adminOnNewDb = postgres(adminUrl, { max: 1 });
  try {
    await bootstrapSchemaGrants(adminOnNewDb);
  } finally {
    await adminOnNewDb.end({ timeout: 3 });
  }

  const migrator = postgres(migratorUrl, { max: 1 });
  try {
    await migrate(drizzle(migrator), { migrationsFolder });
  } finally {
    await migrator.end({ timeout: 3 });
  }

  isolatedDatabaseName = databaseName;
  process.env.DATABASE_TEST_URL = migratorUrl;
  process.env.DATABASE_APP_TEST_URL = appUrl;
  process.env.DATABASE_ADMIN_TEST_URL = adminUrl;
  // biome-ignore lint: diagnostic output for local/CI test runs, not app code
  console.log(
    `test-isolation: DB specs run against isolated database '${databaseName}'`
  );
};

const teardownIsolatedDatabase = async (): Promise<void> => {
  if (!isolatedDatabaseName) {
    return;
  }
  const startedAt = performance.now();
  const admin = postgres({
    connect_timeout: 3,
    database: "postgres",
    host: "127.0.0.1",
    max: 1,
    password: adminPassword,
    port: hostPort,
    username: adminUser,
  });
  requireDatabaseName(isolatedDatabaseName);
  try {
    // Backends still attached are the ones WITH (FORCE) has to terminate and
    // wait for; logging the count (and the wall time) below keeps the
    // teardown's real cost visible in every gate log — see
    // docs/runbooks/gate-flaky-tests.md, rule 1.
    const [activity] = await admin<{ attached: number }[]>`
      SELECT count(*)::int AS attached
      FROM pg_stat_activity
      WHERE datname = ${isolatedDatabaseName}
    `;
    await admin.unsafe(
      `DROP DATABASE IF EXISTS "${isolatedDatabaseName}" WITH (FORCE)`
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    // biome-ignore lint: diagnostic output for local/CI test runs
    console.log(
      `test-isolation: dropped '${isolatedDatabaseName}' in ${elapsedMs} ms (${activity?.attached ?? "unknown"} backend(s) still attached at drop time)`
    );
  } catch (error) {
    // A failed teardown must not fail the whole (already-passed) test run —
    // it leaves one uniquely-named orphan database, which is a cleanup
    // task, not a correctness problem. Log so it's visible.
    // biome-ignore lint: diagnostic output for local/CI test runs
    console.error(
      `test-isolation: failed to drop '${isolatedDatabaseName}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    await admin.end({ timeout: 3 });
  }
};

// Setup runs eagerly via top-level await (Bun waits for a preloaded
// module's top-level await before running any test file). Only teardown
// needs a registered lifecycle hook — declared outside any `describe`,
// which Bun treats as global: it runs exactly once, after every test file.
await setupIsolatedDatabase();

// Bun applies its 5000 ms default per-test budget to this global hook too,
// and reports a timeout here as
//   (fail) (unnamed) [5000.xxms]
//     ^ a beforeEach/afterEach hook timed out for this test.
// under whichever spec file ran LAST — never under this module. Bun orders
// files by a breadth-first directory walk, so that is the deepest test file
// in the repo (apps/web/src/features/job-intelligence/rest/
// capability-client.spec.ts as of 2026-09-04), which took the blame for one
// such timeout in the pre-push gate. See docs/runbooks/gate-flaky-tests.md.
//
// The teardown is a network round-trip, not in-process work: a fresh admin
// connection plus DROP DATABASE ... WITH (FORCE), which terminates every
// backend still attached, waits for them to exit, and forces an immediate
// checkpoint of the dropped database. Measured per runbook rule 3 (4-core
// Linux, local Postgres 16, full suite looped beside `turbo run check-types
// --force`): 90–549 ms for the DROP statement alone, 114–270 ms teardown
// wall, 0 backends left to terminate; 176–644 ms wall with an fsync-heavy
// writer added on the data filesystem (load avg 8.6); 5021 ms observed once
// on macOS with Postgres in Docker under the full gate. Sized at 60 s so a
// slow checkpoint under gate load cannot fail an already-green run.
const TEARDOWN_TIMEOUT_MS = 60_000;

afterAll(
  async () => {
    await teardownIsolatedDatabase();
  },
  { timeout: TEARDOWN_TIMEOUT_MS }
);
