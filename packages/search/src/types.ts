import type { AanvraagLifecycle, BooleanNode } from "@ji/domain";

import type { OutboxEventPayload } from "./outbox-payload";
import type { SearchPartition, SearchScope } from "./partition";
import type { SearchVersion } from "./version";

export const SEARCH_INDEX_NAME = "aanvragen" as const;

/** Logical index for MANTICORE_URL-gated live specs (RJC-400). */
export const SEARCH_TEST_INDEX_NAME = "aanvragen_test" as const;

/**
 * Deepest reachable `offset + limit` for any search (RJC-378). Manticore runs
 * with `max_matches` set to this value, so hits past it are silently absent
 * rather than an error; every engine reports it as `windowLimit` so a client
 * can cap navigable pages and ask the user to refine instead of paging into
 * the void. `total` is still the true hit count.
 */
export const SEARCH_WINDOW_LIMIT = 1000;

/** Result orderings the engines implement natively (mirrors the web UI). */
export const SEARCH_SORT_OPTIONS = [
  "relevance",
  "newest",
  "oldest",
  "rate-high",
  "rate-low",
  "closing-soon",
  "title-asc",
  "company-asc",
] as const;

export type SearchSort = (typeof SEARCH_SORT_OPTIONS)[number];

/** Execution strategy selected by SearchAdapter for one parsed query. */
export type SearchMode = "hybrid" | "lexical";

/** Default query text scope: title + company, not full description. */
export const DEFAULT_QUERY_SCOPE = "all" as const;

export const QUERY_SCOPE_OPTIONS = ["title", "all"] as const;

export type QueryScope = (typeof QUERY_SCOPE_OPTIONS)[number];

/**
 * Honest unknowns for CTP-493 parity fields that lack a curated source yet.
 * Callers constructing fixtures should spread these rather than invent values.
 */
const EMPTY_SKILLS: readonly string[] = [];

export const SEARCH_DOCUMENT_PARITY_DEFAULTS = {
  eindklantNaam: null,
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: EMPTY_SKILLS,
  tariefEenheid: null,
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
} as const;

export interface SearchDocument {
  beschrijving: string;
  bronId: string;
  contracttype: string | null;
  /**
   * End-client when a first-class curated source exists. Stay null until then;
   * never infer from opdrachtgever or prose.
   */
  eindklantNaam: string | null;
  id: string;
  laatstGezienOp: Date;
  /**
   * Display location as the UI shows it (RJC-378). Optional because the
   * `null` is an explicit unknown from the curated source. An omitted field
   * is retained for legacy/direct engine callers, which still derive the
   * display value from `locatieLand`.
   */
  locatie?: string | null;
  /** Country code when the source also published a reliable location. */
  locatieLand: string | null;
  /** Company/client scope source; never derived from title or description. */
  opdrachtgeverNaam: string | null;
  /**
   * Canonical province only. Legacy rows stay null; never derive from
   * locatieTekst.
   */
  provincie: string | null;
  /**
   * Source-published posting timestamp. Never populated from laatstGezienOp.
   */
  publicatiedatum: Date | null;
  /** Exact source-published skill identifiers/names; default [] when absent. */
  skills: readonly string[];
  /** Deadline; absent/null when the bron does not publish one. */
  sluitingsdatum?: Date | null;
  status: AanvraagLifecycle;
  /** Explicit rate period from curated tarief_eenheid; overlap keeps min/max. */
  tariefEenheid: string | null;
  tariefMax: number | null;
  tariefMin: number | null;
  titel: string;
  /** Explicit numeric weekly-hours upper bound; ambiguous text stays null. */
  urenPerWeekMax: number | null;
  /** Explicit numeric weekly-hours lower bound; ambiguous text stays null. */
  urenPerWeekMin: number | null;
  werkvorm: string | null;
}

/** The `locatie` attribute value both engines index and facet on. */
export const documentLocatie = (
  document: SearchDocument
): string | undefined =>
  // `null` is different from an omitted property: the former is the
  // persistence boundary's honest unknown and must not fall back to NL.
  document.locatie === null
    ? undefined
    : (document.locatie ?? document.locatieLand ?? undefined);

