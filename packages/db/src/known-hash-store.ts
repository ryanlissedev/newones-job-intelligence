import { boundBronReferentie } from "@ji/connectors";
import type { KnownHashStore } from "@ji/connectors";
import type { BronId } from "@ji/domain";
import { and, eq } from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import { sourceRecord } from "./schema";

export class PostgresKnownHashStore implements KnownHashStore {
  private readonly database: BronRuntimeDatabase;

  constructor(database: BronRuntimeDatabase) {
    this.database = database;
  }

  /**
   * RJC-357: returns `listing_hash` — the discover-tier hash — NOT
   * `content_hash` (the payload hash). Connector short-circuits compare the
   * result against `DiscoverItem.contentHash`, which is also a listing
   * hash; reading `content_hash` here would compare hashes of different
   * inputs, which never match, and the skip would silently never fire.
   * NULL (pre-0012 rows, or not yet re-observed) never skips.
   *
   * CTP-500: connectors look up with the raw discover reference; the stored
   * key is the bounded form, so the lookup binds it the same way.
   */
  async get(
    bronId: BronId,
    bronReferentie: string
  ): Promise<string | null | undefined> {
    const [row] = await this.database
      .select({ listingHash: sourceRecord.listingHash })
      .from(sourceRecord)
      .where(
        and(
          eq(sourceRecord.bronId, bronId),
          eq(sourceRecord.bronReferentie, boundBronReferentie(bronReferentie))
        )
      )
      .limit(1);
    return row?.listingHash ?? null;
  }

  /**
   * The payload hash (`content_hash`) of the last persisted fetch. Only read by
   * the lastmod honesty probe, never to skip a fetch.
   */
  async getPayloadHash(
    bronId: BronId,
    bronReferentie: string
  ): Promise<string | null | undefined> {
    const [row] = await this.database
      .select({ contentHash: sourceRecord.contentHash })
      .from(sourceRecord)
      .where(
        and(
          eq(sourceRecord.bronId, bronId),
          eq(sourceRecord.bronReferentie, boundBronReferentie(bronReferentie))
        )
      )
      .limit(1);
    return row?.contentHash ?? null;
  }
}
