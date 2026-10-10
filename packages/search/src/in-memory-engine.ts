import {
  recordCriticalPathPhaseSync,
  timeCriticalPathPhase,
} from "@ji/performance";

import { evaluateBooleanAst } from "./adapter";
import { compareCodepoints } from "./ast-hash";
import { matchesSearchFilters } from "./filter-match";
import { hashDocumentId } from "./manticore/id-hash";
import {
  DEFAULT_SEARCH_SCOPE,
  documentPartition,
  partitionInScope,
} from "./partition";
import type { SearchPartition } from "./partition";
import type {
  EngineSearchParams,
  SearchDocument,
  SearchEngine,
  SearchEngineResult,
  SearchFacetBucket,
  SearchFacets,
  SearchIndexBatch,
  SearchIndexBatchResult,
  SearchSort,
} from "./types";
import {
  DEFAULT_QUERY_SCOPE,
  documentLocatie,
  emptySearchFacets,
  SEARCH_WINDOW_LIMIT,
} from "./types";
import { InMemorySearchVersionStore } from "./version";
import type { SearchVersion, SearchVersionStore } from "./version";

type FacetField =
  | "bronId"
  | "contracttype"
  | "locatie"
  | "locatieLand"
  | "provincie"
  | "status";

const facetValueForField = (
  document: SearchDocument,
  field: FacetField
): string | undefined => {
  switch (field) {
    case "bronId": {
      return document.bronId;
    }
    case "locatie": {
      return documentLocatie(document) ?? "";
    }
    case "locatieLand": {
      return document.locatie === null
        ? undefined
        : (document.locatieLand ?? undefined);
    }
    case "provincie": {
      return document.provincie ?? "";
    }
    case "contracttype": {
      return document.contracttype ?? "unknown";
    }
    case "status": {
      return document.status;
    }
    default: {
      const _exhaustive: never = field;
      throw new Error(`Unsupported facet field: ${String(_exhaustive)}`);
    }
  }
};