export interface SearchFilters {
  bronIds?: readonly string[];
  contracttype?: readonly string[];
  freshnessDays?: number;
  /** Exact match on the indexed `locatie` attribute (see documentLocatie). */
  locatie?: readonly string[];
  locatieLand?: readonly string[];
  /**
   * Inclusive publication end at the API boundary (ISO-8601). Engines compile
   * as `< next UTC day`.
   */
  publicatiedatumTot?: string;
  publicatiedatumVanaf?: string;
  provincies?: readonly string[];
  /**
   * Title scope searches titel + opdrachtgeverNaam; all searches full text.
   * Defaults to {@link DEFAULT_QUERY_SCOPE} when omitted (CTP-508: full vacature = titel+beschrijving+opdrachtgever).
   */
  queryScope?: QueryScope;
  skills?: readonly string[];
  status?: readonly AanvraagLifecycle[];
  tariefEenheid?: readonly string[];
  tariefMax?: number;
  tariefMin?: number;
  urenPerWeekMax?: number;
  urenPerWeekMin?: number;
  werkvormen?: readonly string[];
}

export interface SearchFacetBucket {
  count: number;
  value: string;
}

export interface SearchFacets {
  bron_id: SearchFacetBucket[];
  contracttype: SearchFacetBucket[];
  locatie: SearchFacetBucket[];
  locatie_land: SearchFacetBucket[];
  provincie: SearchFacetBucket[];
  skills: SearchFacetBucket[];
  status: SearchFacetBucket[];
}

export const emptySearchFacets = (): SearchFacets => ({
  bron_id: [],
  contracttype: [],
  locatie: [],
  locatie_land: [],
  provincie: [],
  skills: [],
  status: [],
});

export interface SearchHit {
  id: string;
  weight: number;
}

export interface SearchEngineResult {
  /**
   * Matches the same query would have in the archive partition; only
   * computed for scope "active" (RJC-383), so the UI can say "N in archief"
   * without a second round trip. `null` when the count failed or timed out
   * (the search itself is unaffected); absent for scope "all".
   */
  archiveTotal?: number | null;
  emptyReason?: string;
  facets: SearchFacets;
  hits: SearchHit[];
  /** True when the engine returned partial hits or facets (for example after a query timeout). */
  incomplete: boolean;
  indexVersion: number;
  /** Partitions this result was read from (RJC-383). */
  scope: SearchScope;
  /** True hit count, independent of the retrievable window. */
  total: number;
  /** Max reachable offset + limit; see SEARCH_WINDOW_LIMIT. */
  windowLimit: number;
}

export interface EngineSearchParams {
  ast: BooleanNode | null;
  /**
   * Defaults to true. False when the caller already holds facets for this
   * query and filters (the adapter's facet cache): the engine then skips the
   * aggregations, which cost 150–230 ms of a default match-all search in
   * production versus ~4 ms for the hits alone (MEASURED 2026-10-09), and
   * returns empty facets.
   */
  facets?: boolean;
  filters: SearchFilters;
  limit: number;
  /** Defaults to lexical for direct/legacy engine callers. */
  mode?: SearchMode;
  offset: number;
  /** Defaults to "active" (RJC-383): the placeable stock, not everything ever seen. */
  scope?: SearchScope;
  /** Defaults to "relevance" — callers outside the adapter (benchmarks, db specs) predate sorting. */
  sort?: SearchSort;
}

/**
 * One index write per document id (RJC-389: the projector coalesces an
 * aggregate's outbox events into a single mutation). `sequenceNumber` is the
 * highest outbox sequence the mutation covers — what the watermark advances
 * to when this mutation, but not the whole batch, is applied.
 */
export type SearchIndexMutation =
  | {
      readonly document: SearchDocument;
      readonly kind: "upsert";
      /**
       * Target partition (RJC-383). The projector resolves it once per plan
       * with one clock; absent (direct callers) the engine resolves it at
       * apply time.
       */
      readonly partition?: SearchPartition;
      /**
       * Partition the document was last written to under this generation,
       * when known from the projection state. Equal to `partition` means a
       * plain replace; different means a MOVE (replace in the new table,
       * then delete from the old one, in one /bulk); absent means unknown,
       * so the engine also deletes from the other table to be safe.
       */
      readonly previousPartition?: SearchPartition;
      /**
       * Canonical hash computed by the planner's captured clock. When
       * present, Manticore stores this exact value in `projection_hash` so
       * the physical row and durable projection state are comparable.
       */
      readonly projectionHash?: string;
      readonly sequenceNumber: bigint;
    }
  | {
      readonly id: string;
      readonly kind: "delete";
      /** Partition the document lives in when known; absent deletes from both. */
      readonly partition?: SearchPartition;
      readonly sequenceNumber: bigint;
    };

