import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { AANVRAAG_LIFECYCLE, parseBooleanQuery } from "@ji/domain";
import type { SearchEngine, SearchFilters } from "@ji/search";
import {
  InMemorySearchEngine,
  InMemorySearchVersionStore,
  ManticoreSearchEngine,
} from "@ji/search";
import { z } from "zod";

import {
  assertCleanManticoreTables,
  cleanupBenchmarkRuns,
  cleanupAndAssertManticoreTables,
  MANTICORE_BENCH_INDEX_NAME,
  scopeBenchmarkDocuments,
} from "../manticore-hygiene";
import type { RelevanceCorpusDocument } from "./corpus";
import { loadRelevanceCorpus } from "./corpus";

/**
 * Judgment export (step 11 prep, RJC-320 follow-on).
 *
 * Turns queries.jsonl + the fixture corpus into a reviewable sheet: for
 * every query, the pooled candidate documents (union of every engine's
 * top-N plus every already-labeled document) with titel/bron/snippet and
 * an empty grade column for a recruiter to fill in. Pairs with
 * import-judgments.ts, which folds graded rows back.
 *
 * The query schema here is a deliberate small duplicate of run.ts's
 * (unexported) querySchema — see README "Judgments" section for why.
 */

const DEFAULT_POOL_DEPTH = 20;
const SNIPPET_MAX_LENGTH = 200;

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

export type RelevanceQuery = z.infer<typeof querySchema>;

