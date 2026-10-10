import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  InMemorySearchEngine,
  SearchAdapter,
  SEARCH_DOCUMENT_PARITY_DEFAULTS,
} from "@ji/search";

import { readRecords } from "./core";

describe("search critical path integration", () => {
  test("SearchAdapter emits in-process records when PERF_CRITICAL_PATH is enabled", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ji-search-critical-path-")
    );
    process.env.PERF_METRICS_DIR = directory;
    process.env.PERF_CRITICAL_PATH = "1";

    try {
      const engine = new InMemorySearchEngine();
      await engine.upsertDocument({
        ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
        beschrijving: "Azure platform engineer",
        bronId: "bron-1",
        contracttype: "detachering",
        id: "doc-1",
        laatstGezienOp: new Date(),
        locatieLand: "NL",
        status: "active",
        tariefMax: 120,
        tariefMin: 80,
        titel: "Platform engineer",
      });
      const adapter = new SearchAdapter({ engine });
      const result = await adapter.search({ query: "azure" });
      expect(result.ok).toBe(true);

      const records = await readRecords(directory);
      const labels = records.map((record) => record.label);
      expect(labels).toContain("search-parser");
      expect(labels).toContain("search-engine");
      expect(records.some((record) => record.metadata["queryset-digest"])).toBe(
        true
      );
      expect(records.some((record) => record.metadata["result-digest"])).toBe(
        true
      );
    } finally {
      delete process.env.PERF_METRICS_DIR;
      delete process.env.PERF_CRITICAL_PATH;
      await rm(directory, { force: true, recursive: true });
    }
  });
});
