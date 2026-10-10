import type { BooleanNode } from "@ji/domain";

import { evaluateBooleanAst } from "./adapter";
import { compareCodepoints } from "./ast-hash";
import { matchesSearchFilters } from "./filter-match";
import { DEFAULT_SEARCH_SCOPE } from "./partition";
import {
  DEFAULT_QUERY_SCOPE,
  emptySearchFacets,
  SEARCH_WINDOW_LIMIT,
} from "./types";
import type {
  EngineSearchParams,
  SearchDocument,
  SearchEngine,
  SearchEngineResult,
  SearchIndexBatch,
  SearchIndexBatchResult,
} from "./types";
import { InMemorySearchVersionStore } from "./version";
import type { SearchVersion, SearchVersionStore } from "./version";

export interface PostgresFtsRow {
  beschrijving: string;
  bron_id: string;
  contracttype: string | null;
  id: string;
  laatst_gezien_op: Date;
  locatie_land: string;
  rank: number;
  status: SearchDocument["status"];
  tarief_max: number | null;
  tarief_min: number | null;
  titel: string;
}

export interface PostgresFtsExecutor {
  search: (params: {
    filters: EngineSearchParams["filters"];
    limit: number;
    matchAst: BooleanNode | null;
    offset: number;
  }) => Promise<PostgresFtsRow[]>;
}

/**
 * Rebuild/fallback adapter behind the same SearchEngine interface.
 * Not the P0 query path — use ManticoreSearchEngine in production.
 */
export class PostgresFtsFallbackEngine implements SearchEngine {
  private readonly documents = new Map<string, SearchDocument>();
  private readonly executor: PostgresFtsExecutor | undefined;
  private readonly versionStore: SearchVersionStore;

  constructor(
    executor?: PostgresFtsExecutor,
    seedDocuments: SearchDocument[] = [],
    versionStore: SearchVersionStore = new InMemorySearchVersionStore()
  ) {
    this.executor = executor;
    this.versionStore = versionStore;
    for (const document of seedDocuments) {
      this.documents.set(document.id, structuredClone(document));
    }
  }

  async applyBatch(batch: SearchIndexBatch): Promise<SearchIndexBatchResult> {
    for (const mutation of batch.mutations) {
      if (mutation.kind === "delete") {
        this.documents.delete(mutation.id);
      } else {
        this.documents.set(
          mutation.document.id,
          structuredClone(mutation.document)
        );
      }
    }
    // Map writes cannot partially fail: every mutation applies.
    const version = await this.versionStore.advance(batch.appliedSequence);
    return { ...version, failures: [], unapplied: [] };
  }

  deleteDocument(id: string): Promise<void> {
    this.documents.delete(id);
    return Promise.resolve();
  }

  async getAppliedVersion(): Promise<SearchVersion> {
    const checkpoint = await this.versionStore.read();
    return {
      appliedSequence: checkpoint.appliedSequence,
      generation: checkpoint.generation,
    };
  }

  async search(params: EngineSearchParams): Promise<SearchEngineResult> {
    const version = await this.getAppliedVersion();
    if (this.executor) {
      const rows = await this.executor.search({
        filters: params.filters,
        limit: params.limit,
        matchAst: params.ast,
        offset: params.offset,
      });

      return {
        facets: emptySearchFacets(),
        hits: rows.map((row) => ({ id: row.id, weight: row.rank })),
        incomplete: false,
        indexVersion: Number(version.appliedSequence),
        // ponytail: the fallback has no partitions; it reports the scope it
        // was asked for and searches everything it holds.
        scope: params.scope ?? DEFAULT_SEARCH_SCOPE,
        total: rows.length,
        windowLimit: SEARCH_WINDOW_LIMIT,
      };
    }

    const matched = [...this.documents.values()].filter((document) => {
      if (!matchesSearchFilters(document, params.filters)) {
        return false;
      }

      if (params.ast === null) {
        return true;
      }

      const queryScope = params.filters.queryScope ?? DEFAULT_QUERY_SCOPE;
      if (queryScope === "title") {
        return evaluateBooleanAst(
          params.ast,
          document.titel,
          document.opdrachtgeverNaam ?? ""
        );
      }
      return evaluateBooleanAst(
        params.ast,
        document.titel,
        `${document.beschrijving} ${document.opdrachtgeverNaam ?? ""}`
      );
    });

    // Codepoint order (RJC-396), not localeCompare: page boundaries must not
    // depend on the process's ICU default locale, the same determinism
    // property RJC-378 gave the other engines via hashDocumentId.
    const sorted = matched.toSorted((left, right) =>
      compareCodepoints(left.id, right.id)
    );
    const page = sorted.slice(params.offset, params.offset + params.limit);

    return {
      emptyReason: this.documents.size === 0 ? "empty_index" : undefined,
      facets: emptySearchFacets(),
      hits: page.map((document) => ({ id: document.id, weight: 1 })),
      incomplete: false,
      indexVersion: Number(version.appliedSequence),
      scope: params.scope ?? DEFAULT_SEARCH_SCOPE,
      total: matched.length,
      windowLimit: SEARCH_WINDOW_LIMIT,
    };
  }

  upsertDocument(document: SearchDocument): Promise<void> {
    this.documents.set(document.id, structuredClone(document));
    return Promise.resolve();
  }
}
