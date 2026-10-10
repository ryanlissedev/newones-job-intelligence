/**
 * Measurement harness for the Convex search slice.
 *
 * Ingests corpus.json into the local anonymous Convex deployment, then runs
 * the query set and records per-query latency (p50/p95) plus per-criterion
 * behaviour (boolean semantics, Dutch morphology, facet cost). Writes
 * measurements.json next to this file.
 *
 * Run from this directory with the local backend up (npx convex dev):
 *   GOLDEN_QUERIES_PATH=../../benchmarks/relevance/queries.jsonl bun run measure.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConvexHttpClient } from "convex/browser";

import { api } from "./convex/_generated/api";

interface CorpusDocument {
  beschrijving: string;
  bronId: string;
  contracttype: string;
  documentId: string;
  laatstGezienOp: number;
  locatieLand: string;
  status: string;
  tariefMax: number;
  tariefMin: number;
  titel: string;
  zoektekst: string;
}

const HERE = path.dirname(new URL(import.meta.url).pathname);

const readEnvUrl = async (): Promise<string> => {
  const raw = await readFile(path.join(HERE, ".env.local"), "utf-8");
  const url = raw.match(/^CONVEX_URL=(?<url>.+)$/mu)?.groups?.url;
  if (!url) {
    throw new Error("CONVEX_URL not found in .env.local");
  }
  return url.trim();
};

const percentile = (sorted: number[], p: number): number => {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, index)];
};

interface LatencyStats {
  iterations: number;
  maxMs: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
}

const WARMUP = 5;
const ITERATIONS = 50;

const timed = async <Result>(
  run: () => Promise<Result>
): Promise<{ lastResult: Result; stats: LatencyStats }> => {
  for (let index = 0; index < WARMUP; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential timing by design
    await run();
  }
  const samples: number[] = [];
  let lastResult: Result | undefined;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- sequential timing by design
    lastResult = await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    // SAFETY: ITERATIONS > 0, so the loop above assigned lastResult.
    lastResult: lastResult as Result,
    stats: {
      iterations: ITERATIONS,
      maxMs: samples.at(-1) ?? 0,
      meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      minMs: samples[0] ?? 0,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
    },
  };
};

const BATCH_SIZE = 50;

const ingest = async (
  client: ConvexHttpClient,
  documents: CorpusDocument[]
): Promise<{ created: number; ms: number; updated: number }> => {
  const start = performance.now();
  let created = 0;
  let updated = 0;
  for (let index = 0; index < documents.length; index += BATCH_SIZE) {
    // oxlint-disable-next-line no-await-in-loop -- write batches in order
    const result = await client.mutation(api.ingest.upsertBatch, {
      documents: documents.slice(index, index + BATCH_SIZE),
    });
    created += result.created;
    updated += result.updated;
  }
  return { created, ms: performance.now() - start, updated };
};

/** Ground truth computed client-side over the corpus: documents containing
 * `word` as a whole word (the engine tokenizes on word boundaries). */
const wordCount = (documents: CorpusDocument[], word: string): number => {
  const pattern = new RegExp(`\\b${word}\\b`, "iu");
  return documents.filter((doc) => pattern.test(doc.zoektekst)).length;
};

interface PlainSearchEntry {
  ceilingHit: boolean;
  stats: LatencyStats;
  topHits: string[];
  total: number;
}

interface PaginationEntry {
  hits: number;
  stats: LatencyStats;
}

interface MorphologyEntry {
  corpusWordCounts: Record<string, number>;
  searchPluralTotal: number;
  searchSingularTotal: number;
}

interface GoldenQueryEntry {
  category: string;
  found: number;
  hardNegativesInTop20: number;
  query: string;
  recallAt20: number;
  relevant: number;
  total: number;
}

interface GoldenSummary {
  meanRecallAt20: number;
  p50Ms: number;
  p95Ms: number;
  perCategoryMeanRecallAt20: Record<string, number>;
  perQuery: Record<string, GoldenQueryEntry>;
  queries: number;
  source: string;
}

interface GoldenLine {
  category: string;
  hardNegatives?: string[];
  id: string;
  query: string;
  relevant: string[];
}

