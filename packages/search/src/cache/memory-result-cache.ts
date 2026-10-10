import type { ResultCache, ResultCacheEntry } from "../types";
import { TtlLruCache } from "./ttl-lru-cache";

/**
 * Bounded per-process fallback (RJC-396): 500 entries is generous for a
 * dev/test process's realistic query+filter+page variety while keeping a
 * hard ceiling on memory. Redis (setEx, TTL-enforced) is the backend that
 * bounds a long-lived production process; this cap plus honest TTL is the
 * belt-and-suspenders for the case where the memory backend ever runs
 * unattended.
 */
export const MEMORY_RESULT_CACHE_MAX_ENTRIES = 500;

export class MemoryResultCache implements ResultCache {
  private readonly entries: TtlLruCache<ResultCacheEntry>;

  constructor(
    maxEntries: number = MEMORY_RESULT_CACHE_MAX_ENTRIES,
    clock?: () => number
  ) {
    this.entries = new TtlLruCache(maxEntries, clock);
  }

  get(key: string): Promise<ResultCacheEntry | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  set(key: string, entry: ResultCacheEntry, ttlSeconds: number): Promise<void> {
    this.entries.set(key, structuredClone(entry), ttlSeconds);
    return Promise.resolve();
  }
}
