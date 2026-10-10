import { describe, expect, it } from "bun:test";

import { SOURCES } from "@ji/application/sources";

import {
  buildLevelJobRollup,
  corpusDigest,
  MINTED_URL_SEGMENT,
  mintedListing,
  parseLevels,
  percentile,
  PROBE_BRONNEN,
  resolveMintedDetailUrl,
  summarizeSamples,
} from "./probe";
import type { JobTiming } from "./probe";

describe("probe corpus", () => {
  it("every probe bron resolves a registry bronId and committed detail fixtures", () => {
    expect(PROBE_BRONNEN.length).toBe(13);
    const slugs = new Set(PROBE_BRONNEN.map((bron) => bron.bronSlug));
    expect(slugs.size).toBe(PROBE_BRONNEN.length);
    for (const bron of PROBE_BRONNEN) {
      expect(bron.bronId).toBe(SOURCES[bron.bronSlug].bronId);
      expect(bron.fixtureDetailUrls.length).toBeGreaterThan(0);
      for (const url of bron.fixtureDetailUrls) {
        expect(bron.config.detailFixtures?.[url]).toBeDefined();
      }
    }
  });

  it("minted listing yields pathname-unique referenties cycling the fixture corpus", () => {
    const bron = PROBE_BRONNEN.at(0);
    if (!bron) {
      throw new Error("corpus is empty");
    }
    const listing = mintedListing(bron, 7);
    expect(listing).toHaveLength(7);
    const urls = new Set(listing.map((entry) => entry.url));
    expect(urls.size).toBe(7);
    for (const [index, entry] of listing.entries()) {
      expect(entry.url).toEndWith(`${MINTED_URL_SEGMENT}${index}`);
    }
    // Items cycle the fixture set so every minted URL maps back to a real body.
    const baseCount = bron.fixtureDetailUrls.length;
    const firstFixtureUrl = bron.fixtureDetailUrls.at(0);
    if (!firstFixtureUrl) {
      throw new Error("fixture corpus is empty");
    }
    expect(resolveMintedDetailUrl(listing.at(0)?.url ?? "")).toBe(
      firstFixtureUrl
    );
    expect(resolveMintedDetailUrl(listing.at(baseCount)?.url ?? "")).toBe(
      firstFixtureUrl
    );
  });

  it("resolveMintedDetailUrl round-trips and refuses unscoped URLs", () => {
    const bron = PROBE_BRONNEN.at(1);
    if (!bron) {
      throw new Error("corpus is empty");
    }
    const fixtureUrl = bron.fixtureDetailUrls.at(0);
    if (!fixtureUrl) {
      throw new Error("fixture corpus is empty");
    }
    expect(resolveMintedDetailUrl(`${fixtureUrl}/k5-mint-12`)).toBe(fixtureUrl);
    expect(resolveMintedDetailUrl(fixtureUrl)).toBeNull();
    expect(resolveMintedDetailUrl(`${fixtureUrl}/k5-mint-x`)).toBeNull();
    expect(resolveMintedDetailUrl("")).toBeNull();
  });

  it("corpus digest is stable for identical inputs and sensitive to size", async () => {
    expect(await corpusDigest(20)).toBe(await corpusDigest(20));
    expect(await corpusDigest(20)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(await corpusDigest(20)).not.toBe(await corpusDigest(21));
  });
});

describe("parseLevels", () => {
  it("parses, dedupes and sorts the default ladder", () => {
    expect(parseLevels("2,4,6,8")).toEqual([2, 4, 6, 8]);
    expect(parseLevels("8,2,2")).toEqual([2, 8]);
  });

  it("rejects unknown levels, empties and oversubscription", () => {
    expect(() => parseLevels("")).toThrow("at least one");
    expect(() => parseLevels("3")).toThrow("Unsupported slot level 3");
    expect(() => parseLevels("2,16")).toThrow("Unsupported slot level 16");
  });
});

describe("percentile and summaries", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([5], 0.99)).toBe(5);
    expect(percentile([10, 1], 0.5)).toBe(1);
  });

  it("rejects empty input and out-of-range quantiles", () => {
    expect(() => percentile([], 0.5)).toThrow("without values");
    expect(() => percentile([1], 1.5)).toThrow("between 0 and 1");
  });

  it("summarizes sample sets and returns null on empty input", () => {
    expect(summarizeSamples([])).toBeNull();
    const summary = summarizeSamples([10, 20, 30, 40]);
    expect(summary).toEqual({
      count: 4,
      max: 40,
      mean: 25,
      p50: 20,
      p95: 40,
    });
  });
});

describe("buildLevelJobRollup", () => {
  it("aggregates durations, freshness and written records per level", () => {
    const timings: JobTiming[] = [
      {
        bronSlug: "bam",
        durationMs: 100,
        freshnessMs: 300,
        rejectedRecords: 2,
        scrapeRunId: "a",
        writtenRecords: 20,
      },
      {
        bronSlug: "ns",
        durationMs: 200,
        freshnessMs: 500,
        rejectedRecords: 0,
        scrapeRunId: "b",
        writtenRecords: 30,
      },
    ];
    const rollup = buildLevelJobRollup(timings);
    expect(rollup.itemsWritten).toBe(50);
    expect(rollup.itemsRejected).toBe(2);
    expect(rollup.duration?.p50).toBe(100);
    expect(rollup.duration?.max).toBe(200);
    expect(rollup.freshness?.p50).toBe(300);
  });

  it("returns null summaries for a level with no completed jobs", () => {
    const rollup = buildLevelJobRollup([]);
    expect(rollup.itemsWritten).toBe(0);
    expect(rollup.itemsRejected).toBe(0);
    expect(rollup.duration).toBeNull();
    expect(rollup.freshness).toBeNull();
  });
});
