/* oxlint-disable eslint/no-await-in-loop, eslint/prefer-destructuring, anti-slop/no-shape-in-symbol-names, anti-slop/require-safety-comment-for-type-assertion -- Image comparisons are intentionally serialized per page so baseline writes, diff files, and console output stay deterministic; report.json is decoded at this script's external I/O boundary. */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type CompareMode = "report" | "enforce" | "update";
export type VisualStatus =
  | "match"
  | "diff"
  | "missing-baseline"
  | "seeded"
  | "updated"
  | "missing-capture"
  | "not-run";

export interface CompareArgs {
  readonly baselineDir?: string;
  readonly capturedOnly: boolean;
  readonly mode: CompareMode;
  readonly output: string;
  readonly suite: "fixtures" | "live";
}

export interface ReportArtifact {
  readonly kind?: string;
  readonly path?: string;
}

export interface ReportAttempt {
  readonly artifacts?: readonly ReportArtifact[];
  readonly status?: string;
}

export interface ReportResult {
  readonly attempts?: readonly ReportAttempt[];
}

export interface ReportDocument {
  readonly results?: readonly ReportResult[];
  readonly run?: { readonly results?: readonly ReportResult[] };
}

export interface SelectedArtifact {
  readonly name: string;
  readonly path: string;
}

export const parseArgs = (argv: readonly string[]): CompareArgs => {
  let suite: CompareArgs["suite"] | undefined;
  let mode: CompareMode | undefined;
  let output = ".e2e";
  let baselineDir: string | undefined;
  let capturedOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--suite" && value) {
      if (value !== "fixtures" && value !== "live") {
        throw new Error(`Unknown suite: ${value}`);
      }
      suite = value;
      index += 1;
    } else if (argument === "--mode" && value) {
      if (value !== "report" && value !== "enforce" && value !== "update") {
        throw new Error(`Unknown visual mode: ${value}`);
      }
      mode = value;
      index += 1;
    } else if (argument === "--output" && value) {
      output = value;
      index += 1;
    } else if (argument === "--baseline-dir" && value) {
      baselineDir = value;
      index += 1;
    } else if (argument === "--captured-only") {
      capturedOnly = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!suite || !mode) {
    throw new Error(
      "Usage: --suite fixtures|live --mode report|enforce|update [--captured-only]"
    );
  }
  return { baselineDir, capturedOnly, mode, output, suite };
};

const visualName = (artifactPath: string): string | null => {
  const match = path
    .basename(artifactPath)
    .match(/visual-(?<name>[a-z0-9-]+)\.[^.]+$/u);
  return match?.groups?.name ?? null;
};

export const selectVisualArtifacts = (
  report: ReportDocument
): readonly SelectedArtifact[] => {
  const selected = new Map<string, SelectedArtifact>();
  for (const result of report.results ?? report.run?.results ?? []) {
    for (const attempt of result.attempts ?? []) {
      if (attempt.status !== "passed") {
        continue;
      }
      for (const artifact of attempt.artifacts ?? []) {
        if (artifact.kind !== "screenshot" || !artifact.path) {
          continue;
        }
        const name = visualName(artifact.path);
        if (name) {
          selected.set(name, { name, path: artifact.path });
        }
      }
    }
  }
  return [...selected.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name)
  );
};

/**
 * Only a partial run (`--captured-only`) may skip when nothing was captured.
 * A full run with zero captures still reports every committed baseline as
 * `missing-capture`, so losing all visual coverage cannot pass silently.
 */
export const shouldSkipCompare = (
  captures: readonly SelectedArtifact[],
  capturedOnly = false
): boolean => capturedOnly && captures.length === 0;

export const decideVisualStatus = (
  mode: CompareMode,
  hasCapture: boolean,
  hasBaseline: boolean,
  matches: boolean,
  capturedOnly = false
): VisualStatus => {
  if (!hasCapture) {
    return capturedOnly ? "not-run" : "missing-capture";
  }
  if (mode === "update") {
    return "updated";
  }
  if (!hasBaseline) {
    return mode === "report" ? "seeded" : "missing-baseline";
  }
  return matches ? "match" : "diff";
};

const isFailure = (mode: CompareMode, status: VisualStatus): boolean =>
  mode === "enforce" &&
  (status === "diff" ||
    status === "missing-baseline" ||
    status === "missing-capture");

const image = async (imagePath: string): Promise<PNG> =>
  PNG.sync.read(await readFile(imagePath));

