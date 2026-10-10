import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CSV_HEADER,
  csvField,
  exportJudgments,
  loadJudgmentQueries,
  sanitizeFormulaCell,
  toSnippet,
} from "./export-judgments";

describe("sanitizeFormulaCell", () => {
  it("prefixes a leading '=' with a quote so Excel treats it as text", () => {
    expect(sanitizeFormulaCell('=HYPERLINK("http://evil","click")')).toBe(
      '\'=HYPERLINK("http://evil","click")'
    );
  });

  it("prefixes leading +, -, and @ the same way", () => {
    expect(sanitizeFormulaCell("+1234")).toBe("'+1234");
    expect(sanitizeFormulaCell("-1234")).toBe("'-1234");
    expect(sanitizeFormulaCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("leaves plain text untouched", () => {
    expect(sanitizeFormulaCell("Senior Azure Operations Engineer")).toBe(
      "Senior Azure Operations Engineer"
    );
  });
});

describe("csvField", () => {
  it("leaves a plain field unescaped", () => {
    expect(csvField("azure")).toBe("azure");
  });

  it("quotes and doubles a field containing the delimiter", () => {
    expect(csvField("a;b")).toBe('"a;b"');
  });

  it("quotes and escapes a field containing a double quote", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("toSnippet", () => {
  it("collapses internal whitespace and newlines to single spaces", () => {
    expect(toSnippet("hello   \n\n world")).toBe("hello world");
  });

  it("truncates to 200 chars with an ellipsis marker", () => {
    const long = "x".repeat(250);
    const result = toSnippet(long);
    expect(result.length).toBe(200);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched", () => {
    expect(toSnippet("short text")).toBe("short text");
  });
});

describe("loadJudgmentQueries", () => {
  const queriesPath = path.join(import.meta.dirname, "queries.jsonl");

  it("parses the real queries.jsonl with the same shape run.ts requires", async () => {
    const queries = await loadJudgmentQueries(queriesPath);
    expect(queries.length).toBeGreaterThanOrEqual(35);
    const ids = new Set(queries.map((query) => query.id));
    expect(ids.size).toBe(queries.length);
    for (const query of queries) {
      expect(query.relevant.length).toBeGreaterThan(0);
      expect(query.hardNegatives.length).toBeGreaterThan(0);
    }
  });

  it("rejects a line with an unknown category via a clear error", async () => {
    const tmpPath = path.join(
      tmpdir(),
      `judg-bad-${crypto.randomUUID()}.jsonl`
    );
    await Bun.write(
      tmpPath,
      `${JSON.stringify({
        category: "not-a-real-category",
        hardNegatives: ["a"],
        id: "x",
        query: "x",
        relevant: ["a"],
      })}\n`
    );
    try {
      await expect(loadJudgmentQueries(tmpPath)).rejects.toThrow(
        /queries\.jsonl line 1/u
      );
    } finally {
      await rm(tmpPath, { force: true });
    }
  });
});

/**
 * One CLI spawn boots a fresh Bun runtime, transpiles the workspace
 * (@ji/application, @ji/connectors, @ji/search, @ji/domain) and replays
 * every connector over its fixtures: 1.5 s warm, 3.4 s cold on an idle
 * M-series laptop, several times that while `bun run check-types` is
 * saturating the cores during the pre-push gate. Bun's default per-test
 * budget is 5 s, so the budget here is explicit and sized to the spawn,
 * not to the work. Tracked in docs/runbooks/gate-flaky-tests.md.
 */
const CLI_SMOKE_TIMEOUT_MS = 60_000;

const EXPECTED_HEADER = CSV_HEADER.join(";");

const stripBom = (text: string): string => text.replace(/^\uFEFF/u, "");

/** The export adds a Manticore engine whenever these are set in the shell.
 * The spec pins itself to the in-memory engine so it never depends on (or
 * writes to) a live index, then restores the developer's values. */
const clearManticoreEnv = (): (() => void) => {
  const saved = {
    MANTICORE_29_URL: process.env.MANTICORE_29_URL,
    MANTICORE_URL: process.env.MANTICORE_URL,
  };
  delete process.env.MANTICORE_29_URL;
  delete process.env.MANTICORE_URL;
  return () => {
    if (saved.MANTICORE_29_URL !== undefined) {
      process.env.MANTICORE_29_URL = saved.MANTICORE_29_URL;
    }
    if (saved.MANTICORE_URL !== undefined) {
      process.env.MANTICORE_URL = saved.MANTICORE_URL;
    }
  };
};

describe("exportJudgments (in-process)", () => {
  let workDir: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = clearManticoreEnv();
    workDir = await mkdtemp(path.join(tmpdir(), "judg-export-"));
  });

  afterAll(async () => {
    restoreEnv();
    await rm(workDir, { force: true, recursive: true });
  });

  it("writes a deterministic CSV + md pair and reruns byte-identical", async () => {
    const outA = path.join(workDir, "a.csv");
    const outB = path.join(workDir, "b.csv");
    const resultA = await exportJudgments({ outPath: outA, poolDepth: 5 });
    const resultB = await exportJudgments({ outPath: outB, poolDepth: 5 });

    expect(resultA.rowCount).toBeGreaterThan(0);
    expect(resultA.queryCount).toBeGreaterThanOrEqual(35);
    expect(resultB.rowCount).toBe(resultA.rowCount);

    const csvA = await readFile(outA, "utf-8");
    const csvB = await readFile(outB, "utf-8");
    expect(csvA).toBe(csvB);

    const lines = csvA.split("\n").filter((line) => line.length > 0);
    const [headerLine] = lines;
    expect(csvA.startsWith("\uFEFF")).toBe(true);
    expect(stripBom(headerLine ?? "")).toBe(EXPECTED_HEADER);
    expect(lines.length).toBe(resultA.rowCount + 1);

    const mdA = await readFile(resultA.mdPath, "utf-8");
    const mdB = await readFile(resultB.mdPath, "utf-8");
    expect(mdA).toBe(mdB);
    expect(mdA).toContain("# Relevance judgments");
  });

  it("rejects a queries file it cannot parse before writing anything", async () => {
    const queriesPath = path.join(workDir, "bad-queries.jsonl");
    await Bun.write(queriesPath, "{not json}\n");
    const outPath = path.join(workDir, "never-written.csv");
    await expect(
      exportJudgments({ outPath, poolDepth: 5, queriesPath })
    ).rejects.toThrow();
    expect(await Bun.file(outPath).exists()).toBe(false);
  });
});

describe("export-judgments CLI (integration smoke — spawns bun)", () => {
  it(
    "exits 0 and writes the CSV + md pair through the real argv path",
    async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "judg-export-cli-"));
      const outPath = path.join(workDir, "smoke.csv");
      const repoRoot = path.join(import.meta.dirname, "..", "..");
      try {
        const proc = Bun.spawnSync(
          [
            "bun",
            "benchmarks/relevance/export-judgments.ts",
            "--out",
            outPath,
            "--pool-depth",
            "5",
          ],
          {
            cwd: repoRoot,
            // Strip the Manticore switches so the smoke run is the in-memory
            // engine regardless of the developer's shell — with MANTICORE_URL
            // set the CLI would hit a live index and could warn on stderr
            // while still succeeding.
            env: {
              ...process.env,
              // Empty strings beat Bun auto-loading .env (delete/undefined inherits .env).
              MANTICORE_29_URL: "",
              MANTICORE_URL: "",
            },
            stderr: "pipe",
            stdout: "pipe",
          }
        );
        expect(
          { exitCode: proc.exitCode, stderr: proc.stderr.toString() },
          "CLI must exit 0; stderr shown for diagnosis"
        ).toMatchObject({ exitCode: 0 });
        expect(proc.stdout.toString()).toMatch(
          /^wrote \d+ pooled rows across \d+ queries to /u
        );

        const csv = await readFile(outPath, "utf-8");
        const [headerLine] = csv.split("\n");
        expect(stripBom(headerLine ?? "")).toBe(EXPECTED_HEADER);
        const md = await readFile(outPath.replace(/\.csv$/u, ".md"), "utf-8");
        expect(md).toContain("# Relevance judgments");
      } finally {
        await rm(workDir, { force: true, recursive: true });
      }
    },
    { timeout: CLI_SMOKE_TIMEOUT_MS }
  );
});
