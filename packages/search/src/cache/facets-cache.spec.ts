import { describe, expect, it } from "bun:test";

import { emptySearchFacets } from "../types";
import { MemoryFacetCache } from "./facets-cache";

describe("MemoryFacetCache bounds (RJC-396)", () => {
  it("evicts the oldest entry once the configured cap is exceeded", async () => {
    const cache = new MemoryFacetCache(2, () => 0);
    await cache.set("a", emptySearchFacets(), 60);
    await cache.set("b", emptySearchFacets(), 60);
    await cache.set("c", emptySearchFacets(), 60);

    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  it("does not serve an entry past its TTL", async () => {
    let now = 0;
    const cache = new MemoryFacetCache(10, () => now);
    await cache.set("a", emptySearchFacets(), 60);

    now = 61_000;
    expect(await cache.get("a")).toBeNull();
  });
});
