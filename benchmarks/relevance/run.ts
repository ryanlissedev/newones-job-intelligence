import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { AANVRAAG_LIFECYCLE, parseBooleanQuery } from "@ji/domain";
import type { SearchEngine, SearchFilters, SearchScope } from "@ji/search";
import {
  InMemorySearchEngine,
  InMemorySearchVersionStore,
  isHybridSearchEligible,
  ManticoreSearchEngine,
} from "@ji/search";
import { z } from "zod";

import {
  acquireManticoreBenchmarkLocks,
  assertCleanManticoreTables,
  cleanupAndAssertManticoreTables,
  MANTICORE_BENCH_HYBRID_TABLES,
  MANTICORE_BENCH_INDEX_NAME,
  MANTICORE_BENCH_TABLES,
  scopeBenchmarkDocuments,
} from "../manticore-hygiene";
import { loadRelevanceCorpus } from "./corpus";
import type { RelevanceCorpusSummary } from "./corpus";

/**
 * Golden relevance runner (RJC-320, `.isa/search-quality.md`).
 *
 * Scores any `SearchEngine` implementation on the versioned query set in
 * `queries.jsonl` against the real fixture corpus from `corpus.ts`:
 * Recall@20 primary, nDCG@10 secondary, per query / per category / macro.
 * Always runs in-memory; adds Manticore when MANTICORE_URL is set. No
 * app-layer code changes are needed to add an engine — anything satisfying
 * the `SearchEngine` seam plugs into `buildEngineRuns`.
 *
 * RJC-383 (active/archive split): the FIRST table and the `engines` key of
 * the report are scored with `scope: "all"` — the whole corpus, exactly what
 * the pre-split single table held — so every number stays comparable with
 * the history. A SECOND table (`enginesActiveScope`) scores the same query
 * set against the default active scope; judged documents that sit in the
 * archive (closed status or a passed sluitingsdatum at BENCH_NOW) are then
 * unreachable by design, so lower recall there measures the split's
 * product effect, not engine quality. Engines are built with the fixed
 * BENCH_NOW clock so the partition of each corpus document — and therefore
 * the report — is byte-identical from one day to the next.
 */

const RECALL_DEPTH = 20;
const NDCG_DEPTH = 10;
const MIN_QUERY_COUNT = 35;
const METRIC_PRECISION = 6;
const REPORT_PATH = path.join(".artifacts", "relevance", "report.json");
const RELEVANCE_SCOPE_ID = "golden-relevance-v1";
/** Fixed partition clock (RJC-383); one day after the corpus' laatstGezienOp. */
const BENCH_NOW = new Date("2026-09-01T00:00:00.000Z");
const benchClock = (): Date => BENCH_NOW;

const QUERY_CATEGORIES = [
  "exact-skill",
  "nl-morphology",
  "compound",
  "semantic-synonym",
  "phrase-filter",
  "nl-en-mix",
] as const;

const filtersSchema = z
  .object({
    bronIds: z.array(z.string()).optional(),
    contracttype: z.array(z.string()).optional(),
    locatieLand: z.array(z.string()).optional(),
    status: z.array(z.enum(AANVRAAG_LIFECYCLE)).optional(),
    tariefMax: z.number().optional(),
    tariefMin: z.number().optional(),
  })
  .strict();

const querySchema = z
  .object({
    category: z.enum(QUERY_CATEGORIES),
    filters: filtersSchema.optional(),
    hardNegatives: z.array(z.string()).min(1),
    id: z.string().min(1),
    note: z.string().optional(),
    query: z.string().min(1),
    relevant: z.array(z.string()).min(1),
  })
  .strict();

type RelevanceQuery = z.infer<typeof querySchema>;

const loadQueries = async (queriesPath: string): Promise<RelevanceQuery[]> => {
  const raw = await readFile(queriesPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line);
      const result = querySchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `queries.jsonl line ${index + 1}: ${result.error.message}`
        );
      }
      return result.data;
    });
};

