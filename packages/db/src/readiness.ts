export type DbReadinessResult =
  | { ready: true }
  | {
      ready: false;
      reason: "database_error" | "migration_mismatch";
    };

type ReadLatestMigration = () => Promise<string | null>;

interface MigrationJournal {
  entries: readonly { when: number }[];
}

export const resolveExpectedMigrationTimestamp = (
  journal: MigrationJournal
): string => {
  const latestMigration = journal.entries.at(-1);
  if (!latestMigration) {
    throw new Error("Migration journal must contain at least one entry");
  }

  return String(latestMigration.when);
};

export const evaluateDbReadiness = async (
  expectedMigrationTimestamp: string,
  readLatestMigration: ReadLatestMigration
): Promise<DbReadinessResult> => {
  try {
    const latestMigrationTimestamp = await readLatestMigration();

    if (latestMigrationTimestamp !== expectedMigrationTimestamp) {
      return { ready: false, reason: "migration_mismatch" };
    }

    return { ready: true };
  } catch {
    return { ready: false, reason: "database_error" };
  }
};
