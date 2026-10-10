import { describe, expect, it } from "bun:test";

import { TtlLruCache } from "./ttl-lru-cache";

/** Injected clock (RJC-396): tests never depend on real wall-clock time. */
const makeClock = (startMs: number) => {
  let now = startMs;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
};

describe("TtlLruCache (RJC-396)", () => {
  it("evicts the oldest entry once the cap is exceeded", () => {
    const cache = new TtlLruCache<string>(2, () => 0);
    cache.set("a", "A", 60);
    cache.set("b", "B", 60);
    cache.set("c", "C", 60);

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("treats a get as a recency touch, so a recently-read entry survives eviction", () => {
    const cache = new TtlLruCache<string>(2, () => 0);
    cache.set("a", "A", 60);
    cache.set("b", "B", 60);
    // Touch "a" — "b" is now the least-recently-used one.
    cache.get("a");
    cache.set("c", "C", 60);

    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("C");
  });

  it("treats a TTL-expired entry as a miss", () => {
    const clock = makeClock(0);
    const cache = new TtlLruCache<string>(10, clock.now);
    cache.set("a", "A", 60);

    clock.advance(59_000);
    expect(cache.get("a")).toBe("A");

    // Now 61s later — past the 60s TTL.
    clock.advance(2000);
    expect(cache.get("a")).toBeUndefined();
  });

  it("makes an expired entry evictable: it does not keep counting against the cap", () => {
    const clock = makeClock(0);
    const cache = new TtlLruCache<string>(1, clock.now);
    cache.set("a", "A", 1);
    clock.advance(2000);

    cache.set("b", "B", 60);

    // "a" expired, so "b" is a fresh insert into a cache with room, not an
    // eviction of a still-live "a".
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
    expect(cache.size).toBe(1);
  });
});
