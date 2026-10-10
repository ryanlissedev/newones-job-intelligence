import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  buildSearchSummaryRecord,
  buildWorkloadMetadata,
  digestQueryset,
} from "@ji/performance";
import type { SearchDocument, SearchEngine, SearchFilters } from "@ji/search";
import {
  InMemorySearchEngine,
  InMemorySearchVersionStore,
  ManticoreSearchEngine,
  SearchAdapter,
} from "@ji/search";
import { z } from "zod";

import {
  acquireManticoreBenchmarkLocks,
  assertCleanManticoreTables,
  cleanupAndAssertManticoreTables,
  MANTICORE_BENCH_HYBRID_TABLES,
  MANTICORE_BENCH_INDEX_NAME,
  MANTICORE_BENCH_TABLES,
  requireManticoreUrl,
} from "../manticore-hygiene";
import { sha256Digest } from "./digest";

export interface BenchmarkProfile {
  concurrency: number;
  corpus: {
    expectedDocuments: number;
    pointer: string;
  };
  measuredIterations: number;
  queries: { id: string; query: string; weight: number }[];
  slo: {
    boundary: string;
    maxMs: number;
    metric: string;
  };
  warmupIterations: number;
}

export const benchmarkProfileSchema = z.object({
  concurrency: z.number().int().min(1),
  corpus: z.object({
    expectedDocuments: z.number(),
    pointer: z.string(),
  }),
  measuredIterations: z.number(),
  queries: z.array(
    z.object({
      id: z.string(),
      query: z.string(),
      weight: z.number(),
    })
  ),
  slo: z.object({
    boundary: z.string(),
    maxMs: z.number(),
    metric: z.string(),
  }),
  warmupIterations: z.number(),
});

interface BenchmarkArgs {
  profilePath: string;
}

// Runs `worker` over `items` with at most `concurrency` calls in flight —
// a small bounded pool: each of `concurrency` loops pulls the next item off
// a shared cursor until the list is exhausted. Item order in `items` is not
// preserved in execution order, but total call count is exact.
export const runWithConcurrency = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> => {
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: poolSize }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- each pool worker must process its items sequentially; concurrency comes from running poolSize workers in parallel
      await worker(item);
    }
  });
  await Promise.all(workers);
};

// Flattens (iterations * queries) into one task list — the shape
// runWithConcurrency's worker pool consumes. Generalised over any query
// list (not just profile.queries) so the RJC-382 golden-query mode below
// can reuse the exact same flattening instead of a second implementation.
const buildTaskListFrom = <T>(items: readonly T[], iterations: number): T[] => {
  const tasks: T[] = [];
  for (let index = 0; index < iterations; index += 1) {
    tasks.push(...items);
  }
  return tasks;
};

const buildTaskList = (
  profile: BenchmarkProfile,
  iterations: number
): BenchmarkProfile["queries"] =>
  buildTaskListFrom(profile.queries, iterations);

const percentile = (values: number[], pct: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
};

