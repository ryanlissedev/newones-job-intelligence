import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { InMemorySearchEngine, SearchAdapter } from "@ji/search";
import type { SearchDocument } from "@ji/search";

import type { CorpusRecord } from "./generate-corpus";
import { generateCorpus, parseArgs } from "./generate-corpus";
import profile from "./profile.json";

const SAMPLE_SIZE = 5000;
const SAMPLE_SEED = 1337;
const BENCH_DOC_ID_PATTERN = /^bench-doc-\d+$/u;
const LOCATIE_LAND_PATTERN = /^(?<land>NL|BE)$/u;

const hashOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const serialize = (records: CorpusRecord[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n");

const toSearchDocuments = (records: CorpusRecord[]): SearchDocument[] =>
  records.map((record) => ({
    ...record,
    laatstGezienOp: new Date(record.laatstGezienOp),
  }));

describe("generateCorpus", () => {
  it("is deterministic for a fixed seed (identical output hashes)", () => {
    const first = serialize([...generateCorpus({ documents: 2000, seed: 42 })]);
    const second = serialize([
      ...generateCorpus({ documents: 2000, seed: 42 }),
    ]);

    expect(hashOf(first)).toBe(hashOf(second));
  });

  it("produces the requested number of records with synthetic ids", () => {
    const records = [...generateCorpus({ documents: 500, seed: 7 })];
    expect(records).toHaveLength(500);
    for (const record of records) {
      expect(record.id).toMatch(BENCH_DOC_ID_PATTERN);
      expect(record.locatieLand).toMatch(LOCATIE_LAND_PATTERN);
    }
  });

  it("matches each profile query for roughly 1-15% of a 5k sample", async () => {
    const records = [
      ...generateCorpus({ documents: SAMPLE_SIZE, seed: SAMPLE_SEED }),
    ];
    const documents = toSearchDocuments(records);

    const engine = new InMemorySearchEngine();
    await Promise.all(
      documents.map((document) => engine.upsertDocument(document))
    );
    await engine.applyBatch({ appliedSequence: 1n, mutations: [] });
    const adapter = new SearchAdapter({ engine });

    const results = await Promise.all(
      profile.queries.map(async (query) => ({
        query,
        result: await adapter.search({
          filters: { queryScope: "all" },
          query: query.query,
        }),
      }))
    );

    for (const { query, result } of results) {
      if (!result.ok) {
        throw new Error(
          `Query ${query.id} failed to parse: ${result.error.message}`
        );
      }

      const ratio = result.total / SAMPLE_SIZE;
      expect(ratio).toBeGreaterThanOrEqual(0.01);
      expect(ratio).toBeLessThanOrEqual(0.15);
    }
  });
});

describe("parseArgs --documents validation", () => {
  it("rejects a non-numeric value", () => {
    expect(() => parseArgs(["--documents", "nope"])).toThrow();
  });

  it("rejects a negative value", () => {
    expect(() => parseArgs(["--documents", "-5"])).toThrow();
  });

  it("rejects a non-integer value", () => {
    expect(() => parseArgs(["--documents", "1.5"])).toThrow();
  });

  it("rejects a value above the cap", () => {
    expect(() => parseArgs(["--documents", "5000001"])).toThrow();
  });

  it("accepts zero and a valid count", () => {
    expect(parseArgs(["--documents", "0"]).documents).toBe(0);
    expect(parseArgs(["--documents", "500"]).documents).toBe(500);
  });
});

describe("parseArgs --seed validation", () => {
  it("rejects a non-numeric value", () => {
    expect(() => parseArgs(["--seed", "nope"])).toThrow();
  });

  it("rejects a negative value", () => {
    expect(() => parseArgs(["--seed", "-1"])).toThrow();
  });

  it("rejects a non-integer value", () => {
    expect(() => parseArgs(["--seed", "1.5"])).toThrow();
  });

  it("rejects a value above uint32 max (mulberry32's >>> 0 range)", () => {
    expect(() => parseArgs(["--seed", "4294967296"])).toThrow();
  });

  it("accepts a valid seed and echoes the validated integer", () => {
    expect(parseArgs(["--seed", "42"]).seed).toBe(42);
    expect(parseArgs(["--seed", "4294967295"]).seed).toBe(4_294_967_295);
  });
});
