import { describe, expect, it } from "bun:test";

import {
  compareSearchVersions,
  InMemorySearchVersionStore,
  isStaleSearchVersion,
  resolveSearchSchemaHash,
  SEARCH_SCHEMA_HASH,
  SEARCH_SCHEMA_HASH_HYBRID,
  SEARCH_SCHEMA_HASH_HYBRID_V11,
  SEARCH_SCHEMA_HASH_HYBRID_V7,
  SEARCH_SCHEMA_HASH_V1,
  SEARCH_SCHEMA_HASH_V4,
  SEARCH_SCHEMA_HASH_V6,
  SEARCH_SCHEMA_HASH_V8,
  SEARCH_SCHEMA_HASH_V10,
  SEARCH_SCHEMA_HASH_V12,
  startSearchGeneration,
} from "./version";

describe("SearchVersion comparison", () => {
  it("detects a version with an older generation as stale", () => {
    const older = { appliedSequence: 500n, generation: 1 };
    const current = { appliedSequence: 0n, generation: 2 };

    expect(isStaleSearchVersion(older, current)).toBe(true);
    expect(isStaleSearchVersion(current, older)).toBe(false);
  });

  it("orders by generation first, then applied sequence", () => {
    expect(
      compareSearchVersions(
        { appliedSequence: 9n, generation: 1 },
        { appliedSequence: 1n, generation: 2 }
      )
    ).toBe(-1);
    expect(
      compareSearchVersions(
        { appliedSequence: 1n, generation: 1 },
        { appliedSequence: 2n, generation: 1 }
      )
    ).toBe(-1);
    expect(
      compareSearchVersions(
        { appliedSequence: 2n, generation: 1 },
        { appliedSequence: 2n, generation: 1 }
      )
    ).toBe(0);
  });
});

describe("InMemorySearchVersionStore", () => {
  it("never moves the checkpoint backwards", async () => {
    const store = new InMemorySearchVersionStore();
    await store.advance(10n);
    const version = await store.advance(4n);

    expect(version.appliedSequence).toBe(10n);
  });

  it("a full rebuild produces a new generation and resets the sequence", async () => {
    const store = new InMemorySearchVersionStore();
    await store.advance(10n);
    const rebuilt = await store.startNewGeneration("aanvragen-v2");

    expect(rebuilt).toEqual({ appliedSequence: 0n, generation: 2 });
    const checkpoint = await store.read();
    expect(checkpoint.schemaHash).toBe("aanvragen-v2");
  });
});

// RJC-378 added the locatie and sluitingsdatum attributes. A checkpoint still
// stamped with the v1 mapping must read as a mismatch (the outbox drain
// throws SearchIndexSchemaMismatchError on it) so the index is rebuilt in a
// new generation rather than queried for attributes it does not have.
describe("SEARCH_SCHEMA_HASH mapping generations", () => {
  it("differs from the pre-locatie/sluitingsdatum mapping and names both attributes", () => {
    expect(SEARCH_SCHEMA_HASH).not.toBe(SEARCH_SCHEMA_HASH_V1);
    expect(SEARCH_SCHEMA_HASH).toContain("locatie,");
    expect(SEARCH_SCHEMA_HASH).toContain("sluitingsdatum");
    expect(SEARCH_SCHEMA_HASH).toContain("projection_hash");
    expect(SEARCH_SCHEMA_HASH).toContain("locatie=nullable-omitted");
    expect(SEARCH_SCHEMA_HASH).toContain("locatie_land=nullable-omitted");
  });

  it("requires a new generation for the skills mapping", () => {
    expect(SEARCH_SCHEMA_HASH).toBe(SEARCH_SCHEMA_HASH_V12);
    expect(SEARCH_SCHEMA_HASH).not.toBe(SEARCH_SCHEMA_HASH_V8);
    expect(SEARCH_SCHEMA_HASH).not.toBe(SEARCH_SCHEMA_HASH_V6);
    expect(SEARCH_SCHEMA_HASH).not.toBe(SEARCH_SCHEMA_HASH_V4);
    expect(SEARCH_SCHEMA_HASH).not.toBe(SEARCH_SCHEMA_HASH_V10);
    expect(SEARCH_SCHEMA_HASH).toContain("opdrachtgever_naam");
    expect(SEARCH_SCHEMA_HASH).toContain("publicatiedatum");
    expect(SEARCH_SCHEMA_HASH).toContain("werkvorm");
    expect(SEARCH_SCHEMA_HASH).toContain("uren_per_week_min");
    expect(SEARCH_SCHEMA_HASH).toContain("tarief_eenheid");
    expect(SEARCH_SCHEMA_HASH).toContain("skills=json-array");
  });

  it("requires a new generation and replay for a checkpoint written by v6", async () => {
    const stale = new InMemorySearchVersionStore(SEARCH_SCHEMA_HASH_V6);
    await stale.advance(42n);
    const checkpoint = await stale.read();

    expect(checkpoint.schemaHash === SEARCH_SCHEMA_HASH).toBe(false);

    const rebuilt = await stale.startNewGeneration(SEARCH_SCHEMA_HASH);
    expect(rebuilt.generation).toBe(2);
    expect(rebuilt.appliedSequence).toBe(0n);
    const current = await stale.read();
    expect(current.schemaHash).toBe(SEARCH_SCHEMA_HASH);
  });

  it("still rejects the v1 mapping", async () => {
    const stale = new InMemorySearchVersionStore(SEARCH_SCHEMA_HASH_V1);
    const checkpoint = await stale.read();

    expect(checkpoint.schemaHash === SEARCH_SCHEMA_HASH).toBe(false);
    await stale.startNewGeneration(SEARCH_SCHEMA_HASH);
    const current = await stale.read();
    expect(current.schemaHash).toBe(SEARCH_SCHEMA_HASH);
  });
});

