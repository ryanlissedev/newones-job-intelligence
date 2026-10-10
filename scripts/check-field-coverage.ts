#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonValue } from "@ji/application/normalise";

import { replaySources } from "./field-coverage";

/**
 * Field-coverage regression guard: replays every source's committed fixtures
 * through its real connector + normaliser (the same replay as
 * `scripts/field-coverage.ts`) and fails when a per-field count drops below
 * the committed baseline at `fixtures/field-coverage/baseline.json`.
 *
 * Sources absent from the baseline (a new bron added on a parallel branch)
 * warn but do not fail; the same goes for fields new in the report. A source
 * or field present in the baseline but absent from the report warns as stale
 * baseline data.
 *
 * Usage:
 *   bun run check:field-coverage                  # diff replay vs baseline
 *   bun run check:field-coverage -- --write-baseline   # regenerate baseline
 */

export const BASELINE_PATH = path.join(
  import.meta.dir,
  "..",
  "fixtures",
  "field-coverage",
  "baseline.json"
);

export interface FieldCoverageBaselineEntry {
  fields: Record<string, number>;
  records: number;
}

export interface FieldCoverageBaseline {
  generatedAt: string;
  sourceSha: string;
  sources: Record<string, FieldCoverageBaselineEntry>;
}

export interface FieldCoverageRegression {
  actual: number;
  baseline: number;
  field: string;
  slug: string;
}

export interface FieldCoverageDiff {
  regressions: FieldCoverageRegression[];
  warnings: string[];
}

/**
 * The slice of a replay report the baseline diff reads. Kept structurally
 * loose (field names are strings, not the FIELDS union) so synthetic
 * reports in specs and future report fields flow through unchanged.
 */
export interface CoverageReportSlice {
  fields: Record<string, number>;
  records: number;
  slug: string;
}

/**
 * Trim a full replay report into the committed baseline shape: only the
 * replayed record count and per-field landed counts survive (keys, errors,
 * notes and bronId are report-only details).
 */
export const buildBaseline = (
  reports: readonly CoverageReportSlice[],
  meta: { generatedAt: string; sourceSha: string }
): FieldCoverageBaseline => {
  const sources: Record<string, FieldCoverageBaselineEntry> = {};
  const sorted = reports.toSorted((a, b) => a.slug.localeCompare(b.slug));
  for (const report of sorted) {
    const fields: Record<string, number> = {};
    for (const key of Object.keys(report.fields).toSorted()) {
      fields[key] = report.fields[key] ?? 0;
    }
    sources[report.slug] = { fields, records: report.records };
  }
  return {
    generatedAt: meta.generatedAt,
    sourceSha: meta.sourceSha,
    sources,
  };
};

/**
 * Pure diff: any per-field count (or record count) strictly below the
 * baseline entry is a regression. Everything asymmetric — a source or field
 * on only one side — is a warning, never a failure.
 */
export const diffCoverage = (
  baseline: FieldCoverageBaseline,
  reports: readonly CoverageReportSlice[]
): FieldCoverageDiff => {
  const regressions: FieldCoverageRegression[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const report of reports) {
    seen.add(report.slug);
    const entry = baseline.sources[report.slug];
    if (!entry) {
      warnings.push(
        `${report.slug}: not in baseline (new source — regenerate with --write-baseline to record it)`
      );
      continue;
    }
    if (report.records < entry.records) {
      regressions.push({
        actual: report.records,
        baseline: entry.records,
        field: "records",
        slug: report.slug,
      });
    }
    for (const [field, actual] of Object.entries(report.fields)) {
      const expected = entry.fields[field];
      if (expected === undefined) {
        warnings.push(
          `${report.slug}.${field}: not in baseline (new field — regenerate with --write-baseline)`
        );
        continue;
      }
      if (actual < expected) {
        regressions.push({
          actual,
          baseline: expected,
          field,
          slug: report.slug,
        });
      }
    }
    for (const field of Object.keys(entry.fields)) {
      if (!(field in report.fields)) {
        warnings.push(
          `${report.slug}.${field}: in baseline but absent from report (field removed?)`
        );
      }
    }
  }

  for (const slug of Object.keys(baseline.sources)) {
    if (!seen.has(slug)) {
      warnings.push(
        `${slug}: in baseline but absent from report (source removed?)`
      );
    }
  }

  return { regressions, warnings };
};

export const formatRegressions = (
  regressions: readonly FieldCoverageRegression[]
): string => {
  const rows = regressions.map(
    (r) =>
      `  ${r.slug.padEnd(28)} ${r.field.padEnd(14)} baseline=${r.baseline}  actual=${r.actual}`
  );
  return [
    "check-field-coverage: coverage dropped below baseline:",
    ...rows,
    "  (regenerate deliberately with --write-baseline if this drop is intended)",
  ].join("\n");
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- baseline.json is an external file parsed at this boundary; the guards below establish its shape before diffCoverage reads it. */
const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseBaseline = (raw: string): FieldCoverageBaseline => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.sources)) {
    throw new Error(
      `${BASELINE_PATH}: expected an object with a 'sources' map`
    );
  }
  const sources: Record<string, FieldCoverageBaselineEntry> = {};
  for (const [slug, entry] of Object.entries(parsed.sources)) {
    if (!isRecord(entry) || typeof entry.records !== "number") {
      throw new Error(
        `${BASELINE_PATH}: entry '${slug}' must be an object with numeric 'records'`
      );
    }
    const fields: Record<string, number> = {};
    if (isRecord(entry.fields)) {
      for (const [field, count] of Object.entries(entry.fields)) {
        if (typeof count === "number") {
          fields[field] = count;
        }
      }
    }
    sources[slug] = { fields, records: entry.records };
  }
  return {
    generatedAt:
      typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    sourceSha: typeof parsed.sourceSha === "string" ? parsed.sourceSha : "",
    sources,
  };
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

const resolveSourceSha = (): string => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error("git rev-parse HEAD failed; cannot stamp sourceSha");
  }
  return result.stdout.trim();
};

const run = async (): Promise<void> => {
  const writeBaseline = process.argv.slice(2).includes("--write-baseline");
  const reports = await replaySources();

  if (writeBaseline) {
    const baseline = buildBaseline(reports, {
      generatedAt: new Date().toISOString(),
      sourceSha: resolveSourceSha(),
    });
    mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `check-field-coverage: wrote ${path.relative(process.cwd(), BASELINE_PATH)} (${reports.length} sources @ ${baseline.sourceSha.slice(0, 12)})\n`
    );
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(BASELINE_PATH, "utf-8");
  } catch {
    process.stderr.write(
      `check-field-coverage: no baseline at ${path.relative(process.cwd(), BASELINE_PATH)}; run \`bun run check:field-coverage -- --write-baseline\` to create it\n`
    );
    process.exit(1);
  }
  const baseline = parseBaseline(raw);
  const { regressions, warnings } = diffCoverage(baseline, reports);

  for (const warning of warnings) {
    process.stderr.write(`check-field-coverage: warning: ${warning}\n`);
  }
  if (regressions.length > 0) {
    process.stderr.write(`${formatRegressions(regressions)}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `check-field-coverage: ok (${reports.length} sources vs baseline @ ${baseline.sourceSha.slice(0, 12) || "unknown"})\n`
  );
};

if (import.meta.main) {
  await run();
}
