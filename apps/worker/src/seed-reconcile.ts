import {
  reconcileSourceSeeds,
  SOURCES,
  summariseSeedReconcile,
} from "@ji/application/sources";
import type { SeedReconcileReport } from "@ji/application/sources";
import type { BronRuntimeDatabase } from "@ji/db";
import { readBronSeedRows } from "@ji/db/bron-seed-rows";

interface LogStream {
  write: (chunk: string) => boolean;
}

type SeedDriftLogFields =
  | ReturnType<typeof summariseSeedReconcile>
  | { message: string };

const logLine = (
  stream: LogStream,
  event: string,
  fields: SeedDriftLogFields
): void => {
  stream.write(`${JSON.stringify({ event, ...fields })}\n`);
};

/**
 * Compares the code registry with the bron rows (read in a READ ONLY
 * transaction). It is a report only: it never inserts, updates or switches a row off.
 */
export const reportSeedDrift = async (
  database: BronRuntimeDatabase
): Promise<SeedReconcileReport> =>
  reconcileSourceSeeds(
    Object.values(SOURCES),
    await readBronSeedRows(database)
  );

/**
 * Poller boot check: logs one `bron_seed_drift` warning line when the
 * registry and the database disagree, so drift is visible without anyone
 * querying prod. Errors are logged and swallowed; the check must never stop the poller.
 */
export const logSeedDriftAtBoot = async (
  report: () => Promise<SeedReconcileReport>,
  stream: LogStream = process.stdout
): Promise<void> => {
  try {
    const result = await report();
    logLine(
      stream,
      result.inSync ? "bron_seed_in_sync" : "bron_seed_drift",
      summariseSeedReconcile(result)
    );
  } catch (error) {
    logLine(stream, "bron_seed_drift_check_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