describe("SEARCH_SCHEMA_HASH hybrid feature flag", () => {
  it("keeps the current lexical schema when the flag is absent or off", () => {
    expect(resolveSearchSchemaHash()).toBe(SEARCH_SCHEMA_HASH_V12);
    expect(resolveSearchSchemaHash("0")).toBe(SEARCH_SCHEMA_HASH_V12);
    expect(resolveSearchSchemaHash("true")).toBe(SEARCH_SCHEMA_HASH_V12);
  });

  it("selects a new vector and wordforms schema only for SEARCH_HYBRID=1", () => {
    expect(resolveSearchSchemaHash("1")).toBe(SEARCH_SCHEMA_HASH_HYBRID);
    expect(SEARCH_SCHEMA_HASH_HYBRID).not.toBe(SEARCH_SCHEMA_HASH_HYBRID_V7);
    expect(SEARCH_SCHEMA_HASH_HYBRID).toStartWith("aanvragen-v13[");
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain("skills=json-array");
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain("locatie=nullable-omitted");
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain(
      "locatie_land=nullable-omitted"
    );
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain("embedding=hnsw/cosine");
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain(
      "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    );
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain("from:titel+beschrijving");
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain("gemeenten>gemeent");
    expect(SEARCH_SCHEMA_HASH_HYBRID).toContain("duurzame>duurzaam");
  });

  it("requires a new generation and replay for a checkpoint written by hybrid v7", async () => {
    const stale = new InMemorySearchVersionStore(SEARCH_SCHEMA_HASH_HYBRID_V11);
    await stale.advance(42n);
    const checkpoint = await stale.read();

    expect(checkpoint.schemaHash).toBe(SEARCH_SCHEMA_HASH_HYBRID_V11);
    expect(checkpoint.schemaHash).not.toBe(SEARCH_SCHEMA_HASH_HYBRID);

    const rebuilt = await stale.startNewGeneration(SEARCH_SCHEMA_HASH_HYBRID);
    expect(rebuilt).toEqual({ appliedSequence: 0n, generation: 2 });
    const current = await stale.read();
    expect(current.schemaHash).toBe(SEARCH_SCHEMA_HASH_HYBRID);
  });
});

describe("startSearchGeneration (operator path)", () => {
  it("moves a v1 checkpoint to generation 2 with the new hash", async () => {
    const store = new InMemorySearchVersionStore(SEARCH_SCHEMA_HASH_V1);
    await store.advance(42n);

    const result = await startSearchGeneration(store, SEARCH_SCHEMA_HASH);

    expect(result.previous.generation).toBe(1);
    expect(result.previous.schemaHash).toBe(SEARCH_SCHEMA_HASH_V1);
    expect(result.next).toEqual({ appliedSequence: 0n, generation: 2 });
    const checkpoint = await store.read();
    expect(checkpoint.schemaHash).toBe(SEARCH_SCHEMA_HASH);
  });

  it("refuses to bump again for the same hash unless forced", async () => {
    const store = new InMemorySearchVersionStore(SEARCH_SCHEMA_HASH);

    const refused = await startSearchGeneration(store, SEARCH_SCHEMA_HASH);
    expect(refused.next).toBeNull();
    const unchanged = await store.read();
    expect(unchanged.generation).toBe(1);

    const forced = await startSearchGeneration(store, SEARCH_SCHEMA_HASH, {
      force: true,
    });
    expect(forced.next?.generation).toBe(2);
  });
});
