import { describe, expect, it } from "bun:test";

import { InMemoryKnownHashStore, shouldSkipFetch } from "./known-hash";

const bronId = "bron-known-hash-spec";

describe("shouldSkipFetch", () => {
  it("never skips without a store", async () => {
    expect(await shouldSkipFetch(undefined, bronId, "ref", "hash")).toBe(false);
  });

  it("never skips when no hash is persisted", async () => {
    const store = new InMemoryKnownHashStore();
    expect(await shouldSkipFetch(store, bronId, "ref", "hash")).toBe(false);
  });

  it("never skips when the store yields null", async () => {
    const store = { get: () => Promise.resolve(null) };
    expect(await shouldSkipFetch(store, bronId, "ref", "hash")).toBe(false);
  });

  it("skips only when the persisted hash equals the content hash", async () => {
    const store = new InMemoryKnownHashStore();
    store.set(bronId, "ref", "hash");
    expect(await shouldSkipFetch(store, bronId, "ref", "hash")).toBe(true);
    expect(await shouldSkipFetch(store, bronId, "ref", "other")).toBe(false);
    expect(await shouldSkipFetch(store, bronId, "other-ref", "hash")).toBe(
      false
    );
  });
});