const evaluateGoldenSet = async (
  client: ConvexHttpClient,
  goldenPath: string
): Promise<GoldenSummary> => {
  const raw = await readFile(goldenPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const perQuery: Record<string, GoldenQueryEntry> = {};
  const recallByCategory = new Map<string, number[]>();
  const latencies: number[] = [];
  for (const line of lines) {
    // SAFETY: queries.jsonl is a repo-owned benchmark file with a fixed,
    // hand-maintained line shape; a malformed line should crash the run.
    const golden = JSON.parse(line) as GoldenLine;
    const start = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- sequential evaluation
    const result = await client.query(api.search.searchPage, {
      limit: 20,
      offset: 0,
      term: golden.query,
    });
    latencies.push(performance.now() - start);
    const top20 = new Set(result.hits.map((hit) => hit.id));
    const found = golden.relevant.filter((id) => top20.has(id));
    const recall = golden.relevant.length
      ? found.length / golden.relevant.length
      : 0;
    const negativesRanked = (golden.hardNegatives ?? []).filter((id) =>
      top20.has(id)
    );
    const bucket = recallByCategory.get(golden.category) ?? [];
    bucket.push(recall);
    recallByCategory.set(golden.category, bucket);
    perQuery[golden.id] = {
      category: golden.category,
      found: found.length,
      hardNegativesInTop20: negativesRanked.length,
      query: golden.query,
      recallAt20: recall,
      relevant: golden.relevant.length,
      total: result.total,
    };
  }
  latencies.sort((a, b) => a - b);
  const categorySummary: Record<string, number> = {};
  let sum = 0;
  let count = 0;
  for (const [category, values] of recallByCategory) {
    categorySummary[category] =
      values.reduce((acc, value) => acc + value, 0) / values.length;
    sum += values.reduce((acc, value) => acc + value, 0);
    count += values.length;
  }
  return {
    meanRecallAt20: count ? sum / count : 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    perCategoryMeanRecallAt20: categorySummary,
    perQuery,
    queries: lines.length,
    source: goldenPath,
  };
};

const main = async (): Promise<void> => {
  const url = await readEnvUrl();
  const client = new ConvexHttpClient(url);
  const corpus: CorpusDocument[] = JSON.parse(
    await readFile(path.join(HERE, "corpus.json"), "utf-8")
  );

  console.log(`corpus: ${corpus.length} documents`);
  const ingestResult = await ingest(client, corpus);
  const countAfter = await client.query(api.ingest.countAll, {});
  console.log(
    `ingested created=${ingestResult.created} updated=${ingestResult.updated} in ${Math.round(ingestResult.ms)}ms; countAll=${countAfter.count}`
  );

  // --- Criterion 1: plain text search + pagination + exact total ---------
  // Terms chosen from the actual corpus (verified present via grep before
  // measuring), spanning rare (1-2 docs) to broad (most docs).
  const plainQueries = [
    "ontwikkelaar",
    "projectleider",
    "beleidsadviseur",
    "engineer",
    "jurist",
    "adviseur",
    "gemeente",
    "inkoop",
  ];
  const plainSearch: Record<string, PlainSearchEntry> = {};
  for (const term of plainQueries) {
    // oxlint-disable-next-line no-await-in-loop -- sequential measurement
    const { lastResult, stats } = await timed(() =>
      client.query(api.search.searchPage, { limit: 20, offset: 0, term })
    );
    plainSearch[term] = {
      ceilingHit: lastResult.ceilingHit,
      stats,
      topHits: lastResult.hits.slice(0, 5).map((hit) => hit.id),
      total: lastResult.total,
    };
  }

  // Pagination depth on a broad term.
  const pagination: Record<string, PaginationEntry> = {};
  for (const offset of [0, 20, 100]) {
    // oxlint-disable-next-line no-await-in-loop -- sequential measurement
    const { lastResult, stats } = await timed(() =>
      client.query(api.search.searchPage, {
        limit: 20,
        offset,
        term: "adviseur",
      })
    );
    pagination[`offset_${offset}`] = { hits: lastResult.hits.length, stats };
  }

  // Filtered search (facet filter applied).
  const filtered = await timed(() =>
    client.query(api.search.searchPage, {
      limit: 20,
      locatieLand: ["NL"],
      offset: 0,
      status: ["open"],
      term: "adviseur",
    })
  );

  // --- Criterion 2: boolean semantics ------------------------------------
  // Manticore surface: (azure | "platform engineer") -intern over
  // titel+beschrijving. Convex native .search() has no operators; measure
  // what native multi-term does vs the JS post-filter approximation.
  const nativeMultiTerm = await timed(() =>
    client.query(api.search.searchPage, {
      limit: 20,
      offset: 0,
      term: "azure platform engineer",
    })
  );
  const groundTruthBoolean = corpus.filter((doc) => {
    const text = doc.zoektekst.toLowerCase();
    return (
      (text.includes("azure") || text.includes("platform engineer")) &&
      !text.includes("intern")
    );
  }).length;
  const booleanApprox = await timed(() =>
    client.query(api.search.booleanSearch, {
      limit: 20,
      mustTerms: [],
      notTerms: ["intern"],
      offset: 0,
      orTerms: ["azure", "platform engineer"],
    })
  );
  const negationOnly = await timed(() =>
    client.query(api.search.booleanSearch, {
      limit: 20,
      mustTerms: ["adviseur"],
      notTerms: ["senior"],
      offset: 0,
      orTerms: [],
    })
  );

  // --- Criterion 3: Dutch morphology --------------------------------------
  const morphologyPairs: [string, string][] = [
    ["ontwikkelaar", "ontwikkelaars"],
    ["adviseur", "adviseurs"],
    ["gemeente", "gemeenten"],
    ["applicatie", "applicaties"],
  ];
  const morphology: Record<string, MorphologyEntry> = {};
  for (const [singular, plural] of morphologyPairs) {
    // oxlint-disable-next-line no-await-in-loop -- sequential measurement
    const singularHit = await client.query(api.search.searchPage, {
      limit: 100,
      offset: 0,
      term: singular,
    });
    // oxlint-disable-next-line no-await-in-loop -- sequential measurement
    const pluralHit = await client.query(api.search.searchPage, {
      limit: 100,
      offset: 0,
      term: plural,
    });
    morphology[`${singular}/${plural}`] = {
      corpusWordCounts: {
        [plural]: wordCount(corpus, plural),
        [singular]: wordCount(corpus, singular),
      },
      searchPluralTotal: pluralHit.total,
      searchSingularTotal: singularHit.total,
    };
  }

  // --- Criterion 4: facets -------------------------------------------------
  const facetsNoTerm = await timed(() =>
    client.query(api.search.fullScanFacets, {})
  );
  const facetsWithTerm = await timed(() =>
    client.query(api.search.searchPage, {
      limit: 0,
      offset: 0,
      term: "adviseur",
    })
  );

  // --- Golden relevance set (built in a parallel lane, read-only) ---------
  const goldenPath = process.env.GOLDEN_QUERIES_PATH;
  const goldenSet: GoldenSummary | { note: string } = goldenPath
    ? await evaluateGoldenSet(client, goldenPath)
    : { note: "GOLDEN_QUERIES_PATH not set — golden set not evaluated" };

  const results = {
    boolean: {
      groundTruthClientSide: groundTruthBoolean,
      jsPostFilter: {
        ceilingHit: booleanApprox.lastResult.ceilingHit,
        stats: booleanApprox.stats,
        total: booleanApprox.lastResult.total,
      },
      nativeMultiTerm: {
        note: "native .search() semantics for 'azure platform engineer' — no operators, match-any ranked",
        stats: nativeMultiTerm.stats,
        total: nativeMultiTerm.lastResult.total,
      },
      negationAdviseurNotSenior: {
        groundTruthClientSide: corpus.filter((doc) => {
          const text = doc.zoektekst.toLowerCase();
          return text.includes("adviseur") && !text.includes("senior");
        }).length,
        stats: negationOnly.stats,
        total: negationOnly.lastResult.total,
      },
    },
    corpusSize: corpus.length,
    countAll: countAfter.count,
    facets: {
      fullScanNoTerm: {
        facets: facetsNoTerm.lastResult.facets,
        scanned: facetsNoTerm.lastResult.scanned,
        stats: facetsNoTerm.stats,
      },
      withSearchTerm: {
        ceilingHit: facetsWithTerm.lastResult.ceilingHit,
        facets: facetsWithTerm.lastResult.facets,
        scanned: facetsWithTerm.lastResult.scanned,
        stats: facetsWithTerm.stats,
      },
    },
    filteredSearch: {
      stats: filtered.stats,
      total: filtered.lastResult.total,
    },
    goldenSet,
    ingest: ingestResult,
    iterationsPerQuery: ITERATIONS,
    morphology,
    pagination,
    plainSearch,
    startedAt: new Date().toISOString(),
  };

  await writeFile(
    path.join(HERE, "measurements.json"),
    JSON.stringify(results, null, 2)
  );
  console.log("wrote measurements.json");
};

await main();
