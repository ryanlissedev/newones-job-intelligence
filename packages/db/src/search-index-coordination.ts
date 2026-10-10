import { eq, sql } from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import { searchProjectionCheckpoint } from "./schema/curated";

/**
 * The reindex and reconciliation paths mutate the same generation/checkpoint
 * contract. They deliberately share one transaction-scoped advisory-lock
 * namespace, keyed by the logical index rather than by a transient
 * generation, so a repair cannot race a generation rollover.
 */
export const lockSearchIndexCoordination = async (
  database: BronRuntimeDatabase,
  indexName: string
): Promise<void> => {
  await database.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`search_index_coordination:${indexName}`}))`
  );
};

export interface SearchIndexCheckpointRecord {
  appliedSequence: bigint;
  generation: number;
  schemaHash: string;
}

/**
 * Reads the durable checkpoint belonging to one logical index. `forUpdate`
 * must only be used after `lockSearchIndexCoordination` in the same
 * transaction; together they make a repair page and a reindex page observe
 * one fenced checkpoint.
 */
export const readSearchIndexCheckpoint = async (
  database: BronRuntimeDatabase,
  indexName: string,
  forUpdate = false
): Promise<SearchIndexCheckpointRecord | null> => {
  const query = database
    .select({
      appliedSequence: searchProjectionCheckpoint.appliedSequence,
      generation: searchProjectionCheckpoint.generation,
      schemaHash: searchProjectionCheckpoint.schemaHash,
    })
    .from(searchProjectionCheckpoint)
    .where(eq(searchProjectionCheckpoint.indexName, indexName))
    .limit(1);
  const [checkpoint] = forUpdate ? await query.for("update") : await query;
  return checkpoint ?? null;
};