const compareImage = async (
  capturePath: string,
  baselinePath: string,
  diffPath: string
): Promise<{ readonly diffRatio: number; readonly matches: boolean }> => {
  const capture = await image(capturePath);
  const baseline = await image(baselinePath);
  if (capture.width !== baseline.width || capture.height !== baseline.height) {
    return { diffRatio: 1, matches: false };
  }
  const diff = new PNG({ height: capture.height, width: capture.width });
  const diffPixels = pixelmatch(
    baseline.data,
    capture.data,
    diff.data,
    capture.width,
    capture.height,
    { includeAA: false, threshold: 0.1 }
  );
  await mkdir(path.dirname(diffPath), { recursive: true });
  await writeFile(diffPath, PNG.sync.write(diff));
  const pixelCount = capture.width * capture.height;
  const diffRatio = pixelCount === 0 ? 0 : diffPixels / pixelCount;
  const maxRatio = Number(process.env.E2E_VISUAL_MAX_DIFF_RATIO ?? "0.001");
  return { diffRatio, matches: diffRatio <= maxRatio };
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const output = path.resolve(args.output);
  const baselineDir = path.resolve(
    args.baselineDir ??
      (args.suite === "fixtures"
        ? "tests/visual/baselines/fixtures"
        : (process.env.E2E_VISUAL_BASELINE_DIR ?? ".e2e-visual/baselines/live"))
  );
  /* SAFETY: e2e writes this report; selectors below only read the optional fields declared by the runner contract. */
  const report = JSON.parse(
    await readFile(path.join(output, "report.json"), "utf-8")
  ) as ReportDocument;
  const captures = selectVisualArtifacts(report);
  if (shouldSkipCompare(captures, args.capturedOnly)) {
    console.log("no visual captures in this partial run; skipping compare");
    return 0;
  }
  const captureByName = new Map(
    captures.map((capture) => [capture.name, capture])
  );
  const names = new Set(captures.map((capture) => capture.name));
  let existingBaselines: string[] = [];
  try {
    existingBaselines = await Array.fromAsync(
      new Bun.Glob("*.png").scan({ absolute: false, cwd: baselineDir })
    );
  } catch {
    existingBaselines = [];
  }
  for (const baselineEntry of existingBaselines) {
    const name = path.basename(baselineEntry, path.extname(baselineEntry));
    names.add(name);
  }

  const maxRatio = Number(process.env.E2E_VISUAL_MAX_DIFF_RATIO ?? "0.001");
  const rows: {
    readonly diffRatio: number;
    readonly name: string;
    readonly status: VisualStatus;
  }[] = [];
  for (const name of [...names].toSorted()) {
    const capture = captureByName.get(name);
    const capturePath = capture
      ? path.join(output, "artifacts", capture.path)
      : "";
    const baselinePath = path.join(baselineDir, `${name}.png`);
    const hasCapture = capture !== undefined;
    const hasBaseline = await Bun.file(baselinePath).exists();
    let matches = false;
    let diffRatio = 0;
    if (hasCapture && args.mode === "update") {
      await mkdir(baselineDir, { recursive: true });
      await copyFile(capturePath, baselinePath);
    } else if (hasCapture && hasBaseline) {
      try {
        const comparison = await compareImage(
          capturePath,
          baselinePath,
          path.join(output, "visual", `diff-${name}.png`)
        );
        matches = comparison.matches;
        diffRatio = comparison.diffRatio;
      } catch {
        matches = false;
        diffRatio = 1;
      }
    } else if (hasCapture && args.mode === "report") {
      await mkdir(baselineDir, { recursive: true });
      await copyFile(capturePath, baselinePath);
    }
    const status = decideVisualStatus(
      args.mode,
      hasCapture,
      hasBaseline,
      matches,
      args.capturedOnly
    );
    rows.push({ diffRatio, name, status });
    console.log(`${name} ${status} ${diffRatio.toFixed(6)}`);
  }

  await mkdir(path.join(output, "visual"), { recursive: true });
  const summary = {
    baselineDir,
    maxDiffPixelRatio: maxRatio,
    mode: args.mode,
    pages: rows,
    suite: args.suite,
  };
  await writeFile(
    path.join(output, "visual", "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  const markdown = [
    `# Visual comparison (${args.suite})`,
    "",
    ...rows.map(
      ({ diffRatio, name, status }) =>
        `- ${name}: ${status} (${diffRatio.toFixed(6)})`
    ),
    "",
  ].join("\n");
  await writeFile(path.join(output, "visual", "summary.md"), markdown);
  return rows.some((row) => isFailure(args.mode, row.status)) ? 1 : 0;
};

if (import.meta.main) {
  process.exit(await main());
}