const loadProfile = (profilePath: string): BenchmarkProfile => {
  const raw = readFileSync(profilePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return benchmarkProfileSchema.parse(parsed);
};

const seedDocuments = (count: number): SearchDocument[] =>
  Array.from({ length: count }, (_, index) => ({
    beschrijving: `Document ${index} about Azure platform engineer work`,
    bronId: `bron-${index % 5}`,
    contracttype: index % 2 === 0 ? "detachering" : "interim",
    eindklantNaam: null,
    id: `doc-${index}`,
    laatstGezienOp: new Date(Date.now() - index * 3_600_000),
    locatieLand: index % 3 === 0 ? "NL" : "BE",
    opdrachtgeverNaam: null,
    provincie: null,
    publicatiedatum: null,
    skills: [],
    status: "active",
    tariefEenheid: null,
    tariefMax: 100 + (index % 40),
    tariefMin: 60 + (index % 20),
    titel: `Platform engineer ${index}`,
    urenPerWeekMax: null,
    urenPerWeekMin: null,
    werkvorm: null,
  }));

// Unbounded Promise.all over the whole corpus opens one HTTP connection per
// document simultaneously, which resets Manticore's connection under load
// at realistic corpus sizes (confirmed: 20k docs ECONNRESET'd against local
// compose Manticore). Indexing in small concurrent batches keeps the same
// upsertDocument interface while staying within Manticore's connection
// capacity.
const UPSERT_BATCH_SIZE = 100;

const upsertAll = async (
  engine: SearchEngine,
  documents: SearchDocument[]
): Promise<void> => {
  for (let start = 0; start < documents.length; start += UPSERT_BATCH_SIZE) {
    const batch = documents.slice(start, start + UPSERT_BATCH_SIZE);
    /* oxlint-disable no-await-in-loop -- batches must index sequentially to bound concurrent connections */
    await Promise.all(batch.map((document) => engine.upsertDocument(document)));
    /* oxlint-enable no-await-in-loop */
  }
};

const scopeManticoreDocuments = (
  documents: readonly SearchDocument[]
): SearchDocument[] => {
  const runId = crypto.randomUUID();
  return documents.map((document) => ({
    ...document,
    id: `${document.id}--bench-${runId}`,
  }));
};

interface ResolvedCorpus {
  corpusDigest: string;
  documents: SearchDocument[];
}

// Reads corpus JSONL produced by benchmarks/search/generate-corpus.ts. Each
// line matches SearchDocument except laatstGezienOp is an ISO string (JSON
// has no Date type), so it is parsed back into a Date here.
const readCorpusFile = (filePath: string): ResolvedCorpus => {
  const raw = readFileSync(filePath, "utf-8");
  const corpusDigest = sha256Digest(raw);
  const documents = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // SAFETY: line is a JSONL record written by generate-corpus.ts, which
      // emits exactly the SearchDocument fields (laatstGezienOp as an ISO
      // string, reparsed into a Date on the next line).
      const parsed = JSON.parse(line) as SearchDocument;
      return { ...parsed, laatstGezienOp: new Date(parsed.laatstGezienOp) };
    });
  return { corpusDigest, documents };
};

// BENCH_CORPUS overrides the profile's corpus pointer; falls back to
// synthetic seedDocuments when neither path exists on disk (e.g. local
// dev runs that never generated a corpus).
const resolveCorpusDocuments = (profile: BenchmarkProfile): ResolvedCorpus => {
  const pointer = process.env.BENCH_CORPUS ?? profile.corpus.pointer;
  const resolved = path.resolve(process.cwd(), pointer);
  if (existsSync(resolved)) {
    return readCorpusFile(resolved);
  }

  const count = Number(process.env.BENCH_CORPUS_SIZE ?? 1000);
  return {
    corpusDigest: sha256Digest(`seedDocuments:${count}`),
    documents: seedDocuments(count),
  };
};

// RJC-382 latency round: builds a named engine against an explicit URL
// (rather than always reading MANTICORE_URL), so the same corpus can be
// indexed into a second Manticore instance (the 29.x shadow) in the same
// invocation, mirroring the MANTICORE_29_URL pattern already used by
// benchmarks/relevance/run.ts. Reports indexing throughput (docs/s) since
// that also matters for the RJC-389 1M-backfill design.
interface NamedEngineRun {
  cleanup: (() => Promise<void>) | null;
  documentCount: number;
  engine: SearchEngine;
  indexingDocsPerSecond: number;
  indexingMs: number;
  label: string;
}

const finishManticoreRun = async (
  label: string,
  url: string,
  engine: ManticoreSearchEngine,
  documentIds: readonly string[],
  hybridSchemaEnabled: boolean
): Promise<void> => {
  await cleanupAndAssertManticoreTables(
    label,
    url,
    engine,
    documentIds,
    fetch,
    hybridSchemaEnabled ? MANTICORE_BENCH_HYBRID_TABLES : MANTICORE_BENCH_TABLES
  );
};