/** ISC-1/ISC-2 gate: fail loudly before measuring anything on a broken set. */
const validateQuerySet = (
  queries: RelevanceQuery[],
  corpusIds: Set<string>
): void => {
  if (queries.length < MIN_QUERY_COUNT) {
    throw new Error(
      `query set has ${queries.length} queries; ISC-1 requires >= ${MIN_QUERY_COUNT}`
    );
  }
  const seenIds = new Set<string>();
  const seenCategories = new Set<string>();
  for (const query of queries) {
    if (seenIds.has(query.id)) {
      throw new Error(`duplicate query id: ${query.id}`);
    }
    seenIds.add(query.id);
    seenCategories.add(query.category);
    for (const docId of [...query.relevant, ...query.hardNegatives]) {
      if (!corpusIds.has(docId)) {
        throw new Error(`query ${query.id} judges unknown document: ${docId}`);
      }
    }
    const overlap = query.relevant.filter((docId) =>
      query.hardNegatives.includes(docId)
    );
    if (overlap.length > 0) {
      throw new Error(
        `query ${query.id} lists ${overlap.join(", ")} as both relevant and hard negative`
      );
    }
  }
  if (seenCategories.size !== QUERY_CATEGORIES.length) {
    throw new Error(
      `query set covers ${seenCategories.size} categories; ISC-1 requires all ${QUERY_CATEGORIES.length}`
    );
  }
};

const round = (value: number): number =>
  Number(value.toFixed(METRIC_PRECISION));

const recallAtK = (
  rankedIds: readonly string[],
  relevant: ReadonlySet<string>,
  depth: number
): number => {
  const top = rankedIds.slice(0, depth);
  const found = top.filter((id) => relevant.has(id)).length;
  return found / relevant.size;
};

