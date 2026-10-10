import type { ResumeOrderLookup } from "@ji/connectors";
import type { BronId } from "@ji/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import { sourceFetchHistory } from "./schema";

/** Keeps each `IN` list well inside Postgres' bind-parameter limit. */
const LOOKUP_CHUNK = 1000;

/**
 * `ResumeOrderLookup` over `staging.source_fetch_history` (0032). Reads use
 * the `(bron_id, bron_referentie)` primary key, one query per chunk;
 * references without a row are left out of the map (never processed).
 */
export class PostgresResumeOrderLookup implements ResumeOrderLookup {
  private readonly database: BronRuntimeDatabase;

  constructor(database: BronRuntimeDatabase) {
    this.database = database;
  }

  async lastFetchedAt(
    bronId: BronId,
    bronReferenties: readonly string[]
  ): Promise<ReadonlyMap<string, Date>> {
    const unique = [...new Set(bronReferenties)];
    const chunks: string[][] = [];
    for (let start = 0; start < unique.length; start += LOOKUP_CHUNK) {
      chunks.push(unique.slice(start, start + LOOKUP_CHUNK));
    }
    const lastFetched = new Map<string, Date>();
    for (const chunk of chunks) {
      // oxlint-disable-next-line no-await-in-loop -- chunks read one after another on the run's connection
      const rows = await this.database
        .select({
          bronReferentie: sourceFetchHistory.bronReferentie,
          lastFetchedAt: sourceFetchHistory.lastFetchedAt,
        })
        .from(sourceFetchHistory)
        .where(
          and(
            eq(sourceFetchHistory.bronId, bronId),
            inArray(sourceFetchHistory.bronReferentie, chunk)
          )
        );
      for (const row of rows) {
        lastFetched.set(row.bronReferentie, row.lastFetchedAt);
      }
    }
    return lastFetched;
  }

  async markFetched(bronId: BronId, bronReferentie: string): Promise<void> {
    await this.database
      .insert(sourceFetchHistory)
      .values({ bronId, bronReferentie, lastFetchedAt: sql`now()` })
      .onConflictDoUpdate({
        set: { lastFetchedAt: sql`now()` },
        target: [sourceFetchHistory.bronId, sourceFetchHistory.bronReferentie],
      });
  }
}
