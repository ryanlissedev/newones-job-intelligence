import { describe, expect, it } from "bun:test";

import { SearchAdapter } from "../adapter";
import { InMemorySearchEngine } from "../in-memory-engine";
import type { SearchEngine } from "../types";
import { MemoryResultCache } from "./result-cache";

/**
 * Traffic: one search per second over ten distinct queries for ten minutes
 * against the default 120 s result TTL, while the projector advances
 * `appliedSequence` on one of two schedules.
 */
const SIMULATED_SECONDS = 600;
const QUERIES = [
  "Azure",
  "Java",
  "Python",
  "SAP",
  "Scrum",
  "Data",
  "DevOps",
  "Security",
  "Cloud",
  "Frontend",
];

/**
 * The churn measured on prod (2026-10-08 23:49–23:51 CEST, 1 s cadence):
 * bursts with a new sequence every ~2 s for ~40 s, then a ~100 s plateau.
 */
const measuredBursts = (second: number): boolean => {
  const inCycle = second % 140;
  return inCycle < 40 && inCycle % 2 === 0;
};

/** A busy poller hour (+24..+50 outbox events/min): a new batch every 3 s. */
const sustainedIngest = (second: number): boolean => second % 3 === 0;

const simulate = async (
  advancesAt: (second: number) => boolean,
  versionPin: ConstructorParameters<typeof SearchAdapter>[0]["versionPin"]
) => {
  let now = 0;
  const engine = new InMemorySearchEngine();
  let versionReads = 0;
  const counted: SearchEngine = {
    applyBatch: (batch) => engine.applyBatch(batch),
    deleteDocument: (id) => engine.deleteDocument(id),
    getAppliedVersion: () => {
      versionReads += 1;
      return engine.getAppliedVersion();
    },
    search: (params) => engine.search(params),
    upsertDocument: (document) => engine.upsertDocument(document),
  };
  const adapter = new SearchAdapter({
    cache: new MemoryResultCache(500, () => now),
    engine: counted,
    versionPin: { ...versionPin, now: () => now },
  });

  let sequence = 1n;
  await engine.applyBatch({ appliedSequence: sequence, mutations: [] });
  let hits = 0;
  for (let second = 0; second < SIMULATED_SECONDS; second += 1) {
    now = second * 1000;
    if (advancesAt(second)) {
      sequence += 1n;
      // oxlint-disable-next-line no-await-in-loop -- the replay is strictly sequential
      await engine.applyBatch({ appliedSequence: sequence, mutations: [] });
    }
    // oxlint-disable-next-line no-await-in-loop -- the replay is strictly sequential
    const result = await adapter.search({
      query: QUERIES[second % QUERIES.length] ?? "Azure",
    });
    if (result.ok && result.cache === "hit") {
      hits += 1;
    }
    // Let a background version refresh land before the next second.
    // oxlint-disable-next-line no-await-in-loop -- the replay is strictly sequential
    await Promise.resolve();
  }
  return { hitRate: hits / SIMULATED_SECONDS, versionReads };
};

describe("search cache hit rate under projector churn", () => {
  // Every-sequence keying: re-read and re-pin on every search, which is what
  // keying on the exact appliedSequence did before.
  const everySequence = { minPinMs: 0, refreshMs: 0 };

  it("replaying the measured burst/plateau churn", async () => {
    const exact = await simulate(measuredBursts, everySequence);
    const pinned = await simulate(measuredBursts, undefined);

    expect(pinned.hitRate).toBeGreaterThan(0.8);
    expect(pinned.hitRate - exact.hitRate).toBeGreaterThan(0.15);
    // One background read per 5 s instead of one awaited read per search.
    expect(pinned.versionReads).toBeLessThanOrEqual(SIMULATED_SECONDS / 5 + 1);
    expect(exact.versionReads).toBeGreaterThanOrEqual(SIMULATED_SECONDS);
  });

  it("under sustained ingestion", async () => {
    const exact = await simulate(sustainedIngest, everySequence);
    const pinned = await simulate(sustainedIngest, undefined);

    expect(exact.hitRate).toBeLessThan(0.3);
    expect(pinned.hitRate).toBeGreaterThan(0.75);
  });
});