const ndcgAtK = (
  rankedIds: readonly string[],
  relevant: ReadonlySet<string>,
  depth: number
): number => {
  const top = rankedIds.slice(0, depth);
  let dcg = 0;
  for (const [index, id] of top.entries()) {
    if (relevant.has(id)) {
      dcg += 1 / Math.log2(index + 2);
    }
  }
  const idealHits = Math.min(relevant.size, depth);
  let idcg = 0;
  for (let index = 0; index < idealHits; index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
};

interface QueryScore {
  category: RelevanceQuery["category"];
  id: string;
  ndcg10: number;
  recall20: number;
  returned: number;
}

interface MetricPair {
  ndcg10: number;
  recall20: number;
}

interface EngineReport {
  engine: string;
  overall: MetricPair;
  perCategory: Record<string, MetricPair>;
  perQuery: QueryScore[];
}

interface EnginePerformance {
  embeddingDocsPerSecond: number | null;
  engine: string;
  indexingDocsPerSecond: number;
  indexingMs: number;
  mode: "hybrid" | "lexical";
  p50Ms: number;
  p95Ms: number;
  querySamples: number;
}

interface ScoredEngine {
  durationsMs: number[];
  report: EngineReport;
}

const macroAverage = (scores: readonly QueryScore[]): MetricPair => {
  if (scores.length === 0) {
    return { ndcg10: 0, recall20: 0 };
  }
  const recallSum = scores.reduce((sum, score) => sum + score.recall20, 0);
  const ndcgSum = scores.reduce((sum, score) => sum + score.ndcg10, 0);
  return {
    ndcg10: round(ndcgSum / scores.length),
    recall20: round(recallSum / scores.length),
  };
};

const scoreEngine = async (
  name: string,
  engine: SearchEngine,
  queries: readonly RelevanceQuery[],
  scope: SearchScope,
  toCorpusId: (id: string) => string,
  mode: "hybrid" | "lexical"
): Promise<ScoredEngine> => {
  const perQuery: QueryScore[] = [];
  const durationsMs: number[] = [];
  for (const query of queries) {
    const parsed = parseBooleanQuery(query.query);
    if (!parsed.ok) {
      throw new Error(
        `query ${query.id} failed to parse: ${parsed.error.message}`
      );
    }
    // SAFETY: filtersSchema mirrors SearchFilters field-for-field; zod has
    // already validated shape and lifecycle values.
    const filters: SearchFilters = query.filters ?? {};
    const effectiveMode =
      mode === "hybrid" && isHybridSearchEligible(parsed.ast)
        ? "hybrid"
        : "lexical";
    const startedAt = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- queries run sequentially for stable, comparable output
    const result = await engine.search({
      ast: parsed.ast,
      filters,
      limit: RECALL_DEPTH,
      mode: effectiveMode,
      offset: 0,
      scope,
    });
    durationsMs.push(performance.now() - startedAt);
    const rankedIds = result.hits.map((hit) => toCorpusId(hit.id));
    const relevant = new Set(query.relevant);
    perQuery.push({
      category: query.category,
      id: query.id,
      ndcg10: round(ndcgAtK(rankedIds, relevant, NDCG_DEPTH)),
      recall20: round(recallAtK(rankedIds, relevant, RECALL_DEPTH)),
      returned: result.hits.length,
    });
  }

  const perCategory: Record<string, MetricPair> = {};
  for (const category of QUERY_CATEGORIES) {
    perCategory[category] = macroAverage(
      perQuery.filter((score) => score.category === category)
    );
  }

  return {
    durationsMs,
    report: {
      engine: name,
      overall: macroAverage(perQuery),
      perCategory,
      perQuery,
    },
  };
};

interface EngineRun {
  cleanup: (() => Promise<void>) | null;
  documents: RelevanceCorpusSummary["documents"][number]["document"][];
  engine: SearchEngine;
  /** The 29 vector schema generates embeddings on every indexed document. */
  hybridSchemaEnabled: boolean;
  mode: "hybrid" | "lexical";
  name: string;
  /** Manticore only: refuse dirty tables before indexing, prove them clean after (RJC-383). */
  preflight: ((phase: "after" | "before") => Promise<void>) | null;
  toCorpusId: (id: string) => string;
}

/** Builds one Manticore EngineRun. Shared by both the default MANTICORE_URL
 * engine and the optional RJC-382 comparison engine below. */
const buildManticoreRun = (
  name: string,
  url: string,
  corpus: RelevanceCorpusSummary,
  mode: "hybrid" | "lexical",
  hybridSchemaEnabled: boolean
): EngineRun => {
  const scoped = scopeBenchmarkDocuments(
    corpus.documents.map((item) => item.document),
    RELEVANCE_SCOPE_ID
  );
  const manticore = ManticoreSearchEngine.fromUrl(
    url,
    new InMemorySearchVersionStore(),
    MANTICORE_BENCH_INDEX_NAME,
    benchClock,
    { hybridEnabled: hybridSchemaEnabled }
  );
  const hygieneTables = hybridSchemaEnabled
    ? MANTICORE_BENCH_HYBRID_TABLES
    : MANTICORE_BENCH_TABLES;
  return {
    cleanup: async () => {
      await cleanupAndAssertManticoreTables(
        name,
        url,
        manticore,
        scoped.documentIds,
        fetch,
        hygieneTables
      );
    },
    documents: scoped.documents,
    engine: manticore,
    hybridSchemaEnabled,
    mode,
    name,
    preflight: async (phase) => {
      await assertCleanManticoreTables(name, url, phase, fetch, hygieneTables);
    },
    toCorpusId: scoped.toCorpusId,
  };
};

/** In-memory always; Manticore when MANTICORE_URL is set (ISC-4: adding an
 * engine here is the only change needed — never in the application layer).
 *
 * RJC-382: an optional second Manticore target for the 6.3.8-vs-29.0.2
 * golden-set comparison. Set MANTICORE_29_URL to score a second engine in
 * the same run (e.g. the manticore29 shadow instance); MANTICORE_29_LABEL
 * optionally names it in the report (e.g. "manticore29-infix"), defaulting
 * to "manticore-29". Both are no-ops when unset, so `bun run relevance`
 * with only MANTICORE_URL set is unaffected. */
const buildEngineRuns = (corpus: RelevanceCorpusSummary): EngineRun[] => {
  const runs: EngineRun[] = [
    {
      cleanup: null,
      documents: corpus.documents.map((item) => item.document),
      engine: new InMemorySearchEngine(undefined, benchClock),
      hybridSchemaEnabled: false,
      mode: "lexical",
      name: "in-memory",
      preflight: null,
      toCorpusId: (id) => id,
    },
  ];
  const manticoreUrl = process.env.MANTICORE_URL?.trim();
  const hybridEvaluation = process.env.SEARCH_HYBRID === "1";
  const manticore29Url = process.env.MANTICORE_29_URL?.trim();
  if (hybridEvaluation && (!manticoreUrl || !manticore29Url)) {
    throw new Error(
      "SEARCH_HYBRID=1 relevance evaluation requires MANTICORE_URL and MANTICORE_29_URL"
    );
  }
  if (manticoreUrl) {
    runs.push(
      buildManticoreRun(
        hybridEvaluation ? "manticore-6.3.8-lexical" : "manticore",
        manticoreUrl,
        corpus,
        "lexical",
        false
      )
    );
  }
  if (manticore29Url) {
    const label = process.env.MANTICORE_29_LABEL?.trim() || "manticore-29";
    if (hybridEvaluation) {
      runs.push(
        buildManticoreRun(
          `${label}-lexical`,
          manticore29Url,
          corpus,
          "lexical",
          true
        ),
        buildManticoreRun(
          `${label}-hybrid`,
          manticore29Url,
          corpus,
          "hybrid",
          true
        )
      );
    } else {
      runs.push(
        buildManticoreRun(label, manticore29Url, corpus, "lexical", false)
      );
    }
  }
  return runs;
};

const COLUMN_WIDTH = 18;
const pad = (value: string): string => value.padEnd(COLUMN_WIDTH);

const printReport = (
  reports: readonly EngineReport[],
  title: string | null = null
): void => {
  if (title !== null) {
    console.log(`\n${title}`);
  }
  const header = [pad("category"), ...reports.map((r) => pad(r.engine))].join(
    ""
  );
  console.log(
    `\n${pad("")}${reports.map(() => pad("recall@20 ndcg@10")).join("")}`
  );
  console.log(header);
  for (const category of QUERY_CATEGORIES) {
    const cells = reports.map((report) => {
      const pair = report.perCategory[category] ?? { ndcg10: 0, recall20: 0 };
      return pad(`${pair.recall20.toFixed(3)}     ${pair.ndcg10.toFixed(3)}`);
    });
    console.log([pad(category), ...cells].join(""));
  }
  const overallCells = reports.map((report) =>
    pad(
      `${report.overall.recall20.toFixed(3)}     ${report.overall.ndcg10.toFixed(3)}`
    )
  );
  console.log([pad("OVERALL (macro)"), ...overallCells].join(""));
};

const printPerformanceReport = (
  reports: readonly EnginePerformance[]
): void => {
  console.log("\nperformance (scope=active query calls)");
  console.log(
    `${pad("engine")}${pad("mode")}${pad("p50 ms")}${pad("p95 ms")}${pad("index docs/s")}${pad("embed docs/s")}`
  );
  for (const report of reports) {
    console.log(
      [
        pad(report.engine),
        pad(report.mode),
        pad(report.p50Ms.toFixed(2)),
        pad(report.p95Ms.toFixed(2)),
        pad(report.indexingDocsPerSecond.toFixed(1)),
        pad(
          report.embeddingDocsPerSecond === null
            ? "n/a"
            : report.embeddingDocsPerSecond.toFixed(1)
        ),
      ].join("")
    );
  }
};

const percentile = (values: readonly number[], pct: number): number => {
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

const runEvaluation = async (): Promise<void> => {
  const corpus = await loadRelevanceCorpus();
  const queries = await loadQueries(
    path.join(import.meta.dirname, "queries.jsonl")
  );
  validateQuerySet(queries, new Set(corpus.documents.map((item) => item.id)));

  console.log(
    `corpus: ${corpus.documents.length} documents from fixtures (${corpus.skipped.length} skipped), queries: ${queries.length}`
  );

  const reports: EngineReport[] = [];
  const activeScopeReports: EngineReport[] = [];
  const performanceReports: EnginePerformance[] = [];
  const runs = buildEngineRuns(corpus);
  for (const run of runs) {
    try {
      if (run.preflight) {
        // oxlint-disable-next-line no-await-in-loop -- must refuse before anything is indexed
        await run.preflight("before");
      }
      const indexingStartedAt = performance.now();
      for (const document of run.documents) {
        // oxlint-disable-next-line no-await-in-loop -- upserts are ordered so both engines index identically
        await run.engine.upsertDocument(document);
      }
      // oxlint-disable-next-line no-await-in-loop -- the index must be complete before it is scored
      await run.engine.applyBatch({ appliedSequence: 1n, mutations: [] });
      const indexingMs = performance.now() - indexingStartedAt;
      // oxlint-disable-next-line no-await-in-loop -- engines are scored one at a time so a shared Manticore index is never measured concurrently
      const allScope = await scoreEngine(
        run.name,
        run.engine,
        queries,
        "all",
        run.toCorpusId,
        run.mode
      );
      reports.push(allScope.report);
      // oxlint-disable-next-line no-await-in-loop -- same engine, same index, second scope
      const activeScope = await scoreEngine(
        run.name,
        run.engine,
        queries,
        "active",
        run.toCorpusId,
        run.mode
      );
      activeScopeReports.push(activeScope.report);
      const indexingDocsPerSecond =
        indexingMs > 0
          ? Number((run.documents.length / (indexingMs / 1000)).toFixed(1))
          : 0;
      performanceReports.push({
        embeddingDocsPerSecond: run.hybridSchemaEnabled
          ? indexingDocsPerSecond
          : null,
        engine: run.name,
        indexingDocsPerSecond,
        indexingMs: Number(indexingMs.toFixed(2)),
        mode: run.mode,
        p50Ms: Number(percentile(activeScope.durationsMs, 50).toFixed(2)),
        p95Ms: Number(percentile(activeScope.durationsMs, 95).toFixed(2)),
        querySamples: activeScope.durationsMs.length,
      });
    } finally {
      if (run.cleanup) {
        // oxlint-disable-next-line no-await-in-loop -- shared 29 tables must be empty before the next mode starts
        await run.cleanup();
      }
    }
  }

  printReport(reports);
  printReport(
    activeScopeReports,
    "scope=active (default search space; archived judgements are unreachable by design)"
  );

  // Deterministic report (no timestamps): two runs on the same corpus and
  // query set produce byte-identical JSON (ISC-5). `engines` is the
  // scope=all history; `enginesActiveScope` is additive (RJC-383).
  const report = {
    corpus: {
      documents: corpus.documents.length,
      skipped: corpus.skipped,
    },
    engines: reports,
    enginesActiveScope: activeScopeReports,
    metrics: { ndcgDepth: NDCG_DEPTH, recallDepth: RECALL_DEPTH },
    queryCount: queries.length,
  };
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written to ${REPORT_PATH}`);

  if (process.env.SEARCH_HYBRID === "1") {
    const performancePath = path.join(
      path.dirname(REPORT_PATH),
      "performance.json"
    );
    await writeFile(
      performancePath,
      `${JSON.stringify({ engines: performanceReports }, null, 2)}\n`
    );
    printPerformanceReport(performanceReports);
    console.log(`performance report written to ${performancePath}`);
  }
};

const main = async (): Promise<void> => {
  const targetUrls = [
    process.env.MANTICORE_URL?.trim(),
    process.env.MANTICORE_29_URL?.trim(),
  ].filter((url): url is string => Boolean(url));
  const releaseLocks = await acquireManticoreBenchmarkLocks(targetUrls);
  try {
    await runEvaluation();
  } finally {
    await releaseLocks();
  }
};

if (import.meta.main) {
  await main();
}