const buildNamedEngineRun = async (
  label: string,
  url: string | undefined,
  documents: SearchDocument[],
  hybridSchemaEnabled = false
): Promise<NamedEngineRun> => {
  if (!url) {
    const engine = new InMemorySearchEngine();
    const startedAt = performance.now();
    await upsertAll(engine, documents);
    await engine.applyBatch({ appliedSequence: 1n, mutations: [] });
    const indexingMs = performance.now() - startedAt;
    return {
      cleanup: null,
      documentCount: documents.length,
      engine,
      indexingDocsPerSecond:
        indexingMs > 0
          ? Number((documents.length / (indexingMs / 1000)).toFixed(1))
          : 0,
      indexingMs: Number(indexingMs.toFixed(1)),
      label,
    };
  }

  const hygieneTables = hybridSchemaEnabled
    ? MANTICORE_BENCH_HYBRID_TABLES
    : MANTICORE_BENCH_TABLES;
  await assertCleanManticoreTables(label, url, "before", fetch, hygieneTables);
  const engine = ManticoreSearchEngine.fromUrl(
    url,
    new InMemorySearchVersionStore(),
    MANTICORE_BENCH_INDEX_NAME,
    undefined,
    { hybridEnabled: hybridSchemaEnabled }
  );
  const runDocuments = scopeManticoreDocuments(documents);
  const documentIds = runDocuments.map((document) => document.id);
  const startedAt = performance.now();
  try {
    await upsertAll(engine, runDocuments);
    await engine.applyBatch({ appliedSequence: 1n, mutations: [] });
  } catch (error) {
    try {
      await finishManticoreRun(
        label,
        url,
        engine,
        documentIds,
        hybridSchemaEnabled
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${label} indexing and cleanup failed`,
        { cause: cleanupError }
      );
    }
    throw error;
  }
  const indexingMs = performance.now() - startedAt;
  return {
    cleanup: () =>
      finishManticoreRun(label, url, engine, documentIds, hybridSchemaEnabled),
    documentCount: documents.length,
    engine,
    indexingDocsPerSecond:
      indexingMs > 0
        ? Number((documents.length / (indexingMs / 1000)).toFixed(1))
        : 0,
    indexingMs: Number(indexingMs.toFixed(1)),
    label,
  };
};

const createEngine = async (
  profile: BenchmarkProfile
): Promise<NamedEngineRun & { corpusDigest: string }> => {
  const manticoreUrl = requireManticoreUrl(
    process.env.MANTICORE_URL,
    process.env.BENCH_REQUIRE_MANTICORE === "1"
  );
  const { corpusDigest, documents } = resolveCorpusDocuments(profile);
  const run = await buildNamedEngineRun(
    manticoreUrl ? "manticore" : "in-memory",
    manticoreUrl,
    documents
  );
  return { ...run, corpusDigest };
};

interface LatencyQuery {
  filters?: SearchFilters;
  id: string;
  query: string;
  weight: number;
}

// RJC-382: the production request shape after RJC-378 is facets-on,
// sort=relevance, limit=20 — SearchAdapter's own defaults (see adapter.ts
// DEFAULT_LIMIT/DEFAULT_SORT), so no extra params are needed here, only a
// different query set. Loads the 43 golden queries used by
// benchmarks/relevance/run.ts so the latency round can also measure the
// real query mix, not just the 5 synthetic profile queries.
const GOLDEN_QUERIES_PATH = "benchmarks/relevance/queries.jsonl";

const loadGoldenQueries = (): LatencyQuery[] => {
  const raw = readFileSync(
    path.resolve(process.cwd(), GOLDEN_QUERIES_PATH),
    "utf-8"
  );
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // SAFETY: line is a JSONL record written by benchmarks/relevance's own
      // querySchema (id, query, optional filters); this loader only reads
      // the three fields it needs, same as benchmarks/relevance/run.ts.
      const parsed = JSON.parse(line) as {
        filters?: SearchFilters;
        id: string;
        query: string;
      };
      return {
        filters: parsed.filters,
        id: parsed.id,
        query: parsed.query,
        weight: 1,
      };
    });
};

interface PerQueryStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  queryId: string;
}

interface SeriesStats {
  errorCount: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  perQuery: PerQueryStats[];
}

// Groups (queryId -> durationsMs[]) into a sorted-by-id per-query
// breakdown. Isolates which query id dominates a series' p95/p99 — e.g. a
// query set where one query is consistently slow shows up here as a
// distinct high-p50 row, distinguishing a query-set artifact from host
// contention.
const buildPerQueryStats = (
  byQueryId: ReadonlyMap<string, number[]>
): PerQueryStats[] =>
  [...byQueryId.entries()]
    .map(([queryId, durations]) => ({
      count: durations.length,
      p50Ms: Number(percentile(durations, 50).toFixed(2)),
      p95Ms: Number(percentile(durations, 95).toFixed(2)),
      queryId,
    }))
    .toSorted((left, right) => left.queryId.localeCompare(right.queryId));

// Non-throwing sibling of runMeasured (which intentionally throws on a
// failed query for the existing gate/spec contract — see
// concurrency.spec.ts). The RJC-382 extended report wants an error count
// and a per-query breakdown alongside p50/p95/p99/max instead of a hard
// failure, so it reuses runWithConcurrency directly rather than
// duplicating the pool logic.
const runSeries = async (
  adapter: SearchAdapter,
  queries: readonly LatencyQuery[],
  concurrency: number,
  warmupIterations: number,
  measuredIterations: number
): Promise<SeriesStats> => {
  const warmupTasks = buildTaskListFrom(queries, warmupIterations);
  await runWithConcurrency(warmupTasks, concurrency, async (query) => {
    await adapter.search({ filters: query.filters ?? {}, query: query.query });
  });

  const durationsMs: number[] = [];
  const byQueryId = new Map<string, number[]>();
  let errorCount = 0;
  const measuredTasks = buildTaskListFrom(queries, measuredIterations);
  await runWithConcurrency(measuredTasks, concurrency, async (query) => {
    const started = performance.now();
    const result = await adapter.search({
      filters: query.filters ?? {},
      query: query.query,
    });
    const elapsed = performance.now() - started;
    durationsMs.push(elapsed);
    const perId = byQueryId.get(query.id) ?? [];
    perId.push(elapsed);
    byQueryId.set(query.id, perId);
    if (!result.ok) {
      errorCount += 1;
    }
  });

  return {
    errorCount,
    maxMs: Number(
      (durationsMs.length > 0 ? Math.max(...durationsMs) : 0).toFixed(2)
    ),
    p50Ms: Number(percentile(durationsMs, 50).toFixed(2)),
    p95Ms: Number(percentile(durationsMs, 95).toFixed(2)),
    p99Ms: Number(percentile(durationsMs, 99).toFixed(2)),
    perQuery: buildPerQueryStats(byQueryId),
  };
};

const parseArgs = (): BenchmarkArgs => {
  const profileFlagIndex = process.argv.indexOf("--profile");
  const profilePath =
    profileFlagIndex === -1
      ? "benchmarks/search/profile.json"
      : process.argv[profileFlagIndex + 1];
  if (!profilePath) {
    throw new Error("Missing value for --profile");
  }

  return { profilePath: path.resolve(process.cwd(), profilePath) };
};

export const runWarmup = async (
  adapter: SearchAdapter,
  profile: BenchmarkProfile
): Promise<void> => {
  const tasks = buildTaskList(profile, profile.warmupIterations);
  await runWithConcurrency(tasks, profile.concurrency, async (query) => {
    await adapter.search({ query: query.query });
  });
};

export const runMeasured = async (
  adapter: SearchAdapter,
  profile: BenchmarkProfile
): Promise<number[]> => {
  const durationsMs: number[] = [];
  const tasks = buildTaskList(profile, profile.measuredIterations);
  await runWithConcurrency(tasks, profile.concurrency, async (query) => {
    const started = performance.now();
    const result = await adapter.search({ query: query.query });
    durationsMs.push(performance.now() - started);
    if (!result.ok) {
      throw new Error(`Benchmark query failed: ${query.id}`);
    }
  });

  return durationsMs;
};

// RJC-382 latency round: runs the profile (or golden) queries against the
// base engine plus, when set, a second named Manticore engine (e.g. the
// 29.x shadow) in one invocation, printing an extended per-engine report
// (adds maxMs/errorCount/indexing throughput to the base report shape).
// Only engaged when MANTICORE_29_URL or LATENCY_GOLDEN_QUERIES is set, so
// the default `bun run bench:search` invocation keeps its single-report
// shape — see runLatencyRound's caller in main() below.
interface LatencyEngineReport {
  boundary: string;
  documentCount: number;
  embeddingDocsPerSecond: number | null;
  engine: string;
  errorCount: number;
  indexingDocsPerSecond: number;
  indexingMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  passed: boolean;
  perQuery: PerQueryStats[];
  profile: string;
  queryMode: "golden" | "profile";
  queryset: string;
  searchMode: "hybrid" | "lexical";
  sloMaxMs: number;
}

interface LatencyEngineSpec {
  hybridSchemaEnabled: boolean;
  hybridEnabled: boolean;
  label: string;
  url: string | undefined;
}

const HYBRID_P95_MAX_MS = 200;
const LEXICAL_EVALUATION_P95_MAX_MS = 50;

const resolveLatencySlo = (
  profileMaxMs: number,
  hybridEvaluation: boolean,
  hybridEnabled: boolean
): number => {
  if (!hybridEvaluation) {
    return profileMaxMs;
  }
  return hybridEnabled ? HYBRID_P95_MAX_MS : LEXICAL_EVALUATION_P95_MAX_MS;
};

const buildLatencyEngineSpecs = (
  manticoreUrl: string | undefined,
  hybridEvaluation: boolean
): LatencyEngineSpec[] => {
  const manticore29Url = process.env.MANTICORE_29_URL?.trim();
  if (hybridEvaluation && (!manticoreUrl || !manticore29Url)) {
    throw new Error(
      "SEARCH_HYBRID=1 latency evaluation requires MANTICORE_URL and MANTICORE_29_URL"
    );
  }

  let baseLabel = "in-memory";
  if (manticoreUrl) {
    baseLabel = hybridEvaluation
      ? "manticore-6.3.8-lexical"
      : "manticore-6.3.8";
  }
  const specs: LatencyEngineSpec[] = [
    {
      hybridEnabled: false,
      hybridSchemaEnabled: false,
      label: baseLabel,
      url: manticoreUrl,
    },
  ];
  if (!manticore29Url) {
    return specs;
  }

  const label = process.env.MANTICORE_29_LABEL?.trim() || "manticore-29";
  specs.push({
    hybridEnabled: false,
    hybridSchemaEnabled: hybridEvaluation,
    label: hybridEvaluation ? `${label}-lexical` : label,
    url: manticore29Url,
  });
  if (hybridEvaluation) {
    specs.push({
      hybridEnabled: true,
      hybridSchemaEnabled: true,
      label: `${label}-hybrid`,
      url: manticore29Url,
    });
  }
  return specs;
};

const runLatencyRoundUnlocked = async (
  profile: BenchmarkProfile,
  profilePath: string
): Promise<void> => {
  const manticoreUrl = requireManticoreUrl(
    process.env.MANTICORE_URL,
    process.env.BENCH_REQUIRE_MANTICORE === "1"
  );
  const useGolden = process.env.LATENCY_GOLDEN_QUERIES === "1";
  const queries: LatencyQuery[] = useGolden
    ? loadGoldenQueries()
    : profile.queries.map((q) => ({ ...q }));
  const { documents } = resolveCorpusDocuments(profile);

  const hybridEvaluation = process.env.SEARCH_HYBRID === "1";
  const engineSpecs = buildLatencyEngineSpecs(manticoreUrl, hybridEvaluation);

  const reports: LatencyEngineReport[] = [];
  for (const spec of engineSpecs) {
    // oxlint-disable-next-line no-await-in-loop -- engines are indexed and measured sequentially so each series is isolated and comparable
    const run = await buildNamedEngineRun(
      spec.label,
      spec.url,
      documents,
      spec.hybridSchemaEnabled
    );
    try {
      const adapter = new SearchAdapter({
        engine: run.engine,
        hybridEnabled: spec.hybridEnabled,
      });
      // oxlint-disable-next-line no-await-in-loop -- sequential series, see above
      const stats = await runSeries(
        adapter,
        queries,
        profile.concurrency,
        profile.warmupIterations,
        profile.measuredIterations
      );
      const sloMaxMs = resolveLatencySlo(
        profile.slo.maxMs,
        hybridEvaluation,
        spec.hybridEnabled
      );
      reports.push({
        boundary: profile.slo.boundary,
        documentCount: run.documentCount,
        embeddingDocsPerSecond: spec.hybridSchemaEnabled
          ? run.indexingDocsPerSecond
          : null,
        engine: run.label,
        errorCount: stats.errorCount,
        indexingDocsPerSecond: run.indexingDocsPerSecond,
        indexingMs: run.indexingMs,
        maxMs: stats.maxMs,
        p50Ms: stats.p50Ms,
        p95Ms: stats.p95Ms,
        p99Ms: stats.p99Ms,
        passed: stats.p95Ms <= sloMaxMs,
        perQuery: stats.perQuery,
        profile: profilePath,
        queryMode: useGolden ? "golden" : "profile",
        queryset: useGolden ? GOLDEN_QUERIES_PATH : profile.corpus.pointer,
        searchMode: spec.hybridEnabled ? "hybrid" : "lexical",
        sloMaxMs,
      });
    } finally {
      if (run.cleanup) {
        // oxlint-disable-next-line no-await-in-loop -- each engine must prove its dedicated tables clean before the next series
        await run.cleanup();
      }
    }
  }

  console.log(JSON.stringify(reports, null, 2));

  const anyFailed = reports.some((r) => r.passed !== true);
  if (anyFailed && process.env.BENCH_ALLOW_FAIL !== "1") {
    process.exitCode = 1;
  }
};

const runLatencyRound = async (
  profile: BenchmarkProfile,
  profilePath: string
): Promise<void> => {
  const targetUrls = [
    process.env.MANTICORE_URL?.trim(),
    process.env.MANTICORE_29_URL?.trim(),
  ].filter((url): url is string => Boolean(url));
  const releaseLocks = await acquireManticoreBenchmarkLocks(targetUrls);
  try {
    await runLatencyRoundUnlocked(profile, profilePath);
  } finally {
    await releaseLocks();
  }
};

const main = async (): Promise<void> => {
  const { profilePath } = parseArgs();
  const profile = loadProfile(profilePath);

  // Extended RJC-382 latency-round mode is opt-in only; the default path
  // below (none of these three set) keeps the single-report JSON shape.
  // LATENCY_EXTENDED_REPORT
  // forces the extended (array, per-query breakdown) report shape for a
  // single engine without requiring a second Manticore target — useful for
  // running one engine's series in isolation (e.g. to avoid one engine's
  // indexing timeout aborting a report for an engine that already finished).
  if (
    process.env.MANTICORE_29_URL ||
    process.env.LATENCY_GOLDEN_QUERIES === "1" ||
    process.env.LATENCY_EXTENDED_REPORT === "1"
  ) {
    await runLatencyRound(profile, profilePath);
    return;
  }

  const run = await createEngine(profile);
  const adapter = new SearchAdapter({ engine: run.engine });

  // SearchAdapter.search() checks isCriticalPathEnabled() (true whenever
  // PERF_METRICS_DIR is set) and, if true, creates + flushes a session
  // (plus a second "instrumentation-overhead" session) on EVERY call. Left
  // set during warmup/measured, that both times the instrumentation itself
  // into the p50/p95/p99 and floods PERF_METRICS_DIR with hundreds of
  // incidental per-call records. Unset it for the timed loop; restore only
  // to write the single summary record below. Note isCriticalPathEnabled()
  // also trips on PERF_CRITICAL_PATH=1 alone — exporting that in the
  // environment before running this script re-enables per-call
  // instrumentation regardless of this delete.
  const metricsDir = process.env.PERF_METRICS_DIR;
  delete process.env.PERF_METRICS_DIR;

  let durationsMs: number[];
  try {
    await runWarmup(adapter, profile);
    durationsMs = await runMeasured(adapter, profile);
  } finally {
    if (run.cleanup) {
      await run.cleanup();
    }
  }

  const p50 = percentile(durationsMs, 50);
  const p95 = percentile(durationsMs, 95);
  const p99 = percentile(durationsMs, 99);
  const passed = p95 <= profile.slo.maxMs;

  const report = {
    boundary: profile.slo.boundary,
    corpusExpectedDocuments: profile.corpus.expectedDocuments,
    corpusPointer: profile.corpus.pointer,
    engine: run.label,
    measuredSamples: durationsMs.length,
    p50Ms: Number(p50.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    p99Ms: Number(p99.toFixed(2)),
    passed,
    profile: profilePath,
    sloMaxMs: profile.slo.maxMs,
  };

  console.log(JSON.stringify(report, null, 2));

  if (metricsDir) {
    process.env.PERF_METRICS_DIR = metricsDir;
    process.env.PERF_CRITICAL_PATH = "1";
    // Cohort-identity dimensions the performance schema already carries
    // (buildWorkloadMetadata / CriticalPathMetadata) — set here so two runs
    // with a different corpus, document count, or concurrency are never
    // folded into the same cohort fingerprint.
    process.env.PERF_ITEM_COUNT = String(run.documentCount);
    process.env.PERF_DATASET_DIGEST = run.corpusDigest;
    process.env.PERF_CONCURRENCY = String(profile.concurrency);
    await buildSearchSummaryRecord({
      durationsMs,
      errorCount: 0,
      metadata: {
        ...buildWorkloadMetadata(),
        profile: profilePath,
        "queryset-digest": digestQueryset({
          query: profile.queries.map((entry) => entry.id).join("|"),
        }),
      },
      timeoutCount: 0,
    });
  }

  if (!passed && process.env.BENCH_ALLOW_FAIL !== "1") {
    process.exitCode = 1;
  }
};

// Root-cause fix: without this guard, importing anything from this module
// (e.g. from a spec file) runs the entire benchmark as an import side
// effect — bitten once already when digest.ts had to be split out just to
// avoid it. Matches generate-corpus.ts's own convention.
if (import.meta.main) {
  await main();
}
