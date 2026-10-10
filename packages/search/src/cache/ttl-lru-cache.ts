const MILLISECONDS_PER_SECOND = 1000;

interface TtlLruEntry<V> {
  expiresAt: number;
  value: V;
}

/**
 * Bounded, TTL-aware LRU shared by MemoryResultCache and MemoryFacetCache
 * (RJC-396). Both were previously unbounded and TTL-blind: every index
 * generation's entries sat in the Map forever in a long-lived non-Redis
 * process. Redis (setEx) is the backend that actually bounds production;
 * this gives the in-process fallback the same two properties so it can't
 * grow unbounded if it ever runs unattended without Redis.
 *
 * Expiry is lazy (checked on `get`/`set`, no background timer) — the
 * simplest thing that makes an expired entry unreadable and evictable.
 * `clock` is injectable so tests can assert TTL expiry without depending
 * on real wall-clock time.
 */
export class TtlLruCache<V> {
  private readonly clock: () => number;
  private readonly entries = new Map<string, TtlLruEntry<V>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number, clock: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.clock = clock;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return;
    }
    // Refresh recency: Map iteration order is insertion order, so a
    // delete+set on hit is what makes the first key in iteration order
    // the least-recently-used one for eviction below.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlSeconds: number): void {
    this.entries.delete(key);
    this.entries.set(key, {
      expiresAt: this.clock() + ttlSeconds * MILLISECONDS_PER_SECOND,
      value,
    });

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
