/**
 * Scaling probe: duplicates the real corpus (documentId suffixed `~dupN`,
 * clearly synthetic, used ONLY to measure cost scaling — not relevance) to
 * successively larger table sizes and measures, at each size:
 *  - fullScanFacets (the no-term facet path) — expected to die on Convex's
 *    16MiB bytes-read-per-function limit at ~3.1k of our ~5.3KB documents;
 *  - countAll (exact total with no search term) — same death expected;
 *  - searchPage on the broadest corpus term ("gemeente") — expected to hit
 *    the 1024-scanned-results ceiling once matches exceed 1024, silently
 *    making totals and search-scoped facets wrong.
 *
 * Every failure is captured and recorded, and results are flushed to
 * scale-measurements.json after each step, so a mid-run limit error is data
 * rather than a crash.
 *
 * Run from this directory with the local backend up:
 *   bun run scale.ts
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

const BATCH_SIZE = 50;
const CLEAR_BATCH = 200;
const TIMING_RUNS = 10;

const percentile = (sorted: number[], p: number): number => {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, index)];
};

interface ProbeOutcome<Result> {
  error?: string;
  p50Ms?: number;
  p95Ms?: number;
  result?: Result;
}

const probe = async <Result>(
  run: () => Promise<Result>
): Promise<ProbeOutcome<Result>> => {
  const samples: number[] = [];
  let result: Result | undefined;
  for (let index = 0; index < TIMING_RUNS; index += 1) {
    const start = performance.now();
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential timing
      result = await run();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    result,
  };
};

const clearTable = async (client: ConvexHttpClient): Promise<number> => {
  let deleted = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- batched deletes in order
    const batch = await client.mutation(api.ingest.clearBatch, {
      limit: CLEAR_BATCH,
    });
    deleted += batch.deleted;
    if (batch.done) {
      return deleted;
    }
  }
};

interface BroadSearchOutcome {
  ceilingHit: boolean;
  scanned: number;
  total: number;
}

interface ScaleStep {
  broadSearchGemeente: ProbeOutcome<BroadSearchOutcome>;
  countAll: ProbeOutcome<{ count: number }>;
  fullScanFacets: ProbeOutcome<{ scanned: number }>;
  tableSize: number;
}

const main = async (): Promise<void> => {
  const url = await readEnvUrl();
  const client = new ConvexHttpClient(url);
  const corpus: CorpusDocument[] = JSON.parse(
    await readFile(path.join(HERE, "corpus.json"), "utf-8")
  );

  const cleared = await clearTable(client);
  console.log(`cleared ${cleared} rows`);

  const targets = [33, 1056, 2112, 3168, 8448];
  const steps: ScaleStep[] = [];
  let tableSize = 0;
  let generation = 0;
  const outPath = path.join(HERE, "scale-measurements.json");

  for (const target of targets) {
    const toAdd: CorpusDocument[] = [];
    while (tableSize + toAdd.length < target) {
      const doc = corpus[(tableSize + toAdd.length) % corpus.length];
      const isOriginal = generation < corpus.length && tableSize === 0;
      generation += 1;
      toAdd.push(
        isOriginal && generation <= corpus.length
          ? doc
          : { ...doc, documentId: `${doc.documentId}~dup${generation}` }
      );
    }
    for (let index = 0; index < toAdd.length; index += BATCH_SIZE) {
      // oxlint-disable-next-line no-await-in-loop -- ordered write batches
      await client.mutation(api.ingest.upsertBatch, {
        documents: toAdd.slice(index, index + BATCH_SIZE),
      });
    }
    tableSize = target;

    // oxlint-disable-next-line no-await-in-loop -- sequential scaling probes
    const broadSearchGemeente = await probe(async () => {
      const result = await client.query(api.search.searchPage, {
        limit: 20,
        offset: 0,
        term: "gemeente",
      });
      return {
        ceilingHit: result.ceilingHit,
        scanned: result.scanned,
        total: result.total,
      };
    });
    // oxlint-disable-next-line no-await-in-loop -- sequential scaling probes
    const countAllOutcome = await probe(() =>
      client.query(api.ingest.countAll, {})
    );
    // oxlint-disable-next-line no-await-in-loop -- sequential scaling probes
    const fullScanFacets = await probe(async () => {
      const result = await client.query(api.search.fullScanFacets, {});
      return { scanned: result.scanned };
    });

    const step: ScaleStep = {
      broadSearchGemeente,
      countAll: countAllOutcome,
      fullScanFacets,
      tableSize,
    };
    steps.push(step);
    // oxlint-disable-next-line no-await-in-loop -- flush after every step
    await writeFile(
      outPath,
      JSON.stringify({ steps, timingRunsPerPoint: TIMING_RUNS }, null, 2)
    );
    console.log(
      JSON.stringify({
        countAllError: step.countAll.error?.slice(0, 80),
        fullScanError: step.fullScanFacets.error?.slice(0, 80),
        fullScanP50: step.fullScanFacets.p50Ms,
        search:
          step.broadSearchGemeente.error?.slice(0, 80) ??
          step.broadSearchGemeente.result,
        tableSize,
      })
    );
  }

  // Leave a clean base state behind for anyone re-running measure.ts.
  await clearTable(client);
  for (let index = 0; index < corpus.length; index += BATCH_SIZE) {
    // oxlint-disable-next-line no-await-in-loop -- ordered write batches
    await client.mutation(api.ingest.upsertBatch, {
      documents: corpus.slice(index, index + BATCH_SIZE),
    });
  }
  console.log("restored base corpus; wrote scale-measurements.json");
};

await main();
