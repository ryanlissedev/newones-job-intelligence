import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

// @ji/application depends on @ji/connectors, never the reverse. `check-layering`
// only scans apps/web, so a spec importing application code from here would pass
// every other gate while inverting the package graph.
const APPLICATION_IMPORT_PATTERN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:@ji\/application(?:\/[^"']*)?|(?:\.\.\/)+application\/[^"']*)["']/u;

const findApplicationImports = (
  files: readonly { readonly fileName: string; readonly source: string }[]
): string[] =>
  files
    .filter(({ source }) => APPLICATION_IMPORT_PATTERN.test(source))
    .map(({ fileName }) => fileName)
    .toSorted();

describe("connectors package boundary", () => {
  it("flags static, dynamic, and relative application imports", () => {
    expect(
      findApplicationImports([
        {
          fileName: "a.ts",
          source: 'import { x } from "@ji/application/identity";',
        },
        {
          fileName: "b.ts",
          source:
            'import { y } from "../../../application/src/normalise/json-ld";',
        },
        {
          fileName: "c.ts",
          source: 'const z = await import("@ji/application");',
        },
        {
          fileName: "d.ts",
          source: '/** reads `<script type="application/ld+json">` */',
        },
      ])
    ).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("has no file under packages/connectors/src importing @ji/application", async () => {
    const sourceRoot = import.meta.dir;
    const files: { fileName: string; source: string }[] = [];
    for await (const filePath of new Bun.Glob("**/*.ts").scan({
      absolute: true,
      cwd: sourceRoot,
    })) {
      if (filePath === import.meta.path) {
        continue;
      }
      files.push({
        fileName: path.relative(sourceRoot, filePath),
        source: await readFile(filePath, "utf-8"),
      });
    }

    expect(findApplicationImports(files)).toEqual([]);
  });
});
