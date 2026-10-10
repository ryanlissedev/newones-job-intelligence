import { describe, expect, it } from "bun:test";

import { requireMigrationDatabaseUrl } from "./migration-database-url";

describe("requireMigrationDatabaseUrl", () => {
  it("returns the explicit migration URL", () => {
    expect(
      requireMigrationDatabaseUrl({
        MIGRATION_DATABASE_URL:
          "  postgresql://ji_migrator:secret@postgres/ji_test  ",
      })
    ).toBe("postgresql://ji_migrator:secret@postgres/ji_test");
  });

  it("fails closed when the migration URL is absent", () => {
    expect(() => requireMigrationDatabaseUrl({})).toThrow(
      "MIGRATION_DATABASE_URL is required"
    );
  });

  it("does not accept DATABASE_URL as an implicit fallback", () => {
    const runtimeOnlyEnvironment = {
      DATABASE_URL: "postgresql://ji_app:secret@postgres/ji_test",
    };

    expect(() => requireMigrationDatabaseUrl(runtimeOnlyEnvironment)).toThrow(
      "DATABASE_URL is runtime-only and is never used as a fallback"
    );
  });

  it("rejects an explicitly empty migration URL", () => {
    expect(() =>
      requireMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: "   " })
    ).toThrow("MIGRATION_DATABASE_URL is required");
  });
});
