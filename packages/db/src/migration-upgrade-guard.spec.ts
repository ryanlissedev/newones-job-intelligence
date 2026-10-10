import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type postgres from "postgres";

import {
  createMigrationUpgradeClient,
  requireMigrationUpgradeDatabaseUrl,
} from "./migration-upgrade-guard";

const safeUrl =
  "postgresql://test:test@127.0.0.1:1/ji_migration_upgrade_test_guard";

describe("migration-upgrade database guard", () => {
  it("accepts a dedicated disposable database pathname", () => {
    expect(requireMigrationUpgradeDatabaseUrl(safeUrl)).toBe(safeUrl);
  });

  it("rejects unsafe and malformed URLs", () => {
    expect(() =>
      requireMigrationUpgradeDatabaseUrl(
        "postgresql://test:test@127.0.0.1:1/postgres"
      )
    ).toThrow("ji_migration_upgrade_test_*");
    expect(() => requireMigrationUpgradeDatabaseUrl("not a URL")).toThrow(
      "ji_migration_upgrade_test_*"
    );
    expect(() =>
      requireMigrationUpgradeDatabaseUrl(
        "https://test:test@127.0.0.1/ji_migration_upgrade_test_guard"
      )
    ).toThrow("ji_migration_upgrade_test_*");
  });

  it("rejects encoded and multi-segment pathname bypasses", () => {
    const invalidPathnames = [
      "ji_migration_upgrade_test_guard%2Fpostgres",
      "ji%5Fmigration_upgrade_test_guard",
      "ji_migration_upgrade_test_guard/",
      "ji_migration_upgrade_test_guard/postgres",
    ];

    for (const pathname of invalidPathnames) {
      expect(() =>
        requireMigrationUpgradeDatabaseUrl(
          `postgresql://test:test@127.0.0.1:1/${pathname}`
        )
      ).toThrow("ji_migration_upgrade_test_*");
    }
  });

  it("rejects constructor and query-string database overrides", () => {
    expect(() =>
      requireMigrationUpgradeDatabaseUrl(safeUrl, { database: "postgres" })
    ).toThrow("ji_migration_upgrade_test_*");
    expect(() =>
      requireMigrationUpgradeDatabaseUrl(safeUrl, { db: "postgres" })
    ).toThrow("ji_migration_upgrade_test_*");
    expect(() =>
      requireMigrationUpgradeDatabaseUrl(`${safeUrl}?database=postgres`)
    ).toThrow("ji_migration_upgrade_test_*");
    expect(() =>
      requireMigrationUpgradeDatabaseUrl(`${safeUrl}?db=postgres`)
    ).toThrow("ji_migration_upgrade_test_*");
  });

  it("does not invoke the postgres constructor for an unsafe effective database", () => {
    let constructorCalls = 0;
    const constructor: Parameters<
      typeof createMigrationUpgradeClient
    >[1] = () => {
      constructorCalls += 1;
      throw new Error("constructor must not run");
    };

    expect(() =>
      createMigrationUpgradeClient(
        "postgresql://test:test@127.0.0.1:1/postgres",
        constructor
      )
    ).toThrow("ji_migration_upgrade_test_*");
    expect(constructorCalls).toBe(0);
  });

  it("constructs a client for an allowed disposable database", () => {
    let constructorCalls = 0;
    // SAFETY: This identity-only sentinel is returned by the fake constructor;
    // the test never calls a postgres client method on it.
    const expectedClient = {} as ReturnType<typeof postgres>;
    const constructor: Parameters<typeof createMigrationUpgradeClient>[1] = (
      url,
      options
    ) => {
      constructorCalls += 1;
      expect(url).toBe(safeUrl);
      expect(options).toEqual({ max: 1 });
      return expectedClient;
    };

    expect(createMigrationUpgradeClient(safeUrl, constructor)).toBe(
      expectedClient
    );
    expect(constructorCalls).toBe(1);
  });

  it("guards every migration-upgrade constructor through the shared helper", async () => {
    const migrationSpec = await Bun.file(
      path.join(import.meta.dir, "migration-upgrade.spec.ts")
    ).text();

    expect(migrationSpec).not.toContain('import postgres from "postgres";');
    expect(migrationSpec).not.toMatch(/\bpostgres\s*\(/u);
    expect(migrationSpec).toContain("createMigrationUpgradeClient(");
  });

  it("fails before a selected sibling suite can connect or execute SQL", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "ji-upgrade-guard-")
    );
    const markerPath = path.join(temporaryDirectory, "postgres-calls.log");
    const childConfigPath = path.join(temporaryDirectory, "bunfig.toml");
    const recorderPreload = path.join(
      import.meta.dir,
      "fixtures/postgres-call-recorder.preload.ts"
    );
    const isolationPreload = path.join(
      import.meta.dir,
      "../../../tools/postgres/test-isolation.ts"
    );
    const childEnvironment = { ...process.env };
    delete childEnvironment.DATABASE_TEST_URL;
    delete childEnvironment.DATABASE_APP_TEST_URL;
    delete childEnvironment.DATABASE_ADMIN_TEST_URL;
    childEnvironment.DATABASE_UPGRADE_TEST_URL =
      "postgresql://test:test@127.0.0.1:1/postgres";
    childEnvironment.POSTGRES_CALL_MARKER = markerPath;
    childEnvironment.POSTGRES_HOST_PORT = "1";

    try {
      await writeFile(markerPath, "", { encoding: "utf-8" });
      await writeFile(
        childConfigPath,
        `[test]\npreload = [${JSON.stringify(recorderPreload)}, ${JSON.stringify(isolationPreload)}]\n`,
        { encoding: "utf-8" }
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          `--config=${childConfigPath}`,
          path.join(import.meta.dir, "migration-upgrade.spec.ts"),
          "--test-name-pattern",
          "0015 to 0016 bron_health",
        ],
        {
          env: childEnvironment,
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      const output = `${stdout}\n${stderr}`;
      const postgresCalls = await readFile(markerPath, "utf-8");

      expect(exitCode).not.toBe(0);
      expect(output).toContain("ji_migration_upgrade_test_*");
      expect(postgresCalls).toBe("loaded\n");
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
