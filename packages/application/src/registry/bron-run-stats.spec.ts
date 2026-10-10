import { describe, expect, it } from "bun:test";

import {
  BRON_RUN_STATS_WINDOWS,
  computeBronSuccessRate,
  isBronRunStatsWindow,
  resolveBronRunStatsSince,
} from "./bron-run-stats";

const NOW = new Date("2026-09-04T12:00:00.000Z");

describe("resolveBronRunStatsSince", () => {
  it("offers exactly the three windows the dashboard switches between", () => {
    expect([...BRON_RUN_STATS_WINDOWS]).toEqual(["24u", "7d", "30d"]);
  });

  it.each([
    ["24u" as const, "2026-09-03T12:00:00.000Z"],
    ["7d" as const, "2026-08-28T12:00:00.000Z"],
    ["30d" as const, "2026-08-05T12:00:00.000Z"],
  ])("resolves %s back from the injected clock", (window, expected) => {
    expect(resolveBronRunStatsSince(window, NOW).toISOString()).toBe(expected);
  });

  it("never resolves to a lifetime window", () => {
    for (const window of BRON_RUN_STATS_WINDOWS) {
      const since = resolveBronRunStatsSince(window, NOW);
      expect(since.getTime()).toBeGreaterThan(0);
      expect(since.getTime()).toBeLessThan(NOW.getTime());
    }
  });

  it("rejects anything outside the supported windows", () => {
    expect(isBronRunStatsWindow("7d")).toBe(true);
    expect(isBronRunStatsWindow("lifetime")).toBe(false);
    expect(isBronRunStatsWindow("1u")).toBe(false);
  });
});

describe("computeBronSuccessRate", () => {
  it("counts only succeeded as success", () => {
    // Motian counted `partial` as success, which kept broken sources green.
    expect(
      computeBronSuccessRate({ running: 0, runs: 4, succeeded: 3 })
    ).toBeCloseTo(0.75, 6);
  });

  it("excludes running runs from the denominator", () => {
    // 1 succeeded, 1 failed, 1 still going -> 1/2, not 1/3.
    expect(
      computeBronSuccessRate({ running: 1, runs: 3, succeeded: 1 })
    ).toBeCloseTo(0.5, 6);
  });

  it("returns null when nothing finished, so no data is not 0%", () => {
    expect(
      computeBronSuccessRate({ running: 0, runs: 0, succeeded: 0 })
    ).toBeNull();
    expect(
      computeBronSuccessRate({ running: 2, runs: 2, succeeded: 0 })
    ).toBeNull();
  });

  it("reports a clean 1 when every finished run succeeded", () => {
    expect(computeBronSuccessRate({ running: 2, runs: 5, succeeded: 3 })).toBe(
      1
    );
  });
});