const countFacet = (
  documents: SearchDocument[],
  field: FacetField
): SearchFacetBucket[] => {
  const counts = new Map<string, number>();
  for (const document of documents) {
    const value = facetValueForField(document, field);
    if (value === undefined) {
      continue;
    }
    if (
      (field === "locatie" ||
        field === "locatieLand" ||
        field === "provincie") &&
      value === ""
    ) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  // Codepoint order (RJC-396), not localeCompare: these values get cached
  // (buildFacetCacheKey), so locale-dependent ordering would make the same
  // cache entry present differently-ordered facet buckets depending on
  // which process's locale filled it — user-visible order flapping.
  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .toSorted((left, right) => compareCodepoints(left.value, right.value));
};

const countSkillsFacet = (documents: SearchDocument[]): SearchFacetBucket[] => {
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const skill of new Set(document.skills)) {
      if (skill === "") {
        continue;
      }
      counts.set(skill, (counts.get(skill) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .toSorted((left, right) => compareCodepoints(left.value, right.value));
};

const buildFacets = (documents: SearchDocument[]): SearchFacets => ({
  bron_id: countFacet(documents, "bronId"),
  contracttype: countFacet(documents, "contracttype"),
  locatie: countFacet(documents, "locatie"),
  locatie_land: countFacet(documents, "locatieLand"),
  provincie: countFacet(documents, "provincie"),
  skills: countSkillsFacet(documents),
  status: countFacet(documents, "status"),
});

/**
 * Manticore tiebreaks on its numeric doc id, which is hashDocumentId(id);
 * using the same key here keeps page boundaries and tied-score order
 * identical across both engines.
 */
const byId = (left: SearchDocument, right: SearchDocument): number =>
  hashDocumentId(left.id) - hashDocumentId(right.id);

/**
 * Same ordering contract as the Manticore clauses in manticore/client.ts:
 * primary key per sort, hashed document id as the final tiebreak so pages
 * are stable. Missing rates sort as 0 (last under desc) and missing
 * deadlines sort last, exactly as the indexed sentinels make Manticore behave.
 */
const publicationTime = (document: SearchDocument): number | null =>
  document.publicatiedatum?.getTime() ?? null;

/** Comparable rate only when an explicit period is present (CTP-493). */
const comparableRate = (
  document: SearchDocument,
  prefer: "max" | "min"
): number | null => {
  if (document.tariefEenheid === null) {
    return null;
  }
  return prefer === "max" ? document.tariefMax : document.tariefMin;
};

const compareNullableNumberDesc = (
  left: number | null,
  right: number | null
): number | null => {
  if (left === null && right === null) {
    return null;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  if (left === right) {
    return null;
  }
  return right < left ? -1 : 1;
};

const compareNullableNumberAsc = (
  left: number | null,
  right: number | null
): number | null => {
  if (left === null && right === null) {
    return null;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  if (left === right) {
    return null;
  }
  return left < right ? -1 : 1;
};

// oxlint-disable-next-line eslint/complexity -- exhaustive SearchSort switch
const compareDocuments = (
  left: SearchDocument,
  right: SearchDocument,
  sort: SearchSort
): number => {
  switch (sort) {
    case "relevance": {
      // Every in-memory hit weighs 1, so relevance degrades to the tiebreak.
      return byId(left, right);
    }
    case "newest": {
      return (
        compareNullableNumberDesc(
          publicationTime(left),
          publicationTime(right)
        ) ?? byId(left, right)
      );
    }
    case "oldest": {
      return (
        compareNullableNumberAsc(
          publicationTime(left),
          publicationTime(right)
        ) ?? byId(left, right)
      );
    }
    case "rate-high": {
      return (
        compareNullableNumberDesc(
          comparableRate(left, "max"),
          comparableRate(right, "max")
        ) ?? byId(left, right)
      );
    }
    case "rate-low": {
      return (
        compareNullableNumberAsc(
          comparableRate(left, "min"),
          comparableRate(right, "min")
        ) ?? byId(left, right)
      );
    }
    case "closing-soon": {
      const leftDeadline = left.sluitingsdatum?.getTime() ?? Infinity;
      const rightDeadline = right.sluitingsdatum?.getTime() ?? Infinity;
      if (leftDeadline !== rightDeadline) {
        return leftDeadline < rightDeadline ? -1 : 1;
      }
      return byId(left, right);
    }
    case "title-asc": {
      return compareCodepoints(left.titel, right.titel) || byId(left, right);
    }
    case "company-asc": {
      const leftCompany = left.opdrachtgeverNaam ?? "";
      const rightCompany = right.opdrachtgeverNaam ?? "";
      // Unknown company sorts last under A–Z.
      if (left.opdrachtgeverNaam === null && right.opdrachtgeverNaam === null) {
        return byId(left, right);
      }
      if (left.opdrachtgeverNaam === null) {
        return 1;
      }
      if (right.opdrachtgeverNaam === null) {
        return -1;
      }
      return compareCodepoints(leftCompany, rightCompany) || byId(left, right);
    }
    default: {
      const _exhaustive: never = sort;
      throw new Error(`Unsupported sort: ${String(_exhaustive)}`);
    }
  }
};

interface PartitionedDocument {
  document: SearchDocument;
  partition: SearchPartition;
}

/**
 * Mirrors the Manticore layout (RJC-383): one map keyed by id, each entry
 * tagged with its partition, so a re-upsert that changes partition is a
 * move here exactly as it is there (a document is in one partition only).
 */
export class InMemorySearchEngine implements SearchEngine {
  private readonly clock: () => Date;
  private readonly documents = new Map<string, PartitionedDocument>();
  private readonly versionStore: SearchVersionStore;

  constructor(
    versionStore: SearchVersionStore = new InMemorySearchVersionStore(),
    clock: () => Date = () => new Date()
  ) {
    this.versionStore = versionStore;
    this.clock = clock;
  }

  private store(document: SearchDocument, partition?: SearchPartition): void {
    this.documents.set(document.id, {
      document: structuredClone(document),
      partition: partition ?? documentPartition(document, this.clock()),
    });
  }

  async applyBatch(batch: SearchIndexBatch): Promise<SearchIndexBatchResult> {
    for (const mutation of batch.mutations) {
      if (mutation.kind === "delete") {
        this.documents.delete(mutation.id);
      } else {
        this.store(mutation.document, mutation.partition);
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
    const scope = params.scope ?? DEFAULT_SEARCH_SCOPE;
    return timeCriticalPathPhase("search-serialization", () => {
      const matchesQuery = (document: SearchDocument): boolean => {
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
      };
      const matched: SearchDocument[] = [];
      let archiveTotal = 0;
      for (const entry of this.documents.values()) {
        if (!matchesQuery(entry.document)) {
          continue;
        }
        if (partitionInScope(entry.partition, scope)) {
          matched.push(entry.document);
        } else {
          archiveTotal += 1;
        }
      }

      const sorted = matched.toSorted((left, right) =>
        compareDocuments(left, right, params.sort ?? "relevance")
      );
      // Mirror Manticore's max_matches: nothing past the window is returned.
      const page = sorted.slice(
        params.offset,
        Math.min(params.offset + params.limit, SEARCH_WINDOW_LIMIT)
      );
      const facets = recordCriticalPathPhaseSync("search-facets", () =>
        this.documents.size === 0 || params.facets === false
          ? emptySearchFacets()
          : buildFacets(matched)
      );

      let emptyReason: string | undefined;
      if (this.documents.size === 0) {
        emptyReason = "empty_index";
      }

      return Promise.resolve({
        archiveTotal: scope === "active" ? archiveTotal : undefined,
        emptyReason,
        facets,
        hits: page.map((document) => ({ id: document.id, weight: 1 })),
        incomplete: false,
        indexVersion: Number(version.appliedSequence),
        scope,
        total: matched.length,
        windowLimit: SEARCH_WINDOW_LIMIT,
      });
    });
  }

  upsertDocument(document: SearchDocument): Promise<void> {
    this.store(document);
    return Promise.resolve();
  }
}
