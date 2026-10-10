import { createHash } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

export const MANTICORE_BENCH_INDEX_NAME = "aanvragen_bench";

export const MANTICORE_BENCH_TABLES = [
  `${MANTICORE_BENCH_INDEX_NAME}_active`,
  `${MANTICORE_BENCH_INDEX_NAME}_archive`,
] as const;

export const MANTICORE_BENCH_HYBRID_TABLES = [
  MANTICORE_BENCH_INDEX_NAME,
  ...MANTICORE_BENCH_TABLES,
] as const;

const benchmarkLockPath = (url: string): string => {
  const { origin } = new URL(url);
  const targetHash = createHash("sha256").update(origin).digest("hex");
  return path.join(
    os.tmpdir(),
    `ji-manticore-benchmark-${targetHash.slice(0, 24)}.lock`
  );
};

/**
 * Claims exclusive ownership of every benchmark target for one process.
 * Directory creation is atomic across worktrees. A crashed process leaves a
 * fail-closed lock that the operator must inspect and remove deliberately.
 */
export const acquireManticoreBenchmarkLocks = async (
  urls: readonly string[]
): Promise<() => Promise<void>> => {
  const lockPaths = [...new Set(urls.map(benchmarkLockPath))].toSorted();
  const acquired: string[] = [];
  try {
    for (const lockPath of lockPaths) {
      // oxlint-disable-next-line no-await-in-loop -- locks must be acquired in sorted order to avoid cross-target deadlock
      await mkdir(lockPath, { mode: 0o700 });
      acquired.push(lockPath);
    }
  } catch (error) {
    await Promise.allSettled(acquired.map((lockPath) => rmdir(lockPath)));
    const parsedError = z.object({ code: z.string() }).safeParse(error);
    if (parsedError.success && parsedError.data.code === "EEXIST") {
      throw new Error(
        "Another benchmark process owns one of the configured Manticore targets",
        { cause: error }
      );
    }
    throw error;
  }

  return async () => {
    const releases = await Promise.allSettled(
      acquired.toReversed().map((lockPath) => rmdir(lockPath))
    );
    const releaseFailures = releases.filter(
      (release) => release.status === "rejected"
    );
    if (releaseFailures.length > 0) {
      throw new Error(
        `Failed to release ${releaseFailures.length} Manticore benchmark target lock(s)`
      );
    }
  };
};

type BenchmarkPhase = "after" | "before";

interface CleanupEngine {
  applyBatch: (batch: {
    appliedSequence: bigint;
    mutations: {
      id: string;
      kind: "delete";
      sequenceNumber: bigint;
    }[];
  }) => Promise<{
    readonly failures: readonly {
      readonly error: string;
      readonly id: string;
    }[];
    readonly unapplied: readonly string[];
  }>;
}

type CountRequest = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const countResponseSchema = z.array(
  z.object({ data: z.array(z.record(z.string(), z.unknown())) })
);

const canonicalCountSchema = z
  .union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^(?:0|[1-9]\d*)$/u),
  ])
  .transform(Number)
  .refine(Number.isSafeInteger);