export const loadJudgmentQueries = async (
  queriesPath: string
): Promise<RelevanceQuery[]> => {
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

interface EngineRun {
  cleanup: (() => Promise<void>) | null;
  documents: RelevanceCorpusDocument["document"][];
  engine: SearchEngine;
  name: string;
  preflight: (() => Promise<void>) | null;
  toCorpusId: (id: string) => string;
}

/** Duplicated from run.ts's buildEngineRuns (not exported there) — same
 * env vars, same in-memory-always + optional Manticore(s) shape, so the
 * pool always matches what `bun run relevance` actually scores. */
const buildEngineRuns = (corpus: RelevanceCorpusDocument[]): EngineRun[] => {
  const runs: EngineRun[] = [
    {
      cleanup: null,
      documents: corpus.map((item) => item.document),
      engine: new InMemorySearchEngine(),
      name: "in-memory",
      preflight: null,
      toCorpusId: (id) => id,
    },
  ];
  const manticoreUrl = process.env.MANTICORE_URL?.trim();
  if (manticoreUrl) {
    const scoped = scopeBenchmarkDocuments(corpus.map((item) => item.document));
    const manticore = ManticoreSearchEngine.fromUrl(
      manticoreUrl,
      new InMemorySearchVersionStore(),
      MANTICORE_BENCH_INDEX_NAME
    );
    runs.push({
      cleanup: async () => {
        await cleanupAndAssertManticoreTables(
          "manticore",
          manticoreUrl,
          manticore,
          scoped.documentIds
        );
      },
      documents: scoped.documents,
      engine: manticore,
      name: "manticore",
      preflight: () =>
        assertCleanManticoreTables("manticore", manticoreUrl, "before"),
      toCorpusId: scoped.toCorpusId,
    });
  }
  const manticore29Url = process.env.MANTICORE_29_URL?.trim();
  if (manticore29Url) {
    const label = process.env.MANTICORE_29_LABEL?.trim() || "manticore-29";
    const scoped = scopeBenchmarkDocuments(corpus.map((item) => item.document));
    const manticore29 = ManticoreSearchEngine.fromUrl(
      manticore29Url,
      new InMemorySearchVersionStore(),
      MANTICORE_BENCH_INDEX_NAME
    );
    runs.push({
      cleanup: async () => {
        await cleanupAndAssertManticoreTables(
          label,
          manticore29Url,
          manticore29,
          scoped.documentIds
        );
      },
      documents: scoped.documents,
      engine: manticore29,
      name: label,
      preflight: () =>
        assertCleanManticoreTables(label, manticore29Url, "before"),
      toCorpusId: scoped.toCorpusId,
    });
  }
  return runs;
};

/** Escapes one CSV field for a ';'-delimited file (Dutch Excel default). */
export const csvField = (value: string): string => {
  if (/[";\n\r]/u.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
};

const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

/** OWASP CSV-injection guard: a titel/snippet starting with =, +, - or @
 * would execute as a formula when the CSV is opened in Excel. Prefixing
 * with a single quote forces Excel to treat the cell as text. Apply to
 * every free-text column that carries corpus data — titel and snippet
 * here; comment would need the same treatment if it were ever populated
 * on export (today it is always blank — the recruiter fills it in).
 * Import never reads titel/bron/snippet back (see CsvColumns: only
 * query_id, doc_id, grade, comment are keys), so there is nothing to
 * strip on the way in. */
export const sanitizeFormulaCell = (value: string): string =>
  FORMULA_TRIGGER_CHARS.has(value.charAt(0)) ? `'${value}` : value;

/** Collapses a description to a single line and caps it, so the sheet
 * stays scannable and CSV rows stay one line each. */
export const toSnippet = (beschrijving: string): string => {
  const oneLine = beschrijving.replaceAll(/\s+/gu, " ").trim();
  return oneLine.length > SNIPPET_MAX_LENGTH
    ? `${oneLine.slice(0, SNIPPET_MAX_LENGTH - 1)}…`
    : oneLine;
};

type Label = "relevant" | "hardNegative" | "unlabeled";

const labelOf = (query: RelevanceQuery, docId: string): Label => {
  if (query.relevant.includes(docId)) {
    return "relevant";
  }
  if (query.hardNegatives.includes(docId)) {
    return "hardNegative";
  }
  return "unlabeled";
};

interface PoolRow {
  bron: string;
  currentLabel: Label;
  docId: string;
  query: RelevanceQuery;
  snippet: string;
  titel: string;
}

const buildPool = async (
  queries: readonly RelevanceQuery[],
  corpusById: ReadonlyMap<string, RelevanceCorpusDocument>,
  runs: readonly EngineRun[],
  poolDepth: number
): Promise<PoolRow[]> => {
  const rows: PoolRow[] = [];
  for (const query of queries) {
    const parsed = parseBooleanQuery(query.query);
    if (!parsed.ok) {
      throw new Error(
        `query ${query.id} failed to parse: ${parsed.error.message}`
      );
    }
    // SAFETY: filtersSchema mirrors SearchFilters field-for-field; zod has
    // already validated shape.
    const filters: SearchFilters = query.filters ?? {};
    const poolIds = new Set<string>([
      ...query.relevant,
      ...query.hardNegatives,
    ]);
    for (const run of runs) {
      // oxlint-disable-next-line no-await-in-loop -- queries run sequentially for stable, comparable output
      const result = await run.engine.search({
        ast: parsed.ast,
        filters,
        limit: poolDepth,
        offset: 0,
      });
      for (const hit of result.hits) {
        poolIds.add(run.toCorpusId(hit.id));
      }
    }
    const sortedIds = [...poolIds].toSorted((left, right) =>
      left.localeCompare(right)
    );
    for (const docId of sortedIds) {
      const doc = corpusById.get(docId);
      if (!doc) {
        throw new Error(`query ${query.id} pooled unknown document: ${docId}`);
      }
      rows.push({
        bron: doc.slug,
        currentLabel: labelOf(query, docId),
        docId,
        query,
        snippet: toSnippet(doc.document.beschrijving),
        titel: doc.document.titel,
      });
    }
  }
  return rows;
};

export const CSV_HEADER = [
  "query_id",
  "category",
  "query",
  "filters_json",
  "doc_id",
  "bron",
  "titel",
  "snippet",
  "current_label",
  "grade",
  "comment",
] as const;

const toCsv = (rows: readonly PoolRow[]): string => {
  const lines = [CSV_HEADER.join(";")];
  for (const row of rows) {
    lines.push(
      [
        row.query.id,
        row.query.category,
        row.query.query,
        JSON.stringify(row.query.filters ?? {}),
        row.docId,
        row.bron,
        sanitizeFormulaCell(row.titel),
        sanitizeFormulaCell(row.snippet),
        row.currentLabel,
        "",
        "",
      ]
        .map(csvField)
        .join(";")
    );
  }
  return `${lines.join("\n")}\n`;
};

const toMarkdown = (
  queries: readonly RelevanceQuery[],
  rows: readonly PoolRow[]
): string => {
  const byQuery = new Map<string, PoolRow[]>();
  for (const row of rows) {
    const bucket = byQuery.get(row.query.id) ?? [];
    bucket.push(row);
    byQuery.set(row.query.id, bucket);
  }
  const sections: string[] = ["# Relevance judgments\n"];
  for (const query of queries) {
    const bucket = byQuery.get(query.id) ?? [];
    sections.push(
      `## ${query.id} — ${query.category}`,
      `**query:** \`${query.query}\``,
      `**filters:** \`${JSON.stringify(query.filters ?? {})}\``,
      "",
      "| doc_id | bron | titel | snippet | current | grade | comment |",
      "|---|---|---|---|---|---|---|",
      ...bucket.map(
        (row) =>
          `| ${row.docId} | ${row.bron} | ${row.titel} | ${row.snippet} | ${row.currentLabel} |  |  |`
      ),
      ""
    );
  }
  return `${sections.join("\n")}\n`;
};

interface Args {
  outPath: string;
  poolDepth: number;
}

const parseArgs = (argv: readonly string[]): Args => {
  let outPath = path.join(
    "benchmarks",
    "relevance",
    "judgments",
    `${new Date().toISOString().slice(0, 10)}.csv`
  );
  let poolDepth = DEFAULT_POOL_DEPTH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      index += 1;
      outPath = argv[index] ?? outPath;
    } else if (arg === "--pool-depth") {
      index += 1;
      poolDepth = Number(argv[index]);
    }
  }
  if (!Number.isFinite(poolDepth) || poolDepth <= 0) {
    throw new Error(`--pool-depth must be a positive number, got ${poolDepth}`);
  }
  return { outPath, poolDepth };
};

export interface ExportJudgmentsOptions {
  /** CSV target; the `.md` twin lands next to it. */
  outPath: string;
  /** Top-N per engine pooled into the sheet (default 20). */
  poolDepth?: number;
  /** Defaults to the committed `queries.jsonl` beside this module. */
  queriesPath?: string;
}

export interface ExportJudgmentsResult {
  csvPath: string;
  mdPath: string;
  queryCount: number;
  rowCount: number;
}

/**
 * The whole export as one in-process call. `main` below is a thin CLI over
 * it; the spec calls this directly so the determinism check never has to
 * boot a second Bun runtime (and re-transpile the workspace) per run —
 * that spawn cost is what made the CLI-only test exceed the default 5 s
 * per-test budget under load (see docs/runbooks/gate-flaky-tests.md).
 */
export const exportJudgments = async (
  options: ExportJudgmentsOptions
): Promise<ExportJudgmentsResult> => {
  const { outPath } = options;
  const poolDepth = options.poolDepth ?? DEFAULT_POOL_DEPTH;
  const queriesPath =
    options.queriesPath ?? path.join(import.meta.dirname, "queries.jsonl");
  const corpus = await loadRelevanceCorpus();
  const queries = await loadJudgmentQueries(queriesPath);
  const corpusById = new Map(
    corpus.documents.map((item) => [item.id, item] as const)
  );

  const runs = buildEngineRuns(corpus.documents);
  for (const run of runs) {
    if (run.preflight) {
      // oxlint-disable-next-line no-await-in-loop -- every target must prove its dedicated tables empty before any writes
      await run.preflight();
    }
  }
  try {
    for (const run of runs) {
      for (const document of run.documents) {
        // oxlint-disable-next-line no-await-in-loop -- upserts ordered so all engines index identically
        await run.engine.upsertDocument(document);
      }
    }
    for (const run of runs) {
      // oxlint-disable-next-line no-await-in-loop -- sequential is fine at this scale
      await run.engine.applyBatch({ appliedSequence: 1n, mutations: [] });
    }

    const rows = await buildPool(queries, corpusById, runs, poolDepth);

    await mkdir(path.dirname(outPath), { recursive: true });
    // BOM prefix: Dutch Excel opens ';'-delimited UTF-8 CSVs correctly with one.
    await writeFile(outPath, `﻿${toCsv(rows)}`);
    const mdPath = outPath.replace(/\.csv$/u, ".md");
    await writeFile(mdPath, toMarkdown(queries, rows));

    return {
      csvPath: outPath,
      mdPath,
      queryCount: queries.length,
      rowCount: rows.length,
    };
  } finally {
    await cleanupBenchmarkRuns(runs);
  }
};

const main = async (): Promise<void> => {
  const { outPath, poolDepth } = parseArgs(process.argv.slice(2));
  const result = await exportJudgments({ outPath, poolDepth });
  console.log(
    `wrote ${result.rowCount} pooled rows across ${result.queryCount} queries to ${result.csvPath} (+ ${result.mdPath})`
  );
};

if (import.meta.main) {
  await main();
}
