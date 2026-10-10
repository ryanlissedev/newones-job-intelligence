import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import postgres from "postgres";

const adminDatabaseUrl =
  process.env.DATABASE_ADMIN_TEST_URL ??
  "postgresql://ji_admin:ji_admin_local@127.0.0.1:5432/ji_test";
const migratorDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const appDatabaseUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";

const databaseTestsRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const postgresOptions = {
  connect_timeout: 2,
  max: 1,
} as const;

const configureProbeTimeouts = async (
  client: ReturnType<typeof postgres>
): Promise<void> => {
  await client.unsafe("SET lock_timeout TO '2s'");
  await client.unsafe("SET statement_timeout TO '2s'");
};

const expectQueryDenied = async (
  client: ReturnType<typeof postgres>,
  query: string
): Promise<void> => {
  let denied = false;

  try {
    await client.unsafe(query);
  } catch {
    denied = true;
  }

  expect(denied).toBe(true);
};

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorDatabaseUrl, postgresOptions);

  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

describe("postgres role hardening", () => {
  let postgresAvailable = false;
  let adminClient: ReturnType<typeof postgres> | undefined;
  let migratorClient: ReturnType<typeof postgres> | undefined;
  let appClient: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      return;
    }

    adminClient = postgres(adminDatabaseUrl, postgresOptions);
    migratorClient = postgres(migratorDatabaseUrl, postgresOptions);
    appClient = postgres(appDatabaseUrl, postgresOptions);

    await configureProbeTimeouts(migratorClient);
    await configureProbeTimeouts(appClient);
  });

  afterAll(async () => {
    await adminClient?.end({ timeout: 1 });
    await migratorClient?.end({ timeout: 1 });
    await appClient?.end({ timeout: 1 });
  });

  it("creates distinct non-superuser migrator and app roles", async () => {
    if (!postgresAvailable || !adminClient) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const roles = await adminClient<
      {
        rolname: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }[]
    >`
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
      FROM pg_roles
      WHERE rolname IN ('ji_admin', 'ji_migrator', 'ji_app')
      ORDER BY rolname
    `;

    expect(roles.map((role) => role.rolname)).toEqual([
      "ji_admin",
      "ji_app",
      "ji_migrator",
    ]);

    for (const role of roles.filter((entry) => entry.rolname !== "ji_admin")) {
      expect(role.rolsuper).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolcreaterole).toBe(false);
    }
  });

  it("allows migrator DDL but blocks app role from creating schemas, roles, or databases", async () => {
    if (!postgresAvailable || !adminClient || !migratorClient || !appClient) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const schemaName = `u10_role_probe_${Date.now()}`;

    await migratorClient.unsafe(`CREATE SCHEMA ${schemaName}`);
    await migratorClient.unsafe(`DROP SCHEMA ${schemaName}`);

    const [appPrivileges] = await adminClient<
      {
        can_create_db: boolean;
        can_create_role: boolean;
        can_create_schema: boolean;
      }[]
    >`
      SELECT
        has_database_privilege('ji_app', current_database(), 'CREATE') AS can_create_schema,
        (SELECT rolcreatedb FROM pg_roles WHERE rolname = 'ji_app') AS can_create_db,
        (SELECT rolcreaterole FROM pg_roles WHERE rolname = 'ji_app') AS can_create_role
    `;

    expect(appPrivileges?.can_create_schema).toBe(false);
    expect(appPrivileges?.can_create_db).toBe(false);
    expect(appPrivileges?.can_create_role).toBe(false);

    await expectQueryDenied(appClient, "CREATE SCHEMA u10_app_forbidden");
    await expectQueryDenied(appClient, "CREATE ROLE u10_app_forbidden");
  });

  it("requires database tests when REQUIRE_DATABASE_TESTS=1", () => {
    if (databaseTestsRequired) {
      expect(postgresAvailable).toBe(true);
    }
  });
});
