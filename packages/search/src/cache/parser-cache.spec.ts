import { describe, expect, it } from "bun:test";

import { parseBooleanQuery } from "@ji/domain";

import { ParserLruCache } from "./parser-cache";

describe("ParserLruCache (RJC-388)", () => {
  it("returns undefined for a query it hasn't seen", () => {
    const cache = new ParserLruCache(2);
    expect(cache.get("Azure")).toBeUndefined();
  });

  it("returns the cached parse result for an exact query match", () => {
    const cache = new ParserLruCache(2);
    const parsed = parseBooleanQuery("Azure AND platform");
    cache.set("Azure AND platform", parsed);
    expect(cache.get("Azure AND platform")).toBe(parsed);
  });

  it("evicts the least-recently-used entry once the cap is exceeded", () => {
    const cache = new ParserLruCache(2);
    cache.set("a", parseBooleanQuery("a"));
    cache.set("b", parseBooleanQuery("b"));
    // A third insert past the cap of 2 evicts "a", the least-recently-used.
    cache.set("c", parseBooleanQuery("c"));

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("touching an entry via get() protects it from the next eviction", () => {
    const cache = new ParserLruCache(2);
    cache.set("a", parseBooleanQuery("a"));
    cache.set("b", parseBooleanQuery("b"));
    // Reading "a" makes it more-recently-used than "b".
    cache.get("a");
    // So this insert past the cap evicts "b", not "a".
    cache.set("c", parseBooleanQuery("c"));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });
});
