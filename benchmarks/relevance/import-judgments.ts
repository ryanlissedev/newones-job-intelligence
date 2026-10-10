import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRelevanceCorpus } from "./corpus";
import { CSV_HEADER, loadJudgmentQueries } from "./export-judgments";
import type { RelevanceQuery } from "./export-judgments";

/**
 * Judgment import (step 11 prep, RJC-320 follow-on). Folds a graded
 * export-judgments.ts CSV back into queries.jsonl deterministically.
 *
 * IMPORTANT deviation from the original ask: provenance is NOT written as
 * a `judgments` field on the query object. run.ts's querySchema is
 * `.strict()`, so an unknown key would make every future `bun run
 * relevance` throw at parse time for anyone who actually uses this
 * import — and run.ts is out of scope for this change. Provenance instead
 * goes to a sibling ledger, judgments/provenance.jsonl (one line per
 * touched query per import run: queryId, grader, date, source), which
 * keeps queries.jsonl's shape exactly what run.ts already parses.
 */

const DEFAULT_PROVENANCE_PATH = path.join(
  "benchmarks",
  "relevance",
  "judgments",
  "provenance.jsonl"
);

export type Grade = "0" | "1" | "2";

export const isGrade = (value: string): value is Grade =>
  value === "0" || value === "1" || value === "2";

interface GradedEntry {
  comment: string;
  grade: Grade;
  rowIndex: number;
}

/** Minimal RFC4180-ish parser for the ';'-delimited CSV export-judgments.ts
 * writes: quoted fields, doubled-quote escaping, embedded delimiters and
 * newlines inside quotes. */
