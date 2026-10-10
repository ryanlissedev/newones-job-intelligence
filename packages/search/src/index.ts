export {
  SearchAdapter,
  normalizeSearchFilters,
  evaluateBooleanAst,
  isSearchHybridEnabled,
} from "./adapter";
export {
  buildCacheKey,
  buildFacetCacheKey,
  canonicalizeAst,
  hasNegatedClause,
  hasPositiveFreeText,
  hashAst,
  isHybridSearchEligible,
} from "./ast-hash";
export { type FacetCache, MemoryFacetCache } from "./cache/facets-cache";
export { ParserLruCache, PARSER_CACHE_MAX_ENTRIES } from "./cache/parser-cache";
export {
  createResultCache,
  MemoryResultCache,
  RedisResultCache,
  type ResultCacheBackend,
  type ResultCacheResolution,
} from "./cache/result-cache";
export { Singleflight } from "./cache/singleflight";
export { InMemorySearchEngine } from "./in-memory-engine";
export {
  buildBoolJson,
  buildKnnQueryText,
  buildQueryString,
  emitMatch,
  FetchManticoreEffectClient,
  MANTICORE_BULK_ISOLATION_RESENDS_PER_CHUNK,
  MANTICORE_BULK_MAX_BYTES,
  ManticoreSearchEngine,
  partitionFromProjectionHash,
  projectionHash,
  hashDocumentId,
  SEARCH_TEXT_FIELDS,
} from "./manticore";
export { readOutboxStatus, type OutboxEventPayload } from "./outbox-payload";
export {
  ACTIVE_RECENT_DAYS,
  DEFAULT_SEARCH_SCOPE,
  documentPartition,
  partitionInScope,
  partitionTable,
  resolveSearchPartition,
  SEARCH_PARTITIONS,
  SEARCH_SCOPES,
  scopeTables,
  type SearchPartition,
  type SearchScope,
} from "./partition";
export {
  PostgresFtsFallbackEngine,
  type PostgresFtsExecutor,
} from "./postgres-fts-fallback";
export {
  coalesceOutboxEvents,
  drainOutboxEvents,
  planOutboxBatch,
  resolveOutboxMutation,
  type CoalescedOutbox,
  type CoalescedOutboxAggregate,
  type OutboxBatchPlan,
  type OutboxBatchPlanInput,
} from "./projector";
export {
  SEARCH_INDEX_NAME,
  SEARCH_TEST_INDEX_NAME,
  SEARCH_DOCUMENT_PARITY_DEFAULTS,
  SEARCH_SORT_OPTIONS,
  DEFAULT_QUERY_SCOPE,
  QUERY_SCOPE_OPTIONS,
  SEARCH_WINDOW_LIMIT,
  documentLocatie,
  emptySearchFacets,
  mutationId,
  type BulkSearchDocumentLoader,
  type OutboxEventRecord,
  type ResultCache,
  type SearchAdapterInput,
  type SearchAdapterResult,
  type SearchDocument,
  type SearchDocumentLoader,
  type SearchEngine,
  type SearchFilters,
  type SearchHit,
  type SearchIndexBatch,
  type SearchIndexBatchResult,
  type SearchIndexMutation,
  type SearchMutationFailure,
  type SearchMode,
  type QueryScope,
  type SearchSort,
} from "./types";
export {
  compareSearchVersions,
  InMemorySearchVersionStore,
  isStaleSearchVersion,
  SEARCH_SCHEMA_HASH,
  SEARCH_SCHEMA_HASH_V10,
  SEARCH_SCHEMA_HASH_V12,
  SEARCH_SCHEMA_HASH_V8,
  SearchIndexSchemaMismatchError,
  startSearchGeneration,
  ZERO_SEQUENCE,
  type SearchVersion,
  type SearchVersionCheckpoint,
  type SearchVersionStore,
  type StartSearchGenerationResult,
} from "./version";
