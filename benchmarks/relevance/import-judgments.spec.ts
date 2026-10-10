import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RelevanceQuery } from "./export-judgments";
import { loadJudgmentQueries } from "./export-judgments";
import { isGrade, parseCsv, runImport } from "./import-judgments";

describe("isGrade", () => {
  it("accepts only 0, 1, 2", () => {
    expect(isGrade("0")).toBe(true);
    expect(isGrade("1")).toBe(true);
    expect(isGrade("2")).toBe(true);
    expect(isGrade("3")).toBe(false);
    expect(isGrade("")).toBe(false);
    expect(isGrade("relevant")).toBe(false);
  });
});

describe("parseCsv", () => {
  it("splits plain rows on the ';' delimiter", () => {
    expect(parseCsv("a;b;c\n1;2;3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles a quoted field containing the delimiter", () => {
    expect(parseCsv('a;"b;c";d\n')).toEqual([["a", "b;c", "d"]]);
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    expect(parseCsv('a;"say ""hi""";c\n')).toEqual([["a", 'say "hi"', "c"]]);
  });

  it("handles a quoted field containing an embedded newline", () => {
    expect(parseCsv('a;"line1\nline2";c\n')).toEqual([
      ["a", "line1\nline2", "c"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseCsv("﻿a;b\n")).toEqual([["a", "b"]]);
  });

  it("handles a file with no trailing newline", () => {
    expect(parseCsv("a;b")).toEqual([["a", "b"]]);
  });
});

const QUERIES_HEADER = [
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
].join(";");

// The real committed queries.jsonl. Every test below operates on a
// mkdtemp COPY of it (via --queries / --provenance overrides) — none of
// them may write to this path. The gate runs test files in parallel, so a
// crash or kill mid-test must never be able to leave the golden set
// mutated on disk; a snapshot taken here plus the afterAll below is the
// belt-and-braces check that no test broke that rule, even by accident.
const realQueriesPath = path.join(import.meta.dirname, "queries.jsonl");
let realQueriesSnapshot: string;

beforeAll(async () => {
  realQueriesSnapshot = await readFile(realQueriesPath, "utf-8");
});

afterAll(async () => {
  const current = await readFile(realQueriesPath, "utf-8");
  expect(current).toBe(realQueriesSnapshot);
});

/** Copies the real queries.jsonl into a fresh temp dir and returns paths
 * for --queries / --provenance that are safe to write to. */
const makeTempQueriesCopy = async (): Promise<{
  cleanup: () => Promise<void>;
  provenancePath: string;
  queriesPath: string;
}> => {
  const dir = await mkdtemp(path.join(tmpdir(), "judg-import-"));
  const queriesPath = path.join(dir, "queries.jsonl");
  await cp(realQueriesPath, queriesPath);
  return {
    cleanup: () => rm(dir, { force: true, recursive: true }),
    provenancePath: path.join(dir, "provenance.jsonl"),
    queriesPath,
  };
};

describe("runImport round-trip", () => {
  it("promotes one doc, demotes another, and leaves every other line byte-identical", async () => {
    const temp = await makeTempQueriesCopy();
    const originalQueries = await readFile(temp.queriesPath, "utf-8");

    const csvPath = path.join(
      tmpdir(),
      `judg-import-${crypto.randomUUID()}.csv`
    );
    // es-azure ships with 3 relevant / 2 hardNegatives in the committed
    // fixture query set (benchmarks/relevance/queries.jsonl) — promote one
    // hard negative to relevant, demote one relevant to hardNegative.
    const csv = [
      QUERIES_HEADER,
      "es-azure;exact-skill;azure;{};hero:interim-opdrachten/devops-engineer-1f2fde9f;hero;DevOps Engineer;snippet;hardNegative;2;promote",
      "es-azure;exact-skill;azure;{};pro-act:vacatures/senior-azure-operations-engineer-8793;pro-act;Senior Azure Operations Engineer;snippet;relevant;0;demote",
      // Confirms an already-relevant doc with no comment — must not appear
      // in the provenance `rows` array (empty comment is omitted).
      "es-azure;exact-skill;azure;{};tenderned:TN563214;tenderned;Platform engineer Azure DAS;snippet;relevant;1;",
    ].join("\n");
    await writeFile(csvPath, csv);

    try {
      const outcome = await runImport({
        dryRun: false,
        filePath: csvPath,
        grader: "spec-recruiter",
        preferLatest: false,
        provenancePath: temp.provenancePath,
        queriesPath: temp.queriesPath,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") {
        return;
      }
      expect(outcome.dryRun).toBe(false);
      expect(outcome.diffs).toEqual([
        {
          addedHardNegative: [
            "pro-act:vacatures/senior-azure-operations-engineer-8793",
          ],
          addedRelevant: [
            "hero:interim-opdrachten/devops-engineer-1f2fde9f",
            "tenderned:TN563214",
          ],
          id: "es-azure",
        },
      ]);

      const updatedQueries = await readFile(temp.queriesPath, "utf-8");
      const originalLines = originalQueries.split("\n");
      const updatedLines = updatedQueries.split("\n");
      expect(updatedLines.length).toBe(originalLines.length);

      let changedCount = 0;
      for (const [index, line] of updatedLines.entries()) {
        if (line === originalLines[index]) {
          continue;
        }
        changedCount += 1;
        const parsed: unknown = JSON.parse(line);
        expect(parsed).toMatchObject({ id: "es-azure" });
        // SAFETY: just asserted parsed matches the es-azure query shape,
        // which always carries relevant/hardNegatives string arrays.
        const { hardNegatives, relevant } = parsed as RelevanceQuery;
        expect(relevant).toContain(
          "hero:interim-opdrachten/devops-engineer-1f2fde9f"
        );
        expect(relevant).not.toContain(
          "pro-act:vacatures/senior-azure-operations-engineer-8793"
        );
        expect(hardNegatives).toContain(
          "pro-act:vacatures/senior-azure-operations-engineer-8793"
        );
        expect(hardNegatives).not.toContain(
          "hero:interim-opdrachten/devops-engineer-1f2fde9f"
        );
      }
      expect(changedCount).toBe(1);

      // Replacement for "bun run relevance still parses queries.jsonl":
      // run.ts hard-codes its own queries.jsonl path with no override, so
      // it can't be pointed at the temp file. Instead assert the imported
      // temp file still satisfies the exact same zod schema run.ts uses
      // (loadJudgmentQueries duplicates that schema from run.ts — see
      // export-judgments.ts's top comment) — this proves the import
      // produced a file run.ts would accept without actually invoking it
      // against a path it doesn't support overriding.
      const reparsed = await loadJudgmentQueries(temp.queriesPath);
      expect(reparsed.length).toBe(
        originalLines.filter((l) => l.trim()).length
      );

      const updatedProvenance = await readFile(temp.provenancePath, "utf-8");
      // SAFETY: this test just wrote provenancePath via runImport's own
      // appendProvenance, whose shape is {date, grader, queryId, rows,
      // source} — the assertion below re-checks it structurally.
      const provenanceLine = JSON.parse(
        updatedProvenance.trim().split("\n").at(-1) ?? "{}"
      ) as {
        grader: string;
        queryId: string;
        rows: { comment: string; docId: string }[];
      };
      expect(provenanceLine.queryId).toBe("es-azure");
      expect(provenanceLine.grader).toBe("spec-recruiter");
      // Graded rows with a comment carry docId + comment; the graded row
      // with an empty comment (tenderned:TN563214) is omitted entirely.
      expect(provenanceLine.rows).toEqual(
        expect.arrayContaining([
          {
            comment: "promote",
            docId: "hero:interim-opdrachten/devops-engineer-1f2fde9f",
          },
          {
            comment: "demote",
            docId: "pro-act:vacatures/senior-azure-operations-engineer-8793",
          },
        ])
      );
      expect(provenanceLine.rows).toHaveLength(2);
    } finally {
      await temp.cleanup();
      await rm(csvPath, { force: true });
    }
  });

  it("reports unknown doc ids without touching the queries file", async () => {
    const temp = await makeTempQueriesCopy();
    const originalQueries = await readFile(temp.queriesPath, "utf-8");
    const csvPath = path.join(
      tmpdir(),
      `judg-import-bad-${crypto.randomUUID()}.csv`
    );
    const csv = [
      QUERIES_HEADER,
      "es-azure;exact-skill;azure;{};bogus:does-not-exist;bogus;X;snippet;unlabeled;1;",
    ].join("\n");
    await writeFile(csvPath, csv);
    try {
      const outcome = await runImport({
        dryRun: true,
        filePath: csvPath,
        grader: "spec-recruiter",
        preferLatest: false,
        provenancePath: temp.provenancePath,
        queriesPath: temp.queriesPath,
      });
      expect(outcome.kind).toBe("unknown-ids");
      if (outcome.kind === "unknown-ids") {
        expect(outcome.unknownDocIds).toEqual([
          "es-azure:bogus:does-not-exist",
        ]);
      }
      const untouchedQueries = await readFile(temp.queriesPath, "utf-8");
      expect(untouchedQueries).toBe(originalQueries);
    } finally {
      await temp.cleanup();
      await rm(csvPath, { force: true });
    }
  });

  it("refuses conflicting grades for the same doc unless --prefer-latest", async () => {
    const temp = await makeTempQueriesCopy();
    const originalQueries = await readFile(temp.queriesPath, "utf-8");
    const csvPath = path.join(
      tmpdir(),
      `judg-import-conflict-${crypto.randomUUID()}.csv`
    );
    const csv = [
      QUERIES_HEADER,
      "es-azure;exact-skill;azure;{};hero:interim-opdrachten/devops-engineer-1f2fde9f;hero;DevOps Engineer;snippet;hardNegative;2;",
      "es-azure;exact-skill;azure;{};hero:interim-opdrachten/devops-engineer-1f2fde9f;hero;DevOps Engineer;snippet;hardNegative;0;",
    ].join("\n");
    await writeFile(csvPath, csv);
    try {
      const refused = await runImport({
        dryRun: true,
        filePath: csvPath,
        grader: "spec-recruiter",
        preferLatest: false,
        provenancePath: temp.provenancePath,
        queriesPath: temp.queriesPath,
      });
      expect(refused.kind).toBe("conflicts");

      const preferLatest = await runImport({
        dryRun: true,
        filePath: csvPath,
        grader: "spec-recruiter",
        preferLatest: true,
        provenancePath: temp.provenancePath,
        queriesPath: temp.queriesPath,
      });
      expect(preferLatest.kind).toBe("ok");
      if (preferLatest.kind === "ok") {
        expect(preferLatest.diffs).toEqual([
          {
            addedHardNegative: [
              "hero:interim-opdrachten/devops-engineer-1f2fde9f",
            ],
            addedRelevant: [],
            id: "es-azure",
          },
        ]);
      }

      const untouchedQueries = await readFile(temp.queriesPath, "utf-8");
      expect(untouchedQueries).toBe(originalQueries);
    } finally {
      await temp.cleanup();
      await rm(csvPath, { force: true });
    }
  });

  it("refuses to leave a query with zero relevant docs unless --allow-empty-relevant", async () => {
    const temp = await makeTempQueriesCopy();
    const originalQueries = await readFile(temp.queriesPath, "utf-8");
    const csvPath = path.join(
      tmpdir(),
      `judg-import-empty-relevant-${crypto.randomUUID()}.csv`
    );
    // es-devops ships with exactly one relevant doc — demoting it to
    // hardNegative leaves `relevant` empty.
    const csv = [
      QUERIES_HEADER,
      "es-devops;exact-skill;devops engineer;{};hero:interim-opdrachten/devops-engineer-1f2fde9f;hero;DevOps Engineer;snippet;relevant;0;no longer a fit",
    ].join("\n");
    await writeFile(csvPath, csv);
    try {
      const refused = await runImport({
        dryRun: false,
        filePath: csvPath,
        grader: "spec-recruiter",
        preferLatest: false,
        provenancePath: temp.provenancePath,
        queriesPath: temp.queriesPath,
      });
      expect(refused.kind).toBe("empty-relevant");
      if (refused.kind === "empty-relevant") {
        expect(refused.emptyRelevantQueryIds).toEqual(["es-devops"]);
      }
      const untouchedQueries = await readFile(temp.queriesPath, "utf-8");
      expect(untouchedQueries).toBe(originalQueries);

      const allowed = await runImport({
        allowEmptyRelevant: true,
        dryRun: false,
        filePath: csvPath,
        grader: "spec-recruiter",
        preferLatest: false,
        provenancePath: temp.provenancePath,
        queriesPath: temp.queriesPath,
      });
      expect(allowed.kind).toBe("ok");

      const updatedQueries = await readFile(temp.queriesPath, "utf-8");
      const updatedLine = updatedQueries
        .split("\n")
        .find((line) => line.includes('"id":"es-devops"'));
      expect(updatedLine).toBeDefined();
      // SAFETY: just asserted updatedLine is the es-devops line, which
      // always conforms to the RelevanceQuery shape (minus the min(1)
      // constraint this test deliberately violates on `relevant`).
      const updatedQuery = JSON.parse(updatedLine ?? "{}") as RelevanceQuery;
      expect(updatedQuery.relevant).toEqual([]);
      expect(updatedQuery.note).toContain("UNSCORABLE");
      expect(updatedQuery.note).toContain("spec-recruiter");

      // Pin the behaviour: --allow-empty-relevant writes the file, but
      // run.ts's querySchema (duplicated here in loadJudgmentQueries)
      // still rejects it — an engineer must re-pool or remove the query.
      await expect(loadJudgmentQueries(temp.queriesPath)).rejects.toThrow();
    } finally {
      await temp.cleanup();
      await rm(csvPath, { force: true });
    }
  });
});
