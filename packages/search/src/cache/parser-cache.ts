import type { BooleanParseResult } from "@ji/domain";

/** Named eviction cap for the in-process parser cache (RJC-388). */
export const PARSER_CACHE_MAX_ENTRIES = 500;

/**
 * Query text -> parsed AST, unbounded until the LRU cap evicts. Never keyed
 * by search version: the parse of a query string doesn't change when the
 * index does, only the search result does (that's the results/facets
 * caches' job). In-process only — Redis buys nothing here since re-parsing
 * is cheap CPU work, not a shared external computation.
 *
 * ponytail: insertion-order Map as the LRU — delete+re-set moves an entry
 * to most-recently-used, and Map iteration order is insertion order, so the
 * first key is always the least-recently-used one. Good enough at cache
 * sizes in the hundreds; swap for a proper LRU structure if this cache ever
 * needs to hold tens of thousands of entries.
 */
export class ParserLruCache {
  private readonly entries = new Map<string, BooleanParseResult>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = PARSER_CACHE_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(query: string): BooleanParseResult | undefined {
    const hit = this.entries.get(query);
    if (hit) {
      this.entries.delete(query);
      this.entries.set(query, hit);
    }
    return hit;
  }

  set(query: string, result: BooleanParseResult): void {
    this.entries.delete(query);
    this.entries.set(query, result);
    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
