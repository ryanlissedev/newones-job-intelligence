import { afterEach, describe, expect, it } from "bun:test";

import { SEARCH_PARTITIONS, partitionTable } from "../partition";
import { SEARCH_INDEX_NAME, SEARCH_TEST_INDEX_NAME } from "../types";
import { InMemorySearchVersionStore } from "../version";
import { ManticoreSearchEngine } from "./engine";
import {
  assertLiveTestTablesReady,
  cleanupLiveDocuments,
  createSqlSchemaReader,
  createLiveTestEngine,
  LIVE_TEST_REQUIRED_COLUMNS,
  requireLiveManticoreUrl,
} from "./live-test-hygiene";
import type { LiveTableSchemaReader } from "./live-test-hygiene";

const originalFetch = globalThis.fetch;
const LIVE_INDEX = "aanvragen_test_live";
const LIVE_TABLES = [
  partitionTable(LIVE_INDEX, SEARCH_PARTITIONS[0]),
  partitionTable(LIVE_INDEX, SEARCH_PARTITIONS[1]),
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const readerFor = (
  tables: ReadonlyMap<string, ReadonlySet<string> | null>
): LiveTableSchemaReader => ({
  describeTable: (table) => Promise.resolve(tables.get(table) ?? null),
});

const stubShowTables = (tables: readonly string[]): void => {
  // SAFETY: this stub only exercises the SHOW TABLES fetch shape used by the
  // readiness preflight; the schema reader is injected separately.
  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    void input;
    void init;
    return Promise.resolve(
      Response.json([
        {
          data: tables.map((Index) => ({ Index, Type: "rt" })),
        },
      ])
    );
  }) as typeof fetch;
};

describe("Manticore live fixture cleanup", () => {
  it("fails when a required live lane has no URL", () => {
    expect(() => requireLiveManticoreUrl(undefined, true)).toThrow(
      "requires a non-empty MANTICORE_URL"
    );
    expect(requireLiveManticoreUrl(" http://manticore.test ", true)).toBe(
      "http://manticore.test"
    );
  });

  it("refuses to preflight tables without a live URL", async () => {
    await expect(
      assertLiveTestTablesReady(undefined, "aanvragen_test_x")
    ).rejects.toThrow("requires a live MANTICORE_URL");
  });

  it("attempts every run-owned id when one deletion fails", async () => {
    const deleted: string[] = [];
    const engine = {
      deleteDocument: (id: string) => {
        deleted.push(id);
        if (id === "run-b") {
          return Promise.reject(new Error("delete failed"));
        }
        return Promise.resolve();
      },
    };

    const cleanup = cleanupLiveDocuments(engine, ["run-a", "run-b", "run-c"]);
    await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
    await expect(cleanup).rejects.toThrow("fixture cleanup failed");
    expect(deleted.toSorted()).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("treats 409 and Conflict deletions as already gone", async () => {
    const deleted: string[] = [];
    const engine = {
      deleteDocument: (id: string) => {
        deleted.push(id);
        if (id === "run-b") {
          return Promise.reject(
            new Error("Manticore request failed (409): Conflict")
          );
        }
        if (id === "run-c") {
          return Promise.reject(new Error("Conflict"));
        }
        return Promise.resolve();
      },
    };

    await expect(
      cleanupLiveDocuments(engine, ["run-a", "run-b", "run-c"])
    ).resolves.toBeUndefined();
    expect(deleted).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("keeps the live-test index name distinct from production", () => {
    expect(SEARCH_TEST_INDEX_NAME).toBe("aanvragen_test");
    expect(SEARCH_TEST_INDEX_NAME).not.toBe(SEARCH_INDEX_NAME);
    const engine = createLiveTestEngine(
      "http://manticore.test",
      new InMemorySearchVersionStore(),
      SEARCH_TEST_INDEX_NAME
    );
    expect(engine).toBeInstanceOf(ManticoreSearchEngine);
  });

  it("rejects the production index and accepts a test index", () => {
    const store = new InMemorySearchVersionStore();

    expect(() => createLiveTestEngine("http://x", store, "aanvragen")).toThrow(
      'starting with "aanvragen_test"'
    );
    expect(() =>
      createLiveTestEngine("http://x", store, "aanvragen_test_x")
    ).not.toThrow();
  });
});

describe("Manticore live table preflight", () => {
  const completeColumns: ReadonlySet<string> = new Set(
    LIVE_TEST_REQUIRED_COLUMNS
  );

  it("resolves when both live tables have the required columns", async () => {
    stubShowTables(LIVE_TABLES);
    const reader = readerFor(
      new Map(LIVE_TABLES.map((table) => [table, completeColumns]))
    );

    await expect(
      assertLiveTestTablesReady("http://manticore.test", LIVE_INDEX, reader)
    ).resolves.toBeUndefined();
  });

  it("reports missing skills with the volume recreation remedy", async () => {
    stubShowTables(LIVE_TABLES);
    const missingSkills: ReadonlySet<string> = new Set(
      LIVE_TEST_REQUIRED_COLUMNS.filter((column) => column !== "skills")
    );
    const reader = readerFor(
      new Map([
        [LIVE_TABLES[0], missingSkills],
        [LIVE_TABLES[1], completeColumns],
      ])
    );

    await expect(
      assertLiveTestTablesReady("http://manticore.test", LIVE_INDEX, reader)
    ).rejects.toThrow(/skills.*manticore_data/su);
  });

  it("aggregates missing columns from both live tables", async () => {
    stubShowTables(LIVE_TABLES);
    const missingSkills: ReadonlySet<string> = new Set(
      LIVE_TEST_REQUIRED_COLUMNS.filter((column) => column !== "skills")
    );
    const missingTitel: ReadonlySet<string> = new Set(
      LIVE_TEST_REQUIRED_COLUMNS.filter((column) => column !== "titel")
    );
    const reader = readerFor(
      new Map([
        [LIVE_TABLES[0], missingSkills],
        [LIVE_TABLES[1], missingTitel],
      ])
    );

    await expect(
      assertLiveTestTablesReady("http://manticore.test", LIVE_INDEX, reader)
    ).rejects.toThrow(new RegExp(`${LIVE_TABLES[0]}.*${LIVE_TABLES[1]}`, "su"));
  });

  it("reads DESCRIBE fields and recognizes an absent table", async () => {
    // SAFETY: this stub only exercises the fetch call shape used by the
    // schema reader; no other global fetch overload is needed here.
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      void input;
      if (String(init?.body).includes("DESCRIBE%20missing")) {
        return Promise.resolve(
          Response.json({ error: "no such table 'missing'" }, { status: 500 })
        );
      }
      return Promise.resolve(
        Response.json([
          {
            data: [
              { Field: "skills", Properties: "", Type: "json" },
              { Field: "titel", Properties: "", Type: "text" },
            ],
          },
        ])
      );
    }) as typeof fetch;

    const reader = createSqlSchemaReader("http://manticore.test");
    await expect(
      reader.describeTable("aanvragen_test_live_active")
    ).resolves.toEqual(new Set(["skills", "titel"]));
    await expect(reader.describeTable("missing")).resolves.toBeNull();
  });
});
