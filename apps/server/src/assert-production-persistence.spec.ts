import { describe, expect, it } from "bun:test";

import { createMemorySliceAStores } from "@ji/application/registry";
import type { SliceAStores } from "@ji/application/registry";

import {
  assertProductionPersistence,
  VOLATILE_STORE_ALLOWLIST,
} from "./assert-production-persistence";

const wireStore = <K extends keyof SliceAStores>(
  base: SliceAStores,
  key: K
): SliceAStores => ({
  ...base,
  // A distinct object (not the memory-factory instance) stands in for a
  // Postgres-backed implementation: identity, not shape, is what matters.
  [key]: { wired: true },
});

describe("assertProductionPersistence", () => {
  it("does nothing outside production even with every store still in memory", () => {
    const memoryStores = createMemorySliceAStores();

    expect(() =>
      assertProductionPersistence({
        memoryStores,
        nodeEnv: "development",
        stores: memoryStores,
      })
    ).not.toThrow();

    expect(() =>
      assertProductionPersistence({
        memoryStores,
        nodeEnv: "test",
        stores: memoryStores,
      })
    ).not.toThrow();
  });

  it("throws in production naming an unallowlisted volatile store", () => {
    const memoryStores = createMemorySliceAStores();
    // "aanvragen" is not on the allowlist and has a real Postgres store in
    // production, so leaving it wired to memory must fail loudly.

    expect(() =>
      assertProductionPersistence({
        memoryStores,
        nodeEnv: "production",
        stores: memoryStores,
      })
    ).toThrow(/aanvragen/u);
  });

  it("passes in production once every non-allowlisted store is wired", () => {
    const memoryStores = createMemorySliceAStores();
    let stores: SliceAStores = memoryStores;
    // SAFETY: memoryStores is typed as SliceAStores, so Object.keys can
    // only return that interface's own property names.
    for (const key of Object.keys(memoryStores) as (keyof SliceAStores)[]) {
      if (!VOLATILE_STORE_ALLOWLIST.has(key)) {
        stores = wireStore(stores, key);
      }
    }

    expect(() =>
      assertProductionPersistence({
        memoryStores,
        nodeEnv: "production",
        stores,
      })
    ).not.toThrow();
  });

  it("catches a newly-added volatile store automatically, with no name list to update", () => {
    // Simulates the failure mode this assertion exists to prevent: a brand
    // new SliceAStores key ships and nobody wires it to Postgres. No
    // allowlist edit should be required to catch it.
    const memoryStores = createMemorySliceAStores();

    expect(() =>
      assertProductionPersistence({
        allowlist: new Set(),
        memoryStores,
        nodeEnv: "production",
        stores: memoryStores,
      })
    ).toThrow(/alerts/u);
  });

  it("fails when an allowlist entry is no longer actually volatile", () => {
    const memoryStores = createMemorySliceAStores();
    // Wire every store (including "alerts", which the allowlist still
    // claims is volatile) so the only violation left is the stale entry.
    let stores: SliceAStores = memoryStores;
    // SAFETY: memoryStores is typed as SliceAStores, so Object.keys can
    // only return that interface's own property names.
    for (const key of Object.keys(memoryStores) as (keyof SliceAStores)[]) {
      stores = wireStore(stores, key);
    }

    expect(() =>
      assertProductionPersistence({
        allowlist: new Set(["alerts"]),
        memoryStores,
        nodeEnv: "production",
        stores,
      })
    ).toThrow(/alerts/u);
  });
});
