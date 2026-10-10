import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";

export type PruneOutboxEventsDatabase = PostgresJsDatabase<typeof schema>;

const MS_PER_DAY = 86_400_000;

export interface PruneProcessedOutboxEventsOptions {
  /** At most this many rows are deleted per call, so a cycle stays bounded. */
  batchSize: number;
  /** Clock for the retention cutoff. */
  now: Date;
  /** Processed events older than this are deleted. */
  retentionDays: number;
}

/**
 * Deletes up to `batchSize` processed `curated.outbox_event` rows older than
 * the retention window and returns how many were removed.
 *
 * Only `processed_at` rows are touched: unprocessed and dead-lettered events
 * are the drain's responsibility and are never pruned here. A processed event
 * has already been applied to the search projection, so deleting it loses
 * nothing the projector still needs; the row exists afterwards only for
 * audit, which is what the retention window bounds (CTP-404: prod carried
 * 1.55M processed events / ~665 MB before this existed).
 *
 * Batched by primary key because a single unbounded DELETE over millions of
 * rows holds the write lock long enough to stall the drain's own inserts.
 */
export const pruneProcessedOutboxEvents = async (
  database: PruneOutboxEventsDatabase,
  options: PruneProcessedOutboxEventsOptions
): Promise<number> => {
  const cutoff = new Date(
    options.now.getTime() - options.retentionDays * MS_PER_DAY
  );
  const result = await database.execute(sql`
    DELETE FROM curated.outbox_event
    WHERE id IN (
      SELECT id FROM curated.outbox_event
      WHERE processed_at IS NOT NULL AND processed_at < ${cutoff.toISOString()}
      LIMIT ${options.batchSize}
    )
  `);
  return result.count;
};
