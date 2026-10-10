import { describe, expect, it } from "bun:test";

import { JOB_FIXTURES } from "./fixtures";
import { sourceLabel } from "./presentation";
import {
  countJobsWithHourlyRate,
  hourlyRateBuckets,
  jobsPerLocation,
  jobsPerSource,
  topSkills,
  weeklyPublicationVolume,
} from "./preview-metrics";

describe("weekly publication volume", () => {
  it("keeps empty weeks inside the range as explicit zeros", () => {
    const series = weeklyPublicationVolume([
      // Two publications three weeks apart: the two weeks between them are
      // real zeros, not missing points, or the area chart draws a lie.
      { ...JOB_FIXTURES[0], publishedAt: "2026-07-06T09:00:00.000Z" },
      { ...JOB_FIXTURES[1], publishedAt: "2026-07-27T09:00:00.000Z" },
    ]);

    expect(series).toHaveLength(4);
    expect(series.map(({ count }) => count)).toEqual([1, 0, 0, 1]);
  });

  it("buckets a week onto its Monday regardless of the weekday published", () => {
    // 2026-08-30 is a Sunday; its week opens Monday 2026-08-24.
    const [point] = weeklyPublicationVolume([
      { ...JOB_FIXTURES[0], publishedAt: "2026-08-30T06:00:00.000Z" },
    ]);

    expect(point?.week).toBe("2026-08-24T00:00:00.000Z");
    expect(point?.count).toBe(1);
  });

  it("returns nothing for an empty set instead of a bare axis", () => {
    expect(weeklyPublicationVolume([])).toEqual([]);
  });
});

describe("categorical breakdowns", () => {
  it("counts every fixture exactly once per bron", () => {
    const perSource = jobsPerSource(JOB_FIXTURES, sourceLabel);
    const total = perSource.reduce((sum, { count }) => sum + count, 0);

    expect(total).toBe(JOB_FIXTURES.length);
    expect(perSource.map(({ label }) => label)).toContain("Inhuurdesk");
  });

  it("orders by count, then alphabetically, so ties are stable", () => {
    const perLocation = jobsPerLocation(JOB_FIXTURES);
    const counts = perLocation.map(({ count }) => count);

    expect(counts).toEqual(counts.toSorted((a, b) => b - a));
    const tiedLabels = perLocation
      .filter(({ count }) => count === counts.at(-1))
      .map(({ label }) => label);
    expect(tiedLabels).toEqual(
      tiedLabels.toSorted((a, b) => a.localeCompare(b, "nl"))
    );
  });

  it("caps the skill list at the requested limit", () => {
    expect(topSkills(JOB_FIXTURES, 3)).toHaveLength(3);
  });
});

describe("hourly rate buckets", () => {
  it("floors each rate into a €10 bucket and fills the gaps between them", () => {
    const buckets = hourlyRateBuckets(JOB_FIXTURES);
    const values = buckets.map(({ bucket }) => bucket);

    expect(values).toEqual(
      Array.from(
        { length: values.length },
        (_, index) => (values[0] ?? 0) + index * 10
      )
    );
    expect(buckets.every(({ bucket }) => bucket % 10 === 0)).toBe(true);
  });

  it("excludes yearly rates rather than inventing an hourly equivalent", () => {
    const yearlyJobs = JOB_FIXTURES.filter(
      ({ rate }) => rate?.period === "year"
    );
    expect(yearlyJobs.length).toBeGreaterThan(0);

    const hourlyTotal = hourlyRateBuckets(JOB_FIXTURES).reduce(
      (sum, { count }) => sum + count,
      0
    );
    const hourlyJobs = JOB_FIXTURES.filter(
      ({ rate }) => rate?.period === "hour"
    );

    expect(hourlyTotal).toBe(hourlyJobs.length);
    // A €82.000 yearly rate would land in a bucket far off the axis.
    expect(hourlyRateBuckets(JOB_FIXTURES).at(-1)?.bucket).toBeLessThan(1000);
  });

  it("returns nothing when no job publishes an hourly rate", () => {
    expect(
      hourlyRateBuckets(JOB_FIXTURES.map((job) => ({ ...job, rate: null })))
    ).toEqual([]);
  });
});

describe("rate coverage", () => {
  it("counts only jobs with an hourly rate", () => {
    const withRate = countJobsWithHourlyRate(JOB_FIXTURES);
    const hourlyJobs = JOB_FIXTURES.filter(
      ({ rate }) => rate?.period === "hour"
    ).length;

    expect(withRate).toBe(hourlyJobs);
    expect(withRate).toBeLessThan(JOB_FIXTURES.length);
  });

  it("excludes day and unknown periods from hourly coverage", () => {
    const [fixture] = JOB_FIXTURES;
    if (!fixture) {
      throw new Error("Expected at least one job fixture");
    }
    const jobs = [
      fixture,
      {
        ...fixture,
        id: "day-rate",
        rate: {
          currency: "EUR" as const,
          max: 500,
          min: null,
          period: "day" as const,
        },
      },
      {
        ...fixture,
        id: "unknown-rate",
        rate: {
          currency: "EUR" as const,
          max: 500,
          min: null,
          period: "unknown" as const,
        },
      },
    ];

    expect(countJobsWithHourlyRate(jobs)).toBe(1);
  });
});
