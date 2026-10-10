import { describe, expect, it } from "bun:test";

import { emptySearchFacets } from "../types";
import type { ResultCacheEntry } from "../types";
import { MemoryResultCache } from "./memory-result-cache";

const makeEntry = (id: string): ResultCacheEntry => ({
  astHash: id,
  facets: emptySearchFacets(),
  filters: {},
  hits: [],
  indexVersion: 1,
  scope: "active",
  total: 0,
  windowLimit: 20,
});

describe("MemoryResultCache bounds (RJC-396)", () => {
  it("evicts the oldest entry once the configured cap is exceeded", async () => {
    const cache = new MemoryResultCache(2, () => 0);
    await cache.set("a", makeEntry("a"), 60);
    await cache.set("b", makeEntry("b"), 60);
    await cache.set("c", makeEntry("c"), 60);

    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  it("does not serve an entry past its TTL", async () => {
    let now = 0;
    const cache = new MemoryResultCache(10, () => now);
    await cache.set("a", makeEntry("a"), 60);

    now = 61_000;
    expect(await cache.get("a")).toBeNull();
  });
});
