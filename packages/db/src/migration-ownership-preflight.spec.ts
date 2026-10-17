import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import postgres from "postgres";

import {
  MIGRATOR_OWNED_SCHEMAS,
  findForeignOwnedRelations,
  formatOwnershipFailure,
} from "./migration-ownership-preflight";

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

describe("formatOwnershipFailure", () => {
  it("names every foreign-owned relation, its owner and the fix", () => {
    const message = formatOwnershipFailure({
      foreignOwned: [
        {
          kind: "table",
          name: "aanvraag",
          owner: "postgres",
          schema: "curated",
        },
        {
          kind: "sequence",
          name: "bron_seq",
          owner: "postgres",
          schema: "staging",
        },
      ],
      migrationRole: "ji_migrator",
    });

    expect(message).toContain("2 relation(s)");
    expect(message).toContain('migration role "ji_migrator"');
    expect(message).toContain("curated.aanvraag (table, owner postgres)");
    expect(message).toContain("staging.bron_seq (sequence, owner postgres)");
    expect(message).toContain(
      "ALTER TABLE <schema>.<name> OWNER TO ji_migrator"
    );
    expect(message).toContain("No migration was applied.");
  });

  it("caps the listing so a wholesale ownership drift stays readable", () => {
    const foreignOwned = Array.from({ length: 30 }, (_, index) => ({
      kind: "table",
      name: `t${index}`,
      owner: "postgres",
      schema: "curated",
    }));
    const message = formatOwnershipFailure({
      foreignOwned,
      migrationRole: "ji_migrator",
    });

    expect(message).toContain("curated.t24 ");
    expect(message).not.toContain("curated.t25 ");
    expect(message).toContain("... and 5 more");
  });
});

describe("MIGRATOR_OWNED_SCHEMAS", () => {
  it("covers every app schema plus the Drizzle journal schema", () => {
    const schemas: string[] = [...MIGRATOR_OWNED_SCHEMAS];
    expect(schemas.toSorted()).toEqual([
      "curated",
      "drizzle",
      "marts",
      "public",
      "staging",
    ]);
  });
});

describe
  .skipIf(!postgresAvailable)
  .serial("ownership preflight against Postgres", () => {
    let sql: ReturnType<typeof postgres>;

    beforeAll(() => {
      sql = postgres(migratorUrl, { max: 1, onnotice: () => {} });
    });

    afterAll(async () => {
      await sql.end({ timeout: 5 });
    });

    it("reports the migration role as current_user", async () => {
      const result = await findForeignOwnedRelations(sql, ["curated"]);
      const [row] = await sql<
        { role: string }[]
      >`SELECT current_user::text AS role`;
      expect(result.migrationRole).toBe(row?.role ?? "");
    });

    it("flags relations owned by a role the migrator is not a member of", async () => {
      // pg_catalog is owned by the bootstrap superuser, which the
      // least-privilege migrator can never act as: a stand-in for a table an
      // admin created in an app schema.
      const result = await findForeignOwnedRelations(sql, ["pg_catalog"]);
      expect(result.foreignOwned.length).toBeGreaterThan(0);
      expect(
        result.foreignOwned.some((relation) => relation.name === "pg_class")
      ).toBe(true);
      expect(
        result.foreignOwned.every(
          (relation) => relation.owner !== result.migrationRole
        )
      ).toBe(true);
    });

    it("accepts relations the migrator created itself", async () => {
      const schema = `preflight_${process.pid}`;
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await sql.unsafe(
          `CREATE TABLE ${schema}.owned (id int PRIMARY KEY); CREATE SEQUENCE ${schema}.owned_seq; CREATE VIEW ${schema}.owned_v AS SELECT id FROM ${schema}.owned`
        );
        const result = await findForeignOwnedRelations(sql, [schema]);
        expect(result.foreignOwned).toEqual([]);
      } finally {
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    });

    it("exits 0 from the CLI when ownership is clean and fails closed without a URL", () => {
      const script = path.join(
        import.meta.dir,
        "migration-ownership-preflight.ts"
      );
      const ok = Bun.spawnSync(["bun", script], {
        cwd: path.join(import.meta.dir, ".."),
        env: { ...process.env, MIGRATION_DATABASE_URL: migratorUrl },
      });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.toString()).toContain("migration preflight ok");

      const missing = Bun.spawnSync(["bun", script], {
        cwd: "/",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain(
        "MIGRATION_DATABASE_URL is required"
      );
    });
  });
