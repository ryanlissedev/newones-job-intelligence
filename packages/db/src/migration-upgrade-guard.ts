import postgres from "postgres";

const UPGRADE_DATABASE_NAME_PATTERN = /^ji_migration_upgrade_test_[a-z0-9_]+$/u;
const DATABASE_OVERRIDE_KEYS = ["database", "db"] as const;

type PostgresOptions = NonNullable<Parameters<typeof postgres>[1]>;
type PostgresConstructor = (
  url: string,
  options: PostgresOptions
) => ReturnType<typeof postgres>;

interface DatabaseOverrides {
  database?: unknown;
  db?: unknown;
}

const invalidDatabaseError = (): Error =>
  new Error(
    "Upgrade fixtures require a dedicated ji_migration_upgrade_test_* database"
  );

/**
 * Validate the database postgres.js will actually select before it can create
 * a client. postgres.js gives constructor options precedence over the URL
 * pathname, so both inputs are part of this safety boundary.
 */
export const requireMigrationUpgradeDatabaseUrl = (
  databaseUrl: string | undefined,
  overrides: DatabaseOverrides = {}
): string | undefined => {
  if (databaseUrl === undefined) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw invalidDatabaseError();
  }

  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    throw invalidDatabaseError();
  }

  for (const key of DATABASE_OVERRIDE_KEYS) {
    if (parsedUrl.searchParams.has(key) || overrides[key] !== undefined) {
      throw invalidDatabaseError();
    }
  }

  const databaseName = parsedUrl.pathname.slice(1);

  if (!UPGRADE_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw invalidDatabaseError();
  }

  return databaseUrl;
};

export const createMigrationUpgradeClient = (
  databaseUrl: string,
  constructor: PostgresConstructor = postgres
): ReturnType<typeof postgres> => {
  requireMigrationUpgradeDatabaseUrl(databaseUrl);
  return constructor(databaseUrl, { max: 1 });
};
