import { SEARCH_INDEX_NAME } from "@ji/search";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { searchProjectorRuntime } from "./schema";

export type SearchProjectorRuntimeDatabase = PostgresJsDatabase<typeof schema>;

export interface SearchProjectorRuntimeRecord {
  containerId: string;
  cycle: number;
  heartbeatAt: Date;
  indexName: string;
  releaseSha: string | null;
  startedAt: Date;
  updatedAt: Date;
}

export interface SearchProjectorRuntimeInput {
  containerId: string;
  cycle: number;
  heartbeatAt: Date;
  releaseSha: string | null;
  startedAt: Date;
}

export interface PostgresSearchProjectorRuntimeStoreOptions {
  indexName?: string;
}

/**
 * Live projector identity anchored in `curated.search_projector_runtime`.
 * The projector writes; the API server reads it back for `/projector/runtime`
 * so a deploy can tell which container and release SHA is draining the index.
 */
export class PostgresSearchProjectorRuntimeStore {
  private readonly database: SearchProjectorRuntimeDatabase;
  private readonly indexName: string;

  constructor(
    database: SearchProjectorRuntimeDatabase,
    options: PostgresSearchProjectorRuntimeStoreOptions = {}
  ) {
    this.database = database;
    this.indexName = options.indexName ?? SEARCH_INDEX_NAME;
  }

  async read(): Promise<SearchProjectorRuntimeRecord | null> {
    const row = await this.database.query.searchProjectorRuntime.findFirst({
      where: eq(searchProjectorRuntime.indexName, this.indexName),
    });
    return row ?? null;
  }

  async record(input: SearchProjectorRuntimeInput): Promise<void> {
    const values = {
      containerId: input.containerId,
      cycle: input.cycle,
      heartbeatAt: input.heartbeatAt,
      indexName: this.indexName,
      releaseSha: input.releaseSha,
      startedAt: input.startedAt,
      updatedAt: input.heartbeatAt,
    };
    await this.database
      .insert(searchProjectorRuntime)
      .values(values)
      .onConflictDoUpdate({
        set: {
          containerId: values.containerId,
          cycle: values.cycle,
          heartbeatAt: values.heartbeatAt,
          releaseSha: values.releaseSha,
          startedAt: values.startedAt,
          updatedAt: values.updatedAt,
        },
        target: searchProjectorRuntime.indexName,
      });
  }
}
