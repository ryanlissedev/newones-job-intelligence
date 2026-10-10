#!/usr/bin/env bun
/**
 * RJC-395: create (idempotently) the dedicated database the migration-upgrade
 * suite (packages/db/src/migration-upgrade.spec.ts) requires, so `bun run
 * gate` runs that suite instead of letting it skip silently.
 *
 * Prints exactly one line to stdout:
 *   READY:<database-name>|<url-file>   — database exists/created. The full
 *                             DATABASE_UPGRADE_TEST_URL (with password) is
 *                             written to a mode-0600 temp file, never to
 *                             stdout/a log; gate.sh reads and deletes it.
 *   SKIP:<reason>             — the server itself is unreachable (refused,
 *                              DNS, timeout). Caller (gate.sh) may skip the
 *                              suite outside CI; the spec already handles a
 *                              missing DATABASE_UPGRADE_TEST_URL gracefully.
 *   FAIL:<reason>             — reached the server but auth, permission, or
 *                              some other real error occurred (wrong
 *                              password, missing CREATEDB, ...). This must
 *                              never be treated as "just skip" — that would
 *                              silently disable the suite exactly like
 *                              RJC-395. Caller always hard-fails on this.
 *
 * ponytail: uses the `postgres` package's structured connection options
 * (host/port/username/password) for the admin connection instead of a hand-
 * built URL string, so admin credentials never need URL-encoding at all;
 * only the exported DATABASE_UPGRADE_TEST_URL needs a URL, and that's built
 * with `new URL()` whose username/password setters percent-encode per spec
 * (`/ ? # % @ :` all become safe), never via string concatenation. Also
 * avoids shelling out to a `psql` binary, which isn't guaranteed on the host
 * (only inside the postgres container).
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";

const adminUser = process.env.POSTGRES_ADMIN_USER ?? "ji_admin";
const adminPassword = process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local";
const hostPort = process.env.POSTGRES_HOST_PORT ?? "5432";
const dbName =
  process.env.MIGRATION_UPGRADE_TEST_DB ?? "ji_migration_upgrade_test_ci";

const DB_NAME_PATTERN = /^ji_migration_upgrade_test_[a-z0-9_]+$/u;

if (!DB_NAME_PATTERN.test(dbName)) {
  process.stderr.write(
    `ensure-migration-upgrade-db: '${dbName}' must match ${DB_NAME_PATTERN}\n`
  );
  process.exit(1);
}

// Only a genuine "cannot reach the server at all" may become a graceful
// SKIP. Auth (28P01/28000), permission (42501), and any other error mean we
// reached Postgres but something is really wrong — that must FAIL loudly,
// never disable the suite silently.
const UNREACHABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
]);

const client = postgres({
  connect_timeout: 3,
  database: "postgres",
  host: "127.0.0.1",
  max: 1,
  onnotice: () => {
    // Silence "database already exists" notices from IF NOT EXISTS-style
    // races; existence is checked explicitly below.
  },
  password: adminPassword,
  port: Number(hostPort),
  username: adminUser,
});

try {
  const existing = await client`
    SELECT 1 FROM pg_database WHERE datname = ${dbName}
  `;
  if (existing.length === 0) {
    // Database identifiers cannot be parameterized; dbName is validated
    // against DB_NAME_PATTERN above, so this is not injectable.
    await client.unsafe(`CREATE DATABASE "${dbName}"`);
  }

  // `URL`'s username/password setters percent-encode reserved userinfo
  // characters (`/ ? # @ :`) but NOT a literal `%` — a password containing
  // one produces a malformed escape (verified: assigning it raw breaks
  // decodeURIComponent on the resulting URL). encodeURIComponent first
  // (it does encode `%`), then assign — the setters pass an already-valid
  // percent-escape through unchanged rather than re-encoding it.
  const targetUrl = new URL(`postgresql://127.0.0.1:${hostPort}/${dbName}`);
  targetUrl.username = encodeURIComponent(adminUser);
  targetUrl.password = encodeURIComponent(adminPassword);

  const urlDir = await mkdtemp(path.join(tmpdir(), "ji-migration-upgrade-db-"));
  const urlFile = path.join(urlDir, "url");
  await writeFile(urlFile, targetUrl.toString(), { mode: 0o600 });
  process.stdout.write(`READY:${dbName}|${urlFile}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  // SAFETY: Node and postgres.js attach a string `code` to connection
  // errors (ECONNREFUSED, ENOTFOUND, ...) and to PostgresError instances
  // (28P01, 42501, ...). Narrowed only after confirming `error` is an Error
  // carrying a `code` property, so this reflects the real error shape.
  const code =
    error instanceof Error && "code" in error
      ? (error as Error & { code: string }).code
      : undefined;
  if (code !== undefined && UNREACHABLE_ERROR_CODES.has(code)) {
    process.stdout.write(
      `SKIP:no local Postgres reachable at 127.0.0.1:${hostPort} (${detail})\n`
    );
  } else {
    process.stdout.write(`FAIL:${detail}\n`);
  }
} finally {
  await client.end({ timeout: 3 });
}