export const countManticoreRows = async (
  url: string,
  request: CountRequest = fetch,
  tables: readonly string[] = MANTICORE_BENCH_TABLES
): Promise<Record<string, number>> => {
  const countTable = async (table: string): Promise<[string, number]> => {
    const response = await request(`${url}/sql?mode=raw`, {
      body: `query=${encodeURIComponent(`SELECT COUNT(*) FROM ${table}`)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `SELECT COUNT(*) FROM ${table} failed (${response.status}) on ${url}`
      );
    }
    const parsed = countResponseSchema.parse(await response.json());
    const countResult = canonicalCountSchema.safeParse(
      parsed[0]?.data[0]?.["count(*)"]
    );
    if (!countResult.success) {
      throw new Error(`Invalid row count for ${table} on ${url}`);
    }
    const count = countResult.data;
    return [table, count];
  };

  return Object.fromEntries(
    await Promise.all(tables.map((table) => countTable(table)))
  );
};

interface NamedCleanup {
  cleanup: (() => Promise<void>) | null;
  name: string;
}

/** Attempts every engine cleanup and reports only engine labels, never URLs or raw errors. */
export const cleanupBenchmarkRuns = async (
  runs: readonly NamedCleanup[]
): Promise<void> => {
  const cleanups = runs.filter(
    (run): run is NamedCleanup & { cleanup: () => Promise<void> } =>
      run.cleanup !== null
  );
  const results = await Promise.allSettled(
    cleanups.map(async (run) => {
      await run.cleanup();
    })
  );
  const failedNames = results.flatMap((result, index) =>
    result.status === "rejected" ? [cleanups[index]?.name ?? "unknown"] : []
  );
  if (failedNames.length > 0) {
    throw new AggregateError(
      failedNames.map((name) => new Error(`${name} cleanup failed`)),
      `Benchmark cleanup failed for ${failedNames.join(", ")}`
    );
  }
};

export interface ScopedBenchmarkDocuments<T extends { id: string }> {
  documentIds: string[];
  documents: T[];
  toCorpusId: (id: string) => string;
}

/** Gives each engine invocation scoped IDs while retaining score/export IDs. */
export const scopeBenchmarkDocuments = <T extends { id: string }>(
  documents: readonly T[],
  scopeId: string = crypto.randomUUID()
): ScopedBenchmarkDocuments<T> => {
  const corpusIdsByScopedId = new Map<string, string>();
  const scopedDocuments = documents.map((document) => {
    const id = `${scopeId}:${document.id}`;
    corpusIdsByScopedId.set(id, document.id);
    return { ...document, id };
  });
  return {
    documentIds: scopedDocuments.map((document) => document.id),
    documents: scopedDocuments,
    toCorpusId: (id) => {
      const corpusId = corpusIdsByScopedId.get(id);
      if (!corpusId) {
        throw new Error("Manticore returned an unknown benchmark document id");
      }
      return corpusId;
    },
  };
};

export const assertCleanManticoreTables = async (
  name: string,
  url: string,
  phase: BenchmarkPhase,
  request: CountRequest = fetch,
  tables: readonly string[] = MANTICORE_BENCH_TABLES
): Promise<void> => {
  const counts = await countManticoreRows(url, request, tables);
  console.log(`${name}: rows ${phase} run ${JSON.stringify(counts)}`);
  const dirty = Object.entries(counts).filter(([, count]) => count !== 0);
  if (dirty.length === 0) {
    return;
  }
  throw new Error(
    `${name}: ${phase}-run benchmark tables are not empty: ${dirty
      .map(([table, count]) => `${table}=${count}`)
      .join(", ")} on ${url}`
  );
};

export const cleanupManticoreDocuments = async (
  engine: CleanupEngine,
  documentIds: readonly string[]
): Promise<void> => {
  const cleanup = await engine.applyBatch({
    appliedSequence: BigInt(documentIds.length),
    mutations: documentIds.map((id, index) => ({
      id,
      kind: "delete",
      sequenceNumber: BigInt(index + 1),
    })),
  });
  if (cleanup.failures.length > 0 || cleanup.unapplied.length > 0) {
    throw new Error(
      `Manticore benchmark cleanup failed: failures=${cleanup.failures.length}, unapplied=${cleanup.unapplied.length}`
    );
  }
};

export const cleanupAndAssertManticoreTables = async (
  name: string,
  url: string,
  engine: CleanupEngine,
  documentIds: readonly string[],
  request: CountRequest = fetch,
  tables: readonly string[] = MANTICORE_BENCH_TABLES
): Promise<void> => {
  const failures: unknown[] = [];
  try {
    await cleanupManticoreDocuments(engine, documentIds);
  } catch (error) {
    failures.push(error);
  }
  try {
    await assertCleanManticoreTables(name, url, "after", request, tables);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${name} cleanup proof failed`);
  }
};

export const requireManticoreUrl = (
  url: string | undefined,
  required: boolean
): string | undefined => {
  const configured = url?.trim();
  if (!configured && required) {
    throw new Error(
      "BENCH_REQUIRE_MANTICORE=1 requires a non-empty MANTICORE_URL"
    );
  }
  return configured || undefined;
};
