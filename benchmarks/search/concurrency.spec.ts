import { describe, expect, it } from "bun:test";

import { emptySearchFacets, SearchAdapter } from "@ji/search";
import type { SearchEngine } from "@ji/search";

import type { BenchmarkProfile } from "./run";
import { benchmarkProfileSchema, runMeasured, runWarmup } from "./run";

const SEARCH_DELAY_MS = 5;
const STUB_WINDOW_LIMIT = 1000;

interface InFlightTracker {
  engine: SearchEngine;
  maxInFlight: number;
  resetMax: () => void;
}

// Fake engine that counts calls in flight — proves the measured/warmup
// loop never has more than `profile.concurrency` searches running at once,
// without depending on Manticore or timing flakiness. A plain object (not a
// class) so there is no `this`-bound state to satisfy a lint rule around.
const createInFlightTrackingEngine = (): InFlightTracker => {
  let inFlight = 0;
  const tracker: InFlightTracker = {
    engine: {
      applyBatch: (batch) =>
        Promise.resolve({
          appliedSequence: batch.appliedSequence,
          failures: [],
          generation: 1,
          unapplied: [],
        }),
      deleteDocument: () => Promise.resolve(),
      getAppliedVersion: () =>
        Promise.resolve({ appliedSequence: 1n, generation: 1 }),
      async search() {
        inFlight += 1;
        tracker.maxInFlight = Math.max(tracker.maxInFlight, inFlight);
        await Bun.sleep(SEARCH_DELAY_MS);
        inFlight -= 1;
        return {
          facets: emptySearchFacets(),
          hits: [],
          incomplete: false,
          indexVersion: 1,
          scope: "active",
          total: 0,
          windowLimit: STUB_WINDOW_LIMIT,
        };
      },
      upsertDocument: () => Promise.resolve(),
    },
    maxInFlight: 0,
    resetMax: () => {
      tracker.maxInFlight = 0;
    },
  };
  return tracker;
};

const buildProfile = (
  concurrency: number,
  measuredIterations: number
): BenchmarkProfile => ({
  concurrency,
  corpus: { expectedDocuments: 0, pointer: "" },
  measuredIterations,
  queries: [
    { id: "q1", query: "consultant", weight: 1 },
    { id: "q2", query: "java", weight: 1 },
    { id: "q3", query: "scrum", weight: 1 },
  ],
  slo: { boundary: "SearchAdapter", maxMs: 100, metric: "p95" },
  warmupIterations: 1,
});

describe("runMeasured concurrency", () => {
  it("never runs more searches in flight than profile.concurrency", async () => {
    const tracker = createInFlightTrackingEngine();
    const adapter = new SearchAdapter({ engine: tracker.engine });
    const profile = buildProfile(2, 5);

    await runWarmup(adapter, profile);
    // Only the measured loop's concurrency is under test.
    tracker.resetMax();
    const durationsMs = await runMeasured(adapter, profile);

    expect(tracker.maxInFlight).toBeLessThanOrEqual(profile.concurrency);
    // Proves it actually used concurrency, not serial execution (concurrency=1).
    expect(tracker.maxInFlight).toBeGreaterThan(1);
    expect(durationsMs).toHaveLength(
      profile.measuredIterations * profile.queries.length
    );
  });

  it("respects a higher concurrency value", async () => {
    const tracker = createInFlightTrackingEngine();
    const adapter = new SearchAdapter({ engine: tracker.engine });
    const profile = buildProfile(3, 4);

    const durationsMs = await runMeasured(adapter, profile);

    expect(tracker.maxInFlight).toBeLessThanOrEqual(profile.concurrency);
    expect(durationsMs).toHaveLength(
      profile.measuredIterations * profile.queries.length
    );
  });
});

describe("benchmarkProfileSchema concurrency", () => {
  it("rejects a profile with concurrency: 0", () => {
    const profile = buildProfile(0, 1);
    expect(benchmarkProfileSchema.safeParse(profile).success).toBe(false);
  });
});
