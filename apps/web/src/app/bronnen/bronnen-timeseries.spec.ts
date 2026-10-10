import { describe, expect, it } from "bun:test";

import { aggregateTotalTrend, sparklineByBron } from "./bronnen-timeseries";
import type { BronTimeseriesPoint } from "./bronnen-timeseries";

const point = (
  overrides: Partial<BronTimeseriesPoint> &
    Pick<BronTimeseriesPoint, "bronId" | "bucket">
): BronTimeseriesPoint => ({
  aantalGevonden: 0,
  avgDurationMs: null,
  failed: 0,
  fouten: 0,
  gewijzigd: 0,
  nieuw: 0,
  ongewijzigd: 0,
  rejected: 0,
  runs: 0,
  succeeded: 0,
  ...overrides,
});

describe("bronnen timeseries helpers", () => {
  it("sums per-bron buckets into a total trend series sorted by day", () => {
    const points = [
      point({
        bronId: "b-2",
        bucket: "2026-09-02T00:00:00.000Z",
        failed: 1,
        gewijzigd: 2,
        nieuw: 3,
        rejected: 4,
      }),
      point({
        bronId: "b-1",
        bucket: "2026-09-01T00:00:00.000Z",
        failed: 1,
        gewijzigd: 1,
        nieuw: 5,
        rejected: 0,
      }),
      point({
        bronId: "b-2",
        bucket: "2026-09-01T00:00:00.000Z",
        failed: 0,
        gewijzigd: 4,
        nieuw: 2,
        rejected: 1,
      }),
    ];

    expect(aggregateTotalTrend(points)).toEqual([
      {
        bucket: "2026-09-01T00:00:00.000Z",
        failed: 1,
        gewijzigd: 5,
        nieuw: 7,
        rejected: 1,
      },
      {
        bucket: "2026-09-02T00:00:00.000Z",
        failed: 1,
        gewijzigd: 2,
        nieuw: 3,
        rejected: 4,
      },
    ]);
  });

  it("groups sparkline points per bron without mixing series", () => {
    const points = [
      point({ bronId: "b-1", bucket: "2026-09-02T00:00:00.000Z", nieuw: 9 }),
      point({ bronId: "b-1", bucket: "2026-09-01T00:00:00.000Z", nieuw: 2 }),
      point({ bronId: "b-2", bucket: "2026-09-01T00:00:00.000Z", nieuw: 4 }),
    ];

    const byBron = sparklineByBron(points);
    const seriesOne = byBron.get("b-1");
    const seriesTwo = byBron.get("b-2");
    expect(seriesOne).toBeDefined();
    expect(seriesTwo).toBeDefined();
    expect([...(seriesOne ?? [])]).toEqual([
      { bucket: "2026-09-01T00:00:00.000Z", nieuw: 2 },
      { bucket: "2026-09-02T00:00:00.000Z", nieuw: 9 },
    ]);
    expect([...(seriesTwo ?? [])]).toEqual([
      { bucket: "2026-09-01T00:00:00.000Z", nieuw: 4 },
    ]);
  });
});
