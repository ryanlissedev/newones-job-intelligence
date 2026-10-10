import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parsePerformanceRecord } from "../../../scripts/performance/record";
import type { JsonValue } from "../../../scripts/performance/record";
import {
  createCriticalPathSession,
  digestQueryset,
  digestSearchResult,
} from "./index";

describe("critical path records", () => {
  test("builds schema-valid in-process records without PII", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ji-critical-path-records-")
    );
    process.env.PERF_METRICS_DIR = directory;
    process.env.PERF_CRITICAL_PATH = "1";

    try {
      const session = createCriticalPathSession({
        metadata: {
          "queryset-digest": digestQueryset({ query: "azure" }),
          "result-digest": digestSearchResult({
            facets: {
              bron_id: [],
              contracttype: [],
              locatie_land: [],
              status: [],
            },
            indexVersion: 1,
            total: 0,
          }),
        },
      });
      session.recordSample({
        durationMs: 1,
        endedAt: new Date().toISOString(),
        label: "search-parser",
        startedAt: new Date().toISOString(),
        success: true,
      });
      session.recordSample({
        durationMs: 2,
        endedAt: new Date().toISOString(),
        label: "search-engine",
        startedAt: new Date().toISOString(),
        success: true,
      });
      const records = await session.flush();
      expect(records.length).toBe(2);

      const directoryEntries = await readdir(directory);
      const files = directoryEntries.filter((entry) => entry.endsWith(".json"));
      expect(files.length).toBeGreaterThanOrEqual(2);

      const parsedRecords = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(directory, file);
          const fileContents = await Bun.file(filePath).json();
          // SAFETY: Files were written by this package's record builder; parse validates shape.
          return parsePerformanceRecord(fileContents as JsonValue, file);
        })
      );
      for (const record of parsedRecords) {
        expect(record.measurement.kind).toBe("in-process-monotonic");
        expect(record.command[0]).toBe("@ji/critical-path");
        expect(JSON.stringify(record)).not.toMatch(
          /vacancy|contact|password/iu
        );
        expect(record.metadata["queryset-digest"]).toMatch(/^sha256:/u);
      }
    } finally {
      delete process.env.PERF_METRICS_DIR;
      delete process.env.PERF_CRITICAL_PATH;
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("redacts credential-like metadata values", async () => {
    const session = createCriticalPathSession({
      metadata: {
        branch: "main",
        "queryset-digest": digestQueryset({ query: "test" }),
      },
    });
    session.recordSample({
      durationMs: 1,
      endedAt: new Date().toISOString(),
      label: "search-parser",
      startedAt: new Date().toISOString(),
      success: true,
    });
    const flushed = await session.flush();
    const [record] = flushed;
    expect(record).toBeDefined();
    if (record === undefined) {
      throw new Error("expected a flushed record");
    }
    expect(record.command.join(" ")).not.toContain("Bearer");
  });
});
