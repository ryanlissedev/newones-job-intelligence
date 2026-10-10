import {
  SEARCH_INDEX_NAME,
  SEARCH_SCHEMA_HASH,
  ZERO_SEQUENCE,
} from "@ji/search";
import type {
  SearchVersion,
  SearchVersionCheckpoint,
  SearchVersionStore,
} from "@ji/search";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { searchProjectionCheckpoint } from "./schema";
import {
  lockSearchIndexCoordination,
  readSearchIndexCheckpoint,
} from "./search-index-coordination";

export type SearchVersionDatabase = PostgresJsDatabase<typeof schema>;

const FIRST_GENERATION = 1;

export interface PostgresSearchVersionStoreOptions {
  indexName?: string;
  schemaHash?: string;
}

/**
 * Durable SearchVersion anchored in `curated.search_projection_checkpoint`
 * (RJC-384). Every process (API server, Trigger worker) constructed against
 * the same database reads and advances the same checkpoint row.
 */
export class PostgresSearchVersionStore implements SearchVersionStore {
  /** Resolves once the bootstrap insert has succeeded; see ensureCheckpoint. */
  private checkpointEnsured?: Promise<void>;
  private readonly database: SearchVersionDatabase;
  private readonly indexName: string;
  private readonly schemaHash: string;

  constructor(
    database: SearchVersionDatabase,
    options: PostgresSearchVersionStoreOptions = {}
  ) {
    this.database = database;
    this.indexName = options.indexName ?? SEARCH_INDEX_NAME;
    this.schemaHash = options.schemaHash ?? SEARCH_SCHEMA_HASH;
  }

  async advance(appliedSequence: bigint): Promise<SearchVersion> {
    await this.ensureCheckpoint();
    const rows = await this.database
      .update(searchProjectionCheckpoint)
      .set({
        // GREATEST keeps the checkpoint monotonic: a concurrent or replayed
        // drain can never move it backwards.
        appliedSequence: sql`GREATEST(${searchProjectionCheckpoint.appliedSequence}, ${appliedSequence})`,
        updatedAt: new Date(),
      })
      .where(eq(searchProjectionCheckpoint.indexName, this.indexName))
      .returning();

    const [row] = rows;
    if (!row) {
      throw new Error(
        `Search projection checkpoint missing for index "${this.indexName}"`
      );
    }
    return { appliedSequence: row.appliedSequence, generation: row.generation };
  }

  async read(): Promise<SearchVersionCheckpoint> {
    await this.ensureCheckpoint();
    const row = await this.database.query.searchProjectionCheckpoint.findFirst({
      where: eq(searchProjectionCheckpoint.indexName, this.indexName),
    });
    if (!row) {
      throw new Error(
        `Search projection checkpoint missing for index "${this.indexName}"`
      );
    }
    return {
      appliedSequence: row.appliedSequence,
      generation: row.generation,
      schemaHash: row.schemaHash,
    };
  }

  async startNewGeneration(schemaHash: string): Promise<SearchVersion> {
    await this.ensureCheckpoint();
    const rows = await this.database.transaction(async (transaction) => {
      await lockSearchIndexCoordination(transaction, this.indexName);
      const checkpoint = await readSearchIndexCheckpoint(
        transaction,
        this.indexName,
        true
      );
      if (!checkpoint) {
        throw new Error(
          `Search projection checkpoint missing for index "${this.indexName}"`
        );
      }
      return transaction
        .update(searchProjectionCheckpoint)
        .set({
          appliedSequence: ZERO_SEQUENCE,
          generation: sql`${searchProjectionCheckpoint.generation} + 1`,
          schemaHash,
          updatedAt: new Date(),
        })
        .where(eq(searchProjectionCheckpoint.indexName, this.indexName))
        .returning();
    });

    const [row] = rows;
    if (!row) {
      throw new Error(
        `Search projection checkpoint missing for index "${this.indexName}"`
      );
    }
    return { appliedSequence: row.appliedSequence, generation: row.generation };
  }

  /**
   * Bootstrap insert, run at most once per store instance.
   *
   * `read()` sits on the search read path — `SearchAdapter.search()` reads
   * the version before it can even build a cache key — so running the
   * INSERT ... ON CONFLICT DO NOTHING per call put a *write* in front of
   * every search, cache hit included, for a row that never changes after
   * the first one succeeds. Against Neon over TLS that is a network
   * round-trip and a WAL record per query.
   *
   * The promise is memoised only after it resolves: a failed bootstrap
   * (unreachable database, missing grant) must be retried by the next
   * caller, not cached as done.
   *
   * Consequence worth knowing: if the checkpoint row is deleted while a
   * process is running, `read()` now raises "checkpoint missing" instead of
   * silently re-inserting it. That is the safer failure — a re-inserted row
   * reads as generation 1 / sequence 0, which tells the projector the index
   * is empty and makes a deleted checkpoint look like a legitimate rebuild.
   */
  private ensureCheckpoint(): Promise<void> {
    this.checkpointEnsured ??= this.insertCheckpointOnce();
    return this.checkpointEnsured;
  }

  private async insertCheckpointOnce(): Promise<void> {
    try {
      await this.database
        .insert(searchProjectionCheckpoint)
        .values({
          appliedSequence: ZERO_SEQUENCE,
          generation: FIRST_GENERATION,
          indexName: this.indexName,
          schemaHash: this.schemaHash,
        })
        .onConflictDoNothing();
    } catch (error) {
      // Clear the memo so the next caller retries: a bootstrap that failed
      // on an unreachable database must not be remembered as done.
      this.checkpointEnsured = undefined;
      throw error;
    }
  }
}
