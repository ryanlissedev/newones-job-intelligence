import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { runStalenessCutoff } from "./run-staleness";
import type * as schema from "./schema";
import { scrapeRun } from "./schema/curated";

export type AbandonStaleRunsDatabase = PostgresJsDatabase<typeof schema>;

/**
 * The only failure tuple `scrape_run_failure_tuple_check` accepts for a run
 * whose cause was never recorded (migration
 * `0001_u3_durable_ingestion.sql`). `LEGACY_FAILURE` is the other unknown
 * tuple and is reserved for the rows that migration rewrote, so a run this
 * process abandons must use `UNEXPECTED_FAILURE` or the UPDATE is rejected.
 */
export const ABANDONED_RUN_FAILURE = {
  failureClass: "internal",
  failureCode: "UNEXPECTED_FAILURE",
  failureMessage: "Connector run failed",
  failurePhase: "unknown",
} as const;

export interface AbandonStaleRunsOptions {
  /** Clock for both the cutoff and the `geindigd` written on the row. */
  now: Date;
  /** A `running` run started longer ago than this is treated as dead. */
  olderThanMs: number;
}

/**
 * Fails every `curated.scrape_run` left on `status = 'running'` past
 * `olderThanMs` and returns the ids it changed.
 *
 * A run row is opened before the poll and closed after it, so a process that
 * dies mid-run leaves the row `running` forever: nothing else ever revisits
 * it. Trigger's `maxDuration` kills left 148 such rows, repaired by hand
 * (CTP-490). This closes them on the poller's own cycle instead.
 *
 * `geindigd` is set in the same statement because
 * `scrape_run_completion_check` requires it on any non-running row.
 */
export const abandonStaleRuns = async (
  database: AbandonStaleRunsDatabase,
  options: AbandonStaleRunsOptions
): Promise<string[]> => {
  const cutoff = runStalenessCutoff(options.now, options.olderThanMs);
  const rows = await database
    .update(scrapeRun)
    .set({
      ...ABANDONED_RUN_FAILURE,
      fenceToken: sql`${scrapeRun.fenceToken} + 1`,
      geindigd: options.now,
      status: "failed",
    })
    .where(and(eq(scrapeRun.status, "running"), lt(scrapeRun.gestart, cutoff)))
    .returning({ id: scrapeRun.id });
  return rows.map((row) => row.id);
};
