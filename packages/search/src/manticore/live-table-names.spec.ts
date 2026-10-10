import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SEARCH_PARTITIONS, partitionTable } from "../partition";

const tableNamePattern =
  /const LIVE_TEST_INDEX_NAME = ["'](?<name>[^"']+)["']/u;
const liveEngineCallPattern = /createLiveTestEngine\(/u;
const preflightCallPattern = /assertLiveTestTablesReady\(/u;
const tableDeclarationPattern = /^table (?<name>[A-Za-z0-9_]+)\s*\{/gmu;
const excludedLiveSpec = "manticore/live-test-hygiene.spec.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const CONF_PATHS = [
  "tools/manticore/manticore.conf",
  "tools/manticore/manticore29.conf",
] as const;

interface LiveSpecFacts {
  readonly indexName: string;
  readonly callsPreflight: boolean;
}

const collectTableNames = async (): Promise<Map<string, LiveSpecFacts>> => {
  const sourceRoot = path.resolve(import.meta.dir, "..");
  const glob = new Bun.Glob("**/*.spec.ts");
  const liveSpecFiles: string[] = [];

  for await (const filePath of glob.scan({ absolute: true, cwd: sourceRoot })) {
    const source = await readFile(filePath, "utf-8");
    const fileName = path.relative(sourceRoot, filePath);
    if (fileName !== excludedLiveSpec && liveEngineCallPattern.test(source)) {
      liveSpecFiles.push(filePath);
    }
  }

  const sources = await Promise.all(
    liveSpecFiles.map(async (filePath) => ({
      fileName: path.relative(sourceRoot, filePath),
      source: await readFile(filePath, "utf-8"),
    }))
  );
  const facts = new Map<string, LiveSpecFacts>();
  for (const { fileName, source } of sources) {
    const tableName = source.match(tableNamePattern)?.groups?.name;
    if (!tableName) {
      throw new Error(`Missing LIVE_TEST_INDEX_NAME in ${fileName}`);
    }
    facts.set(fileName, {
      callsPreflight: preflightCallPattern.test(source),
      indexName: tableName,
    });
  }
  return facts;
};

const readDeclaredTables = async (
  confPath: string
): Promise<ReadonlySet<string>> => {
  const source = await readFile(path.resolve(REPO_ROOT, confPath), "utf-8");
  const declared = new Set<string>();
  for (const match of source.matchAll(tableDeclarationPattern)) {
    const name = match.groups?.name;
    if (name) {
      declared.add(name);
    }
  }
  return declared;
};

/**
 * Pure filesystem checks: they read the specs and the confs, so the gate runs
 * them with no Manticore and no Docker. #316 added ten per-file live tables
 * to the confs, and nothing compared the set the specs ask for against the
 * set the confs declare, so the mismatch only surfaced as `unknown local
 * table(s)` on a developer's live run (CTP-604). This is the check that would
 * have caught it at PR time.
 */
describe("live Manticore table names", () => {
  it("uses a unique table base per live spec file", async () => {
    const facts = await collectTableNames();
    const owners = new Map<string, string>();
    const duplicates: string[] = [];

    for (const [fileName, { indexName }] of facts) {
      const previousOwner = owners.get(indexName);
      if (previousOwner) {
        duplicates.push(
          `Duplicate live Manticore table base "${indexName}" used by ${previousOwner} and ${fileName}`
        );
      } else {
        owners.set(indexName, fileName);
      }
      expect(indexName.startsWith("aanvragen_test")).toBe(true);
    }

    expect(duplicates, duplicates.join("\n")).toEqual([]);
  });

  it("declares every live spec partition table in both Manticore confs", async () => {
    const [facts, confs] = await Promise.all([
      collectTableNames(),
      Promise.all(
        CONF_PATHS.map(async (confPath) => ({
          confPath,
          declared: await readDeclaredTables(confPath),
        }))
      ),
    ]);
    const missing: string[] = [];

    for (const { confPath, declared } of confs) {
      for (const [fileName, { indexName }] of facts) {
        const undeclared = SEARCH_PARTITIONS.map((partition) =>
          partitionTable(indexName, partition)
        ).filter((table) => !declared.has(table));
        for (const table of undeclared) {
          missing.push(
            `Live table "${table}" (needed by ${fileName}) is not declared in ${confPath}`
          );
        }
      }
    }

    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("calls the runtime table preflight in every live spec", async () => {
    const facts = await collectTableNames();
    const missing: string[] = [];

    for (const [fileName, { callsPreflight }] of facts) {
      if (!callsPreflight) {
        missing.push(
          `${fileName} never calls assertLiveTestTablesReady, so a searchd missing its tables fails mid-test instead of up front`
        );
      }
    }

    expect(missing, missing.join("\n")).toEqual([]);
  });
});
