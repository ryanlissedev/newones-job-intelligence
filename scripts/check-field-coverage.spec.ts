import { describe, expect, it } from "bun:test";

import type { FieldCoverageBaseline } from "./check-field-coverage";
import {
  buildBaseline,
  diffCoverage,
  formatRegressions,
} from "./check-field-coverage";

const baselineOf = (
  sources: FieldCoverageBaseline["sources"]
): FieldCoverageBaseline => ({
  generatedAt: "2026-01-01T00:00:00.000Z",
  sourceSha: "deadbeef",
  sources,
});

const reportOf = (
  slug: string,
  records: number,
  fields: Record<string, number>
) => ({ fields, records, slug });

/** A full SourceReport-shaped row: buildBaseline must ignore everything
 * outside the CoverageReportSlice (records + fields + slug). */
const fullReportOf = (
  slug: string,
  records: number,
  fields: Record<string, number>,
  extras: {
    errors?: string[];
    keys?: Record<string, number>;
    rejected?: number;
  } = {}
) => ({
  bronId: `id-${slug}`,
  errors: extras.errors ?? [],
  fields,
  keys: extras.keys ?? {},
  records,
  rejected: extras.rejected ?? 0,
  skippedDetails: 0,
  slug,
});

describe("diffCoverage", () => {
  it("passes when every field count meets or exceeds the baseline", () => {
    const baseline = baselineOf({
      "bron-a": { fields: { sluit: 1, tarief: 2 }, records: 3 },
    });
    const reports = [
      reportOf("bron-a", 4, { sluit: 1, tarief: 3, werkvorm: 1 }),
    ];

    const diff = diffCoverage(baseline, reports);

    // werkvorm is new in the report — a warning, never a regression.
    expect(diff.regressions).toEqual([]);
    expect(diff.warnings).toEqual([
      "bron-a.werkvorm: not in baseline (new field — regenerate with --write-baseline)",
    ]);
  });

  it("fails when a field count drops below the baseline", () => {
    const baseline = baselineOf({
      "bron-a": { fields: { sluit: 1, tarief: 2 }, records: 3 },
    });
    const reports = [reportOf("bron-a", 3, { sluit: 1, tarief: 1 })];

    const diff = diffCoverage(baseline, reports);

    expect(diff.regressions).toEqual([
      { actual: 1, baseline: 2, field: "tarief", slug: "bron-a" },
    ]);
    expect(diff.warnings).toEqual([]);
  });

  it("fails when fewer records replay than the baseline recorded", () => {
    const baseline = baselineOf({
      "bron-a": { fields: { tarief: 0 }, records: 3 },
    });
    const reports = [reportOf("bron-a", 1, { tarief: 0 })];

    const diff = diffCoverage(baseline, reports);

    expect(diff.regressions).toEqual([
      { actual: 1, baseline: 3, field: "records", slug: "bron-a" },
    ]);
  });

  it("warns but does not fail for a source absent from the baseline", () => {
    const baseline = baselineOf({});
    const reports = [reportOf("bron-new", 2, { tarief: 2 })];

    const diff = diffCoverage(baseline, reports);

    expect(diff.regressions).toEqual([]);
    expect(diff.warnings).toEqual([
      "bron-new: not in baseline (new source — regenerate with --write-baseline to record it)",
    ]);
  });

  it("warns when a baseline source or field is absent from the report", () => {
    const baseline = baselineOf({
      "bron-a": { fields: { einddatum: 1, tarief: 2 }, records: 3 },
      "bron-gone": { fields: { tarief: 1 }, records: 1 },
    });
    const reports = [reportOf("bron-a", 3, { tarief: 3 })];

    const diff = diffCoverage(baseline, reports);

    expect(diff.regressions).toEqual([]);
    expect(diff.warnings).toEqual([
      "bron-a.einddatum: in baseline but absent from report (field removed?)",
      "bron-gone: in baseline but absent from report (source removed?)",
    ]);
  });
});

describe("buildBaseline", () => {
  it("trims reports to records + sorted field counts and sorts slugs", () => {
    const reports = [
      fullReportOf(
        "bron-b",
        3,
        { sluit: 1, tarief: 2 },
        {
          errors: ["fetch x: boom"],
          keys: { uren_per_week: 3 },
        }
      ),
      fullReportOf("bron-a", 5, { tarief: 5 }, { rejected: 1 }),
    ];

    const baseline = buildBaseline(reports, {
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceSha: "abc123",
    });

    expect(baseline).toEqual({
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceSha: "abc123",
      sources: {
        "bron-a": { fields: { tarief: 5 }, records: 5 },
        "bron-b": { fields: { sluit: 1, tarief: 2 }, records: 3 },
      },
    });
  });
});

describe("formatRegressions", () => {
  it("renders a readable per-field diff table", () => {
    const text = formatRegressions([
      { actual: 0, baseline: 2, field: "tarief", slug: "bron-a" },
    ]);

    expect(text).toContain("coverage dropped below baseline");
    expect(text).toContain("bron-a");
    expect(text).toContain("tarief");
    expect(text).toContain("baseline=2");
    expect(text).toContain("actual=0");
  });
});