/** Document id a mutation targets. */
export const mutationId = (mutation: SearchIndexMutation): string =>
  mutation.kind === "delete" ? mutation.id : mutation.document.id;

export interface SearchIndexBatch {
  /**
   * Sequence of the last outbox event this batch covers — including events
   * that produced no mutation. The watermark lands here when every mutation
   * applies.
   */
  readonly appliedSequence: bigint;
  readonly mutations: readonly SearchIndexMutation[];
}

export interface SearchMutationFailure {
  readonly error: string;
  readonly id: string;
}

/**
 * Per-batch outcome (RJC-389). Every mutation id ends up in exactly one of:
 * applied (implicit — not listed), `failures` (the engine rejected it; the
 * caller retries it with blame) or `unapplied` (not attempted because an
 * earlier mutation failed; retry without blame). `appliedSequence` is the
 * durable watermark after the batch: the batch's own appliedSequence when
 * everything applied, otherwise the highest sequenceNumber among applied
 * mutations (or the previous watermark when none applied).
 */
export interface SearchIndexBatchResult extends SearchVersion {
  readonly failures: readonly SearchMutationFailure[];
  readonly unapplied: readonly string[];
}

export interface SearchEngine {
  /**
   * Applies mutations, then advances the durable version store to the
   * applied watermark (see SearchIndexBatchResult). A crash between the
   * index writes and the advance re-applies the batch, so mutations must be
   * idempotent (upserts/deletes by document id are).
   */
  applyBatch: (batch: SearchIndexBatch) => Promise<SearchIndexBatchResult>;
  deleteDocument: (id: string) => Promise<void>;
  /** Reads the durable version — checkpoint-backed, never process-local. */
  getAppliedVersion: () => Promise<SearchVersion>;
  search: (params: EngineSearchParams) => Promise<SearchEngineResult>;
  upsertDocument: (document: SearchDocument) => Promise<void>;
}

export interface SearchAdapterInput {
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
  query: string;
  /** Defaults to "active" (RJC-383). */
  scope?: SearchScope;
  sort?: SearchSort;
}

export interface SearchAdapterSuccess {
  astHash: string;
  facets: SearchFacets;
  hits: SearchHit[];
  /** Partial results remain visible but must not be treated as snapshot-safe or normally cached. */
  incomplete: boolean;
  indexVersion: number;
  ok: true;
  parserVersion: number;
  scope: SearchScope;
  total: number;
  windowLimit: number;
  archiveTotal?: number | null;
  emptyReason?: string;
  /**
   * How this result was produced (RJC-388): "hit" served straight from the
   * results cache, "coalesced" rode another in-flight identical search,
   * "miss" actually called the engine. Additive/optional — absent for any
   * caller that doesn't care (e.g. a cacheless adapter).
   */
  cache?: "coalesced" | "hit" | "miss";
}

export interface SearchAdapterFailure {
  error: {
    code: "syntax_error";
    message: string;
    offset: number;
  };
  ok: false;
}

export type SearchAdapterResult = SearchAdapterFailure | SearchAdapterSuccess;

export interface ResultCacheEntry {
  astHash: string;
  facets: SearchFacets;
  filters: SearchFilters;
  hits: SearchHit[];
  indexVersion: number;
  scope: SearchScope;
  total: number;
  windowLimit: number;
  archiveTotal?: number | null;
  emptyReason?: string;
}

/**
 * Entries are keyed on SearchVersion, and that key is a watermark, not a
 * proof of completeness: it can sit above unprocessed or retrying outbox
 * rows, and a row re-applied below it does not bump the version (RJC-389).
 * Cache freshness is therefore bounded by TTL, not by version equality.
 */
export interface ResultCache {
  get: (key: string) => Promise<ResultCacheEntry | null>;
  set: (
    key: string,
    entry: ResultCacheEntry,
    ttlSeconds: number
  ) => Promise<void>;
}

export interface OutboxEventRecord {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  id: string;
  /** DB-generated outbox sequence (curated.outbox_event.sequence_number). */
  sequenceNumber: bigint;
  payload: OutboxEventPayload;
}

export interface SearchDocumentLoader {
  loadByAggregateId: (aggregateId: string) => Promise<SearchDocument | null>;
}

/** Loader the bulk projector needs: one query for a whole batch of ids. */
export interface BulkSearchDocumentLoader extends SearchDocumentLoader {
  /** Missing ids are simply absent from the map. */
  loadManyByAggregateIds: (
    aggregateIds: readonly string[]
  ) => Promise<Map<string, SearchDocument>>;
}
