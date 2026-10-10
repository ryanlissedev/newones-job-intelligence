import { isVoorwaardenStatus } from "@ji/domain";
import type { VoorwaardenStatus } from "@ji/domain";
import { asc, sql } from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import { bron } from "./schema/curated";

export interface BronSeedRowRecord {
  actief: boolean;
  id: string;
  naam: string;
  status: string;
  voorwaardenStatus: VoorwaardenStatus;
}

type ReadOnlyTransaction = Parameters<
  Parameters<BronRuntimeDatabase["transaction"]>[0]
>[0];

/**
 * Runs `read` in a `READ ONLY` transaction. Postgres rejects any INSERT,
 * UPDATE or DELETE issued inside it, so a report built on it cannot change data.
 */
export const withReadOnlyTransaction = <T>(
  database: BronRuntimeDatabase,
  read: (tx: ReadOnlyTransaction) => Promise<T>
): Promise<T> =>
  database.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return read(tx);
  });

/**
 * Reads the operator-owned bron columns for the seed reconcile report. The
 * read runs in a READ ONLY transaction, so the reconcile can never switch
 * rows off or re-gate them.
 */
export const readBronSeedRows = (
  database: BronRuntimeDatabase
): Promise<BronSeedRowRecord[]> =>
  withReadOnlyTransaction(database, async (tx) => {
    const rows = await tx
      .select({
        actief: bron.actief,
        id: bron.id,
        naam: bron.naam,
        status: bron.status,
        voorwaardenStatus: bron.voorwaardenStatus,
      })
      .from(bron)
      .orderBy(asc(bron.naam));
    return rows.map((row) => {
      if (!isVoorwaardenStatus(row.voorwaardenStatus)) {
        throw new Error(
          `bron ${row.id} has unknown voorwaarden_status ${row.voorwaardenStatus}`
        );
      }
      return { ...row, voorwaardenStatus: row.voorwaardenStatus };
    });
  });