export const parseCsv = (text: string): string[][] => {
  const cleaned = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  while (index < cleaned.length) {
    const char = cleaned[index];
    if (inQuotes) {
      if (char === '"') {
        if (cleaned[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ";") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(
    (parsedRow) => !(parsedRow.length === 1 && parsedRow[0] === "")
  );
};

const columnIndex = (header: readonly string[], name: string): number => {
  const found = header.indexOf(name);
  if (found === -1) {
    throw new Error(
      `CSV header is missing required column "${name}" (expected: ${CSV_HEADER.join(", ")})`
    );
  }
  return found;
};

export interface Args {
  /** Refuses (unless set) an import that would leave a query with zero
   * relevant docs — run.ts's querySchema requires relevant.min(1), so an
   * empty array rejects the whole golden set on the next `bun run
   * relevance`. Even with this set, such a query still needs re-pooling
   * or removal by an engineer (see README) before it scores again. */
  allowEmptyRelevant?: boolean;
  dryRun: boolean;
  filePath: string;
  grader: string;
  preferLatest: boolean;
  /** Defaults to the real committed queries.jsonl next to this script. */
  queriesPath?: string;
  /** Defaults to judgments/provenance.jsonl next to this script. */
  provenancePath?: string;
}

export const parseArgs = (argv: readonly string[]): Args => {
  let filePath: string | undefined;
  let grader: string | undefined;
  let dryRun = false;
  let preferLatest = false;
  let allowEmptyRelevant = false;
  let queriesPath: string | undefined;
  let provenancePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      index += 1;
      filePath = argv[index];
    } else if (arg === "--grader") {
      index += 1;
      grader = argv[index];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--prefer-latest") {
      preferLatest = true;
    } else if (arg === "--allow-empty-relevant") {
      allowEmptyRelevant = true;
    } else if (arg === "--queries") {
      index += 1;
      queriesPath = argv[index];
    } else if (arg === "--provenance") {
      index += 1;
      provenancePath = argv[index];
    }
  }
  if (!filePath) {
    throw new Error("--file <csv> is required");
  }
  if (!grader) {
    throw new Error("--grader <name> is required");
  }
  return {
    allowEmptyRelevant,
    dryRun,
    filePath,
    grader,
    preferLatest,
    provenancePath,
    queriesPath,
  };
};

const sortUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].toSorted((left, right) => left.localeCompare(right));

export interface QueryDiff {
  addedHardNegative: string[];
  addedRelevant: string[];
  id: string;
}

export type ImportOutcome =
  | { conflicts: string[]; kind: "conflicts" }
  | { emptyRelevantQueryIds: string[]; kind: "empty-relevant" }
  | { diffs: QueryDiff[]; dryRun: boolean; kind: "ok" }
  | { kind: "unknown-ids"; unknownDocIds: string[]; unknownQueryIds: string[] };

export type RunImportOptions = Args;

interface CsvColumns {
  comment: number;
  docId: number;
  grade: number;
  queryId: number;
}

/** queryId -> docId -> every graded row for that pair. Nested maps (not a
 * "queryId docId" string key) so a docId containing a space can never be
 * misparsed. */
type ByQueryDoc = Map<string, Map<string, GradedEntry[]>>;

const addGradedEntry = (
  byQueryDoc: ByQueryDoc,
  queryId: string,
  docId: string,
  entry: GradedEntry
): void => {
  const byDoc = byQueryDoc.get(queryId) ?? new Map<string, GradedEntry[]>();
  const entries = byDoc.get(docId) ?? [];
  entries.push(entry);
  byDoc.set(docId, entries);
  byQueryDoc.set(queryId, byDoc);
};

interface ExtractedGradedEntries {
  byQueryDoc: ByQueryDoc;
  unknownDocIds: string[];
  unknownQueryIds: Set<string>;
}

/** Groups every graded data row by (queryId, docId), reporting any id not
 * known to the query set or the corpus along the way. */
const extractGradedEntries = (
  dataRows: readonly string[][],
  columns: CsvColumns,
  queryById: ReadonlyMap<string, RelevanceQuery>,
  corpusIds: ReadonlySet<string>
): ExtractedGradedEntries => {
  const unknownQueryIds = new Set<string>();
  const unknownDocIds: string[] = [];
  const byQueryDoc: ByQueryDoc = new Map();

  for (const [rowIndex, row] of dataRows.entries()) {
    if (row.every((cell) => cell.trim() === "")) {
      continue;
    }
    const grade = (row[columns.grade] ?? "").trim();
    if (grade === "") {
      continue;
    }
    const queryId = (row[columns.queryId] ?? "").trim();
    const docId = (row[columns.docId] ?? "").trim();
    if (!queryById.has(queryId)) {
      unknownQueryIds.add(queryId);
      continue;
    }
    if (!corpusIds.has(docId)) {
      unknownDocIds.push(`${queryId}:${docId}`);
      continue;
    }
    if (!isGrade(grade)) {
      throw new Error(
        `row ${rowIndex + 2}: grade "${grade}" is invalid (expected 0, 1, or 2) for ${queryId}/${docId}`
      );
    }
    addGradedEntry(byQueryDoc, queryId, docId, {
      comment: (row[columns.comment] ?? "").trim(),
      grade,
      rowIndex,
    });
  }
  return { byQueryDoc, unknownDocIds, unknownQueryIds };
};

/** The single winning grade per docId, once conflicts are resolved. */
type Resolved = Map<string, Map<string, GradedEntry>>;

interface ResolvedGradedEntries {
  conflicts: string[];
  resolved: Resolved;
}

const pickWinner = (entries: readonly GradedEntry[]): GradedEntry => {
  let winner: GradedEntry | undefined;
  for (const entry of entries) {
    if (winner === undefined || entry.rowIndex > winner.rowIndex) {
      winner = entry;
    }
  }
  // SAFETY: entries only ever reaches this function via addGradedEntry,
  // which always pushes at least one element before the map holds the key.
  return winner as GradedEntry;
};

/** Resolves each (queryId, docId) group to its single winning grade,
 * refusing (unless preferLatest) when a group disagrees. */
const resolveGradedEntries = (
  byQueryDoc: ByQueryDoc,
  preferLatest: boolean
): ResolvedGradedEntries => {
  const conflicts: string[] = [];
  const resolved: Resolved = new Map();
  for (const [queryId, byDoc] of byQueryDoc) {
    for (const [docId, entries] of byDoc) {
      const distinctGrades = new Set(entries.map((entry) => entry.grade));
      if (distinctGrades.size > 1 && !preferLatest) {
        conflicts.push(
          `${queryId}/${docId}: grades ${entries.map((entry) => entry.grade).join(", ")} (rows ${entries.map((entry) => entry.rowIndex + 2).join(", ")})`
        );
        continue;
      }
      const resolvedForQuery =
        resolved.get(queryId) ?? new Map<string, GradedEntry>();
      resolvedForQuery.set(docId, pickWinner(entries));
      resolved.set(queryId, resolvedForQuery);
    }
  }
  return { conflicts, resolved };
};

interface DiffResult {
  diffs: Map<string, QueryDiff>;
  updatedHardNegatives: Map<string, Set<string>>;
  updatedRelevant: Map<string, Set<string>>;
}

/** Applies each resolved grade to a per-query working copy of
 * relevant/hardNegatives, tracking what changed. */
const buildDiffs = (
  resolved: Resolved,
  queryById: ReadonlyMap<string, RelevanceQuery>
): DiffResult => {
  const diffs = new Map<string, QueryDiff>();
  const updatedRelevant = new Map<string, Set<string>>();
  const updatedHardNegatives = new Map<string, Set<string>>();

  for (const [queryId, byDoc] of resolved) {
    const query = queryById.get(queryId);
    if (!query) {
      continue;
    }
    const relevantSet = new Set(query.relevant);
    const hardNegativeSet = new Set(query.hardNegatives);
    const diff: QueryDiff = {
      addedHardNegative: [],
      addedRelevant: [],
      id: queryId,
    };
    for (const [docId, entry] of byDoc) {
      if (entry.grade === "0") {
        hardNegativeSet.add(docId);
        relevantSet.delete(docId);
        diff.addedHardNegative.push(docId);
      } else {
        relevantSet.add(docId);
        hardNegativeSet.delete(docId);
        diff.addedRelevant.push(docId);
      }
    }
    updatedRelevant.set(queryId, relevantSet);
    updatedHardNegatives.set(queryId, hardNegativeSet);
    diffs.set(queryId, diff);
  }
  return { diffs, updatedHardNegatives, updatedRelevant };
};

/** Builds the note appended to a query left with zero relevant docs by
 * an `--allow-empty-relevant` import — run.ts's querySchema still
 * rejects it (relevant.min(1)), so this is a flag for the next engineer,
 * not a fix: the query must be re-pooled or removed before it scores
 * again. Appends to (never replaces) any existing note. */
const unscorableNote = (
  existingNote: string | undefined,
  grader: string,
  date: string
): string => {
  const warning = `UNSCORABLE: 0 relevant docs after import by ${grader} on ${date} — re-pool or remove this query (run.ts's schema still rejects it; see judgments/provenance.jsonl).`;
  return existingNote ? `${existingNote} ${warning}` : warning;
};

/** Rewrites queriesPath, touching only the lines whose query id is in
 * `diffs` and leaving every other line's bytes untouched. `unscorable`
 * carries the query ids left with zero relevant docs (only non-empty
 * when the import ran with --allow-empty-relevant) — those lines also
 * get an unscorableNote appended to `note`. */
const rewriteQueriesFile = async (
  queriesPath: string,
  diffs: ReadonlyMap<string, QueryDiff>,
  updatedRelevant: ReadonlyMap<string, Set<string>>,
  updatedHardNegatives: ReadonlyMap<string, Set<string>>,
  unscorable: ReadonlySet<string>,
  grader: string
): Promise<void> => {
  const rawText = await readFile(queriesPath, "utf-8");
  const lines = rawText.split("\n");
  const date = new Date().toISOString().slice(0, 10);
  const newLines = lines.map((line) => {
    if (line.trim() === "") {
      return line;
    }
    // SAFETY: loadJudgmentQueries already parsed and zod-validated this
    // exact file against querySchema before this function runs, so every
    // non-blank line here is known to conform to RelevanceQuery.
    const parsedLine = JSON.parse(line) as RelevanceQuery;
    if (!diffs.has(parsedLine.id)) {
      return line;
    }
    const relevantSet = updatedRelevant.get(parsedLine.id);
    const hardNegativeSet = updatedHardNegatives.get(parsedLine.id);
    if (!(relevantSet && hardNegativeSet)) {
      return line;
    }
    const updated: RelevanceQuery = {
      ...parsedLine,
      hardNegatives: sortUnique([...hardNegativeSet]),
      note: unscorable.has(parsedLine.id)
        ? unscorableNote(parsedLine.note, grader, date)
        : parsedLine.note,
      relevant: sortUnique([...relevantSet]),
    };
    return JSON.stringify(updated);
  });
  // `lines` came from splitting on "\n", so joining with "\n" reproduces the
  // original byte layout exactly (trailing newline included) for every line
  // this loop did not touch.
  await writeFile(queriesPath, newLines.join("\n"));
};

/** Appends one provenance line per touched query to provenancePath. Each
 * line's `rows` carries docId + comment for every graded row that has a
 * comment (empty comments are omitted) — the grader doc asks for comments
 * precisely so the next grader understands the distinction. */
const appendProvenance = async (
  provenancePath: string,
  resolved: Resolved,
  grader: string,
  source: string
): Promise<void> => {
  await mkdir(path.dirname(provenancePath), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const provenanceLines = [...resolved].map(([queryId, byDoc]) => {
    const rows = [...byDoc]
      .filter(([, entry]) => entry.comment !== "")
      .map(([docId, entry]) => ({ comment: entry.comment, docId }));
    return JSON.stringify({ date, grader, queryId, rows, source });
  });
  const existingProvenance = await readFile(provenancePath, "utf-8").catch(
    () => ""
  );
  const separator =
    existingProvenance.length > 0 && !existingProvenance.endsWith("\n")
      ? "\n"
      : "";
  await writeFile(
    provenancePath,
    `${existingProvenance}${separator}${provenanceLines.join("\n")}\n`
  );
};

const toDiffList = (diffs: ReadonlyMap<string, QueryDiff>): QueryDiff[] =>
  [...diffs.values()].map((diff) => ({
    ...diff,
    addedHardNegative: sortUnique(diff.addedHardNegative),
    addedRelevant: sortUnique(diff.addedRelevant),
  }));

/**
 * The whole import pipeline as a pure(ish) async function: no
 * `console.*` and no `process.exit` — callers (main(), or a test) decide
 * how to present a result. Only "ok" with dryRun: false actually writes
 * queriesPath / provenancePath.
 */
export const runImport = async (
  options: RunImportOptions
): Promise<ImportOutcome> => {
  const { dryRun, filePath, grader, preferLatest } = options;
  const allowEmptyRelevant = options.allowEmptyRelevant ?? false;
  const queriesPath =
    options.queriesPath ?? path.join(import.meta.dirname, "queries.jsonl");
  const provenancePath = options.provenancePath ?? DEFAULT_PROVENANCE_PATH;

  const csvText = await readFile(filePath, "utf-8");
  const csvRows = parseCsv(csvText);
  if (csvRows.length === 0) {
    throw new Error(`${filePath} is empty`);
  }
  const [header, ...dataRows] = csvRows;
  if (!header) {
    throw new Error(`${filePath} is empty`);
  }
  const columns: CsvColumns = {
    comment: columnIndex(header, "comment"),
    docId: columnIndex(header, "doc_id"),
    grade: columnIndex(header, "grade"),
    queryId: columnIndex(header, "query_id"),
  };

  const queries = await loadJudgmentQueries(queriesPath);
  const queryById = new Map(queries.map((query) => [query.id, query] as const));
  const corpus = await loadRelevanceCorpus();
  const corpusIds = new Set(corpus.documents.map((item) => item.id));

  const { byQueryDoc, unknownDocIds, unknownQueryIds } = extractGradedEntries(
    dataRows,
    columns,
    queryById,
    corpusIds
  );
  if (unknownQueryIds.size > 0 || unknownDocIds.length > 0) {
    return {
      kind: "unknown-ids",
      unknownDocIds,
      unknownQueryIds: [...unknownQueryIds],
    };
  }

  const { conflicts, resolved } = resolveGradedEntries(
    byQueryDoc,
    preferLatest
  );
  if (conflicts.length > 0) {
    return { conflicts, kind: "conflicts" };
  }

  const { diffs, updatedHardNegatives, updatedRelevant } = buildDiffs(
    resolved,
    queryById
  );

  const emptyRelevantQueryIds = [...updatedRelevant]
    .filter(([, relevantSet]) => relevantSet.size === 0)
    .map(([queryId]) => queryId);
  if (emptyRelevantQueryIds.length > 0 && !allowEmptyRelevant) {
    return { emptyRelevantQueryIds, kind: "empty-relevant" };
  }

  const diffList = toDiffList(diffs);

  if (dryRun) {
    return { diffs: diffList, dryRun: true, kind: "ok" };
  }

  await rewriteQueriesFile(
    queriesPath,
    diffs,
    updatedRelevant,
    updatedHardNegatives,
    new Set(emptyRelevantQueryIds),
    grader
  );
  await appendProvenance(
    provenancePath,
    resolved,
    grader,
    path.basename(filePath)
  );

  return { diffs: diffList, dryRun: false, kind: "ok" };
};

const printOutcome = (outcome: ImportOutcome): void => {
  if (outcome.kind === "unknown-ids") {
    console.error("unknown ids found — fix the CSV and re-run:");
    for (const queryId of outcome.unknownQueryIds) {
      console.error(`  unknown query_id: ${queryId}`);
    }
    for (const entry of outcome.unknownDocIds) {
      console.error(`  unknown doc_id: ${entry}`);
    }
    return;
  }
  if (outcome.kind === "conflicts") {
    console.error(
      "conflicting grades for the same document — re-run with --prefer-latest or fix the CSV:"
    );
    for (const line of outcome.conflicts) {
      console.error(`  ${line}`);
    }
    return;
  }
  if (outcome.kind === "empty-relevant") {
    console.error(
      "these queries would end up with zero relevant docs — run.ts's schema requires at least one, so `bun run relevance` would reject the whole set:"
    );
    for (const queryId of outcome.emptyRelevantQueryIds) {
      console.error(`  ${queryId}`);
    }
    console.error(
      "re-pool or fix the CSV, or re-run with --allow-empty-relevant to write anyway (still unscorable until an engineer re-pools or removes the query)."
    );
    return;
  }
  console.log(`queries touched: ${outcome.diffs.length}`);
  for (const diff of outcome.diffs) {
    const parts: string[] = [];
    if (diff.addedRelevant.length > 0) {
      parts.push(`+relevant: ${diff.addedRelevant.join(", ")}`);
    }
    if (diff.addedHardNegative.length > 0) {
      parts.push(`+hardNegative: ${diff.addedHardNegative.join(", ")}`);
    }
    console.log(`  ${diff.id}: ${parts.join(" | ")}`);
  }
  console.log(
    outcome.dryRun
      ? "[dry-run] no files written"
      : "wrote queries.jsonl and appended provenance"
  );
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const outcome = await runImport(args);
  printOutcome(outcome);
  if (outcome.kind !== "ok") {
    process.exit(1);
  }
};

if (import.meta.main) {
  await main();
}
