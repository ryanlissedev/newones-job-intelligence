import type { ResumeOrderLookup } from "@ji/connectors";
import type { BronId } from "@ji/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import { sourceRecord } from "./schema";

/** Keeps each `IN` list well inside Postgres' bind-parameter limit. */
const LOOKUP_CHUNK = 1000;

/**
 * `ResumeOrderLookup` over `staging.source_record.last_fetched_at` (0032).
 * One indexed read per chunk on the `(bron_id, bron_referentie)` unique
 * index; references without a row are left out of the map (never fetched).
 */
export class PostgresResumeOrderLookup implements ResumeOrderLookup {
  private readonly database: BronRuntimeDatabase;

  constructor(database: BronRuntimeDatabase) {
    this.database = database;
  }

  async lastFetchedAt(
    bronId: BronId,
    bronReferenties: readonly string[]
  ): Promise<ReadonlyMap<string, Date | null>> {
    const unique = [...new Set(bronReferenties)];
    const chunks: string[][] = [];
    for (let start = 0; start < unique.length; start += LOOKUP_CHUNK) {
      chunks.push(unique.slice(start, start + LOOKUP_CHUNK));
    }
    const lastFetched = new Map<string, Date | null>();
    for (const chunk of chunks) {
      // oxlint-disable-next-line no-await-in-loop -- chunks read one after another on the run's connection
      const rows = await this.database
        .select({
          bronReferentie: sourceRecord.bronReferentie,
          lastFetchedAt: sourceRecord.lastFetchedAt,
        })
        .from(sourceRecord)
        .where(
          and(
            eq(sourceRecord.bronId, bronId),
            inArray(sourceRecord.bronReferentie, chunk)
          )
        );
      for (const row of rows) {
        lastFetched.set(row.bronReferentie, row.lastFetchedAt);
      }
    }
    return lastFetched;
  }
}
