import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { toQuerySnapshotRecord } from "./read-path-stores";
import type { querySnapshot } from "./schema";

const makeRow = (
  overrides: Partial<typeof querySnapshot.$inferSelect> = {}
): typeof querySnapshot.$inferSelect => ({
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  filters: {},
  id: "00000000-0000-4000-8000-000000000001",
  indexVersion: 1,
  parserVersion: "test-parser",
  queryText: "Azure",
  resultIds: ["00000000-0000-4000-8000-000000000002"],
  savedSearchId: null,
  schemaVersion: "test-schema",
  scopeId: "test-scope",
  searchAppliedSequence: 1n,
  searchGeneration: 1,
  searchScope: "active",
  userId: "test-user",
  ...overrides,
});

describe("toQuerySnapshotRecord", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("maps valid snapshot columns without warning", () => {
    const row = makeRow({
      filters: { queryScope: "title" },
      resultIds: ["result-1", "result-2"],
      searchScope: "all",
    });

    const record = toQuerySnapshotRecord(row);

    expect(record.filters).toEqual({ queryScope: "title" });
    expect(record.resultIds).toEqual(["result-1", "result-2"]);
    expect(record.scope).toBe("all");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back and warns when snapshot columns fail parsing", () => {
    const row = makeRow({
      filters: "not-an-object",
      resultIds: [1, 2],
      searchScope: "bogus",
    });

    const record = toQuerySnapshotRecord(row);

    expect(record.filters).toEqual({});
    expect(record.resultIds).toEqual([]);
    expect(record.scope).toBe("active");
    expect(warnSpy).toHaveBeenCalledTimes(3);

    const columns = new Set(["filters", "resultIds", "searchScope"]);
    for (const [argument] of warnSpy.mock.calls) {
      // SAFETY: toQuerySnapshotRecord serializes every warning argument as this payload.
      const payload = JSON.parse(String(argument)) as {
        column: string;
        event: string;
        issues: unknown[];
        snapshotId: string;
      };
      expect(payload.event).toBe("query_snapshot.column_parse_failed");
      expect(payload.snapshotId).toBe(row.id);
      expect(columns.has(payload.column)).toBe(true);
      expect(payload.issues.length).toBeGreaterThan(0);
    }
  });
});
