import type {
  IncrementMissedInput,
  LifecycleReconcilePorts,
  MarkSeenInput,
  MissedPollsStore,
} from "@ji/application/lifecycle";
import {
  and,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

import { PostgresCurateStore } from "./postgres-curate-store";
import type * as schema from "./schema";
import { bron, sourceRecord } from "./schema";

export type MissedPollsDatabase = PostgresJsDatabase<typeof schema>;
type MissedPollsTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type MissedPollsExecutor = MissedPollsDatabase | MissedPollsTransaction;

/**
 * `staging.source_record` miss counters (RJC-397). Both statements are keyed
 * on the existing `(bron_id, bron_referentie)` unique index; no extra index.
 */
export class PostgresMissedPollsStore implements MissedPollsStore {
  private readonly database: MissedPollsExecutor;

  constructor(database: MissedPollsExecutor) {
    this.database = database;
  }

  markSeen(
    input: MarkSeenInput
  ): Promise<{ reappeared: string[]; reset: number }> {
    if (input.bronReferenties.length === 0) {
      return Promise.resolve({ reappeared: [], reset: 0 });
    }
    const observed = [...input.bronReferenties];
    return this.database.transaction(async (tx) => {
      const reappearedRows = await tx
        .select({
          bronReferentie: sourceRecord.bronReferentie,
          missedPolls: sourceRecord.missedPolls,
        })
        .from(sourceRecord)
        .where(
          and(
            eq(sourceRecord.bronId, input.bronId),
            inArray(sourceRecord.bronReferentie, observed)
          )
        )
        .orderBy(sourceRecord.bronReferentie)
        .for("update");
      const resetRows = await tx
        .update(sourceRecord)
        .set({
          lastSeenAt: input.seenAt,
          lastSeenScrapeRunId: input.scrapeRunId,
          missedPolls: 0,
        })
        .where(
          and(
            eq(sourceRecord.bronId, input.bronId),
            inArray(sourceRecord.bronReferentie, observed)
          )
        )
        .returning({ id: sourceRecord.id });
      return {
        reappeared: reappearedRows
          .filter((row) => row.missedPolls >= input.reappearedAtOrAbove)
          .map((row) => row.bronReferentie),
        reset: resetRows.length,
      };
    });
  }

  async incrementMissed(
    input: IncrementMissedInput
  ): Promise<{ atThreshold: string[]; incremented: number }> {
    const notObserved =
      input.exceptBronReferenties.length === 0
        ? undefined
        : notInArray(sourceRecord.bronReferentie, [
            ...input.exceptBronReferenties,
          ]);
    // Saturates at threshold + 1: a row AT the threshold is bumped once more
    // so a crash between this UPDATE and the stale write gets exactly one
    // retry on the next run; rows past that are left alone (no churn).
    // last_missed_scrape_run_id makes the bump idempotent per run: a retried
    // task or manual re-invoke for the same scrapeRunId cannot double-count.
    const rows = await this.database
      .update(sourceRecord)
      .set({
        lastMissedScrapeRunId: input.scrapeRunId,
        missedPolls: sql`${sourceRecord.missedPolls} + 1`,
      })
      .where(
        and(
          eq(sourceRecord.bronId, input.bronId),
          lte(sourceRecord.missedPolls, input.staleAtOrAbove),
          or(
            isNull(sourceRecord.lastMissedScrapeRunId),
            ne(sourceRecord.lastMissedScrapeRunId, input.scrapeRunId)
          ),
          notObserved
        )
      )
      .returning({
        bronReferentie: sourceRecord.bronReferentie,
        missedPolls: sourceRecord.missedPolls,
      });
    return {
      atThreshold: rows
        .filter((row) => row.missedPolls >= input.staleAtOrAbove)
        .map((row) => row.bronReferentie),
      incremented: rows.length,
    };
  }
}

/** Ports `executeBronRun({ lifecycle })` needs, built on one database handle. */
export const createPostgresLifecyclePorts = (
  database: MissedPollsDatabase,
  options: { missedPollsBeforeStale?: number } = {}
): LifecycleReconcilePorts => ({
  curateStore: new PostgresCurateStore(database),
  missedPolls: new PostgresMissedPollsStore(database),
  missedPollsBeforeStale: options.missedPollsBeforeStale,
  withTransaction: (bronId, fn) =>
    database.transaction(async (tx) => {
      // Canonical order: bron -> source_record (sorted) -> aanvraag/SCD2/outbox.
      // Serialize reconciles for one bron before locking source_record rows.
      // NO KEY UPDATE remains compatible with FK checks from concurrent curation.
      await tx
        .select({ id: bron.id })
        .from(bron)
        .where(eq(bron.id, bronId))
        .for("no key update");
      return fn({
        curateStore: new PostgresCurateStore(tx),
        missedPolls: new PostgresMissedPollsStore(tx),
      });
    }),
});
