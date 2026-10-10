import { describe, expect, it, mock } from "bun:test";

import {
  acquireManticoreBenchmarkLocks,
  assertCleanManticoreTables,
  cleanupAndAssertManticoreTables,
  cleanupBenchmarkRuns,
  cleanupManticoreDocuments,
  countManticoreRows,
  MANTICORE_BENCH_HYBRID_TABLES,
  MANTICORE_BENCH_TABLES,
  requireManticoreUrl,
  scopeBenchmarkDocuments,
} from "./manticore-hygiene";

const countResponse = (count: number): Response =>
  Response.json([{ data: [{ "count(*)": count }] }]);

describe("Manticore benchmark hygiene", () => {
  it("serializes ownership of the same target across benchmark runs", async () => {
    const release = await acquireManticoreBenchmarkLocks([
      "http://manticore-lock.test:9308/path-one",
      "http://manticore-lock.test:9308/path-two",
    ]);
    try {
      await expect(
        acquireManticoreBenchmarkLocks(["http://manticore-lock.test:9308"])
      ).rejects.toThrow("Another benchmark process owns");
    } finally {
      await release();
    }

    const releaseAfter = await acquireManticoreBenchmarkLocks([
      "http://manticore-lock.test:9308",
    ]);
    await releaseAfter();
  });

  it("counts both dedicated tables with SELECT COUNT(*) and accepts zero rows", async () => {
    const request = mock((_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain(
        "SELECT%20COUNT(*)%20FROM%20aanvragen_bench_"
      );
      return Promise.resolve(countResponse(0));
    });

    await assertCleanManticoreTables(
      "benchmark",
      "http://manticore.test",
      "before",
      request
    );

    expect(request).toHaveBeenCalledTimes(MANTICORE_BENCH_TABLES.length);
  });

  it("rejects a dirty table", async () => {
    let calls = 0;
    const request = mock(() => {
      calls += 1;
      return Promise.resolve(countResponse(calls === 1 ? 2 : 0));
    });

    await expect(
      assertCleanManticoreTables(
        "benchmark",
        "http://manticore.test",
        "after",
        request
      )
    ).rejects.toThrow("aanvragen_bench_active=2");
  });

  it("checks the combined logical table for a hybrid schema", async () => {
    const queriedTables: string[] = [];
    const request = mock((_url: string | URL | Request, init?: RequestInit) => {
      queriedTables.push(decodeURIComponent(String(init?.body)));
      return Promise.resolve(countResponse(0));
    });

    await assertCleanManticoreTables(
      "hybrid benchmark",
      "http://manticore.test",
      "before",
      request,
      MANTICORE_BENCH_HYBRID_TABLES
    );

    expect(request).toHaveBeenCalledTimes(MANTICORE_BENCH_HYBRID_TABLES.length);
    expect(queriedTables).toContain(
      "query=SELECT COUNT(*) FROM aanvragen_bench"
    );
  });

  it.each(["", " ", true, {}, "1.0", 1.5, -1, "01", "+1"])(
    "rejects non-canonical COUNT value %p",
    async (value) => {
      const request = mock(() =>
        Promise.resolve(Response.json([{ data: [{ "count(*)": value }] }]))
      );
      await expect(
        assertCleanManticoreTables(
          "benchmark",
          "http://manticore.test",
          "before",
          request
        )
      ).rejects.toThrow("Invalid row count");
    }
  );

  it("accepts canonical numeric and decimal-string COUNT values", async () => {
    await Promise.all(
      [0, 12, "0", "12"].map(async (value) => {
        const request = mock(async () => {
          await Bun.sleep(0);
          return Response.json([{ data: [{ "count(*)": value }] }]);
        });
        await expect(
          countManticoreRows("http://manticore.test", request)
        ).resolves.toEqual({
          aanvragen_bench_active: Number(value),
          aanvragen_bench_archive: Number(value),
        });
      })
    );
  });

  it("sends every run-owned id through bounded bulk cleanup", async () => {
    const deleted: string[] = [];
    const engine = {
      applyBatch: (batch: { mutations: { id: string }[] }) => {
        deleted.push(...batch.mutations.map((mutation) => mutation.id));
        return Promise.resolve({ failures: [], unapplied: [] });
      },
    };

    await cleanupManticoreDocuments(engine, ["run-a", "run-b", "run-c"]);
    expect(deleted.toSorted()).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("still performs the post-run count proof when cleanup reports an error", async () => {
    const request = mock(() => Promise.resolve(countResponse(1)));
    const engine = {
      applyBatch: () =>
        Promise.resolve({
          failures: [{ error: "delete failed", id: "run-a" }],
          unapplied: [],
        }),
    };

    await expect(
      cleanupAndAssertManticoreTables(
        "benchmark",
        "http://manticore.test",
        engine,
        ["run-a"],
        request
      )
    ).rejects.toThrow("cleanup proof failed");
    expect(request).toHaveBeenCalledTimes(MANTICORE_BENCH_TABLES.length);
  });

  it("proves all hybrid-schema tables clean after cleanup", async () => {
    const request = mock(() => Promise.resolve(countResponse(0)));
    const engine = {
      applyBatch: () => Promise.resolve({ failures: [], unapplied: [] }),
    };

    await cleanupAndAssertManticoreTables(
      "hybrid benchmark",
      "http://manticore.test",
      engine,
      ["run-a"],
      request,
      MANTICORE_BENCH_HYBRID_TABLES
    );

    expect(request).toHaveBeenCalledTimes(MANTICORE_BENCH_HYBRID_TABLES.length);
  });

  it("fails closed when CI requires Manticore but no URL is configured", () => {
    expect(() => requireManticoreUrl(undefined, true)).toThrow(
      "requires a non-empty MANTICORE_URL"
    );
    expect(requireManticoreUrl(" http://manticore.test ", true)).toBe(
      "http://manticore.test"
    );
  });

  it("scopes concurrent runs uniquely and maps hits back to corpus ids", () => {
    const corpus = [{ id: "corpus-a", title: "A" }];
    const first = scopeBenchmarkDocuments(corpus);
    const second = scopeBenchmarkDocuments(corpus);
    expect(first.documentIds[0]).not.toBe(second.documentIds[0]);
    expect(first.toCorpusId(first.documentIds[0] ?? "")).toBe("corpus-a");
    expect(first.documents[0]?.title).toBe("A");
  });

  it("accepts a stable scope for deterministic relevance tie-breaking", () => {
    const corpus = [{ id: "corpus-a" }, { id: "corpus-b" }];
    const first = scopeBenchmarkDocuments(corpus, "golden-relevance-v1");
    const second = scopeBenchmarkDocuments(corpus, "golden-relevance-v1");

    expect(first.documentIds).toEqual(second.documentIds);
    expect(first.toCorpusId(first.documentIds[0] ?? "")).toBe("corpus-a");
  });

  it("fails closed without exposing an unknown foreign hit id", () => {
    const scoped = scopeBenchmarkDocuments([{ id: "corpus-a" }]);
    const foreignId = "foreign-secret-document-id";
    expect(() => scoped.toCorpusId(foreignId)).toThrow(
      "Manticore returned an unknown benchmark document id"
    );
    try {
      scoped.toCorpusId(foreignId);
    } catch (error) {
      expect(String(error)).not.toContain(foreignId);
    }
  });

  it("attempts both engine cleanups and aggregates sanitized labels", async () => {
    const attempted: string[] = [];
    await expect(
      cleanupBenchmarkRuns([
        {
          cleanup: () => {
            attempted.push("first");
            return Promise.reject(new Error("secret-url-one"));
          },
          name: "engine-one",
        },
        {
          cleanup: () => {
            attempted.push("second");
            return Promise.reject(new Error("secret-url-two"));
          },
          name: "engine-two",
        },
      ])
    ).rejects.toThrow("Benchmark cleanup failed for engine-one, engine-two");
    expect(attempted.toSorted()).toEqual(["first", "second"]);
  });
});
