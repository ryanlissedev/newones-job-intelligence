import { describe, expect, it } from "bun:test";

import {
  assertKpiSnapshotMatchesDom,
  attentionCountFromOverview,
  formatBronDashboardCount,
  formatBronDashboardRate,
  kpiSnapshotFromOverview,
  parseDisplayedCount,
  parseDisplayedSuccessPercent,
} from "./bron-dashboard-parity";

const overview = {
  bronnen: [
    {
      health: { circuitStatus: "closed", silenceAlertOpen: false },
      stats: { lastRunStatus: "succeeded", runs: 10 },
    },
    {
      health: { circuitStatus: "open", silenceAlertOpen: false },
      stats: { lastRunStatus: "failed", runs: 3 },
    },
    {
      health: null,
      stats: { lastRunStatus: null, runs: 0 },
    },
  ],
  total: {
    gewijzigd: 12,
    nieuw: 34,
    ongewijzigd: 56,
    rejected: 1,
    runs: 13,
    successRate: 0.846,
  },
};

describe("bron-dashboard parity (RJC-416)", () => {
  it("counts aandacht the same way as /bronnen cards", () => {
    expect(attentionCountFromOverview(overview)).toBe(2);
  });

  it("builds a KPI snapshot from overview JSON", () => {
    expect(kpiSnapshotFromOverview(overview)).toEqual({
      aandacht: 2,
      gewijzigd: 12,
      nieuw: 34,
      ongewijzigd: 56,
      rejected: 1,
      runs: 13,
      successPercent: 85,
    });
  });

  it("formats and parses nl-NL KPI text round-trip", () => {
    expect(formatBronDashboardRate(0.846)).toBe("85%");
    expect(formatBronDashboardRate(null)).toBe("—");
    expect(parseDisplayedSuccessPercent("85%")).toBe(85);
    expect(parseDisplayedSuccessPercent("—")).toBeNull();
    expect(parseDisplayedCount(formatBronDashboardCount(1234))).toBe(1234);
  });

  it("asserts DOM text equals overview snapshot", () => {
    const expected = kpiSnapshotFromOverview(overview);
    expect(() =>
      assertKpiSnapshotMatchesDom(expected, {
        aandacht: "2",
        gewijzigd: "12",
        nieuw: "34",
        ongewijzigd: "56",
        rejected: "1",
        runs: "13",
        successPercent: "85%",
      })
    ).not.toThrow();
    expect(() =>
      assertKpiSnapshotMatchesDom(expected, {
        aandacht: "2",
        gewijzigd: "12",
        nieuw: "99",
        ongewijzigd: "56",
        rejected: "1",
        runs: "13",
        successPercent: "85%",
      })
    ).toThrow(/nieuw/u);
  });
});
