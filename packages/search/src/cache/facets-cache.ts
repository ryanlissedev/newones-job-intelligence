import type { SearchFacets } from "../types";
import { TtlLruCache } from "./ttl-lru-cache";

/**
 * Page-independent facets layer (RJC-388), keyed by buildFacetCacheKey
 * (astHash + version + filters, no sort/offset/limit). In-process only —
 * unlike the results cache, nothing in the ticket asks this to survive a
 * process restart or be shared across server instances.
 */
export interface FacetCache {
  get: (key: string) => Promise<SearchFacets | null>;
  set: (key: string, facets: SearchFacets, ttlSeconds: number) => Promise<void>;
}

/**
 * Same cap rationale as MEMORY_RESULT_CACHE_MAX_ENTRIES (RJC-396): 500
 * facets entries per process is generous for realistic query+filter
 * variety without an unbounded backend.
 */
export const MEMORY_FACET_CACHE_MAX_ENTRIES = 500;

export class MemoryFacetCache implements FacetCache {
  private readonly entries: TtlLruCache<SearchFacets>;

  constructor(
    maxEntries: number = MEMORY_FACET_CACHE_MAX_ENTRIES,
    clock?: () => number
  ) {
    this.entries = new TtlLruCache(maxEntries, clock);
  }

  get(key: string): Promise<SearchFacets | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  set(key: string, facets: SearchFacets, ttlSeconds: number): Promise<void> {
    this.entries.set(key, structuredClone(facets), ttlSeconds);
    return Promise.resolve();
  }
}
