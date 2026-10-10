type MigrationEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Migration tooling must never inherit the runtime app credential. Requiring
 * the dedicated variable here makes a missing deploy secret fail before
 * Drizzle can open a connection or execute DDL.
 */
export const requireMigrationDatabaseUrl = (
  environment: MigrationEnvironment = process.env
): string => {
  const migrationDatabaseUrl = environment.MIGRATION_DATABASE_URL?.trim();
  if (!migrationDatabaseUrl) {
    throw new Error(
      "MIGRATION_DATABASE_URL is required for database migrations; DATABASE_URL is runtime-only and is never used as a fallback"
    );
  }
  return migrationDatabaseUrl;
};
