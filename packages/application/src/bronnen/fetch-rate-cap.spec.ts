import { describe, expect, it } from "bun:test";

import {
  FetchRateCap,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
} from "@ji/connectors";
import type { Connector } from "@ji/connectors";

import { executeBronRun } from "./execute";
import type { BronPersistence, BronRegisterRecord } from "./register";

const record = (bronId: string): BronRegisterRecord => ({
  actief: true,
  bronId,
  categorie: "overheidsportaal",
  // Both hosts would allow a request every 10 ms on their own.
  crawlDelayMs: 0,
  interval: "*/15 * * * *",
  lastRun: null,
  loginVereist: false,
  mappingRef: "fixtures/connectors/tenderned/mapping.json",
  method: "json-api",
  naam: bronId,
  rateLimitPerMinute: 6000,
  retentionDays: 90,
  secretRef: null,
  status: "ready",
  voorwaardenStatus: "toegestaan",
});

const persistenceFor = (row: BronRegisterRecord): BronPersistence => ({
  activate: () => Promise.reject(new Error("activation is not used")),
  create: (created) => Promise.resolve(created),
  findById: () => Promise.resolve(row),
  list: () => Promise.resolve([row]),
});

const ITEMS = 4;

const connectorFor = (bronId: string, starts: number[]): Connector => ({
  bronId,
  discover: () => {
    starts.push(performance.now());
    return Promise.resolve({
      checkpoint: {},
      hasMore: false,
      items: Array.from({ length: ITEMS }, (_, index) => ({
        bronReferentie: `${bronId}-${index}`,
        contentHash: "",
      })),
    });
  },
  fetch: (item) => {
    starts.push(performance.now());
    return Promise.resolve({
      body: new TextEncoder().encode(item.bronReferentie),
      bronReferentie: item.bronReferentie,
      contentHash: new Bun.CryptoHasher("sha256")
        .update(item.bronReferentie)
        .digest("hex"),
      contentType: "html",
      status: "fetched",
    });
  },
});

const runTwoBronnen = async (
  fetchRateCap?: FetchRateCap
): Promise<number[]> => {
  const starts: number[] = [];
  await Promise.all(
    ["cap-bron-a", "cap-bron-b"].map((bronId) =>
      executeBronRun(persistenceFor(record(bronId)), {
        bronId,
        bronSlug: "tenderned",
        connector: connectorFor(bronId, starts),
        fetchRateCap,
        objectStore: new InMemoryObjectStore(),
        observationRecorder: new InMemoryObservationRecorder(),
        runLifecycleStore: new InMemoryRunLifecycleStore(),
        scrapeRunId: `${bronId}-run`,
      })
    )
  );
  return starts.toSorted((left, right) => left - right);
};

const smallestGap = (starts: readonly number[]): number =>
  Math.min(
    ...starts.slice(1).map((start, index) => start - (starts[index] ?? 0))
  );

// 20 starts per second.
const CAP_INTERVAL_MS = 50;
// FetchRateCap schedules on Date.now (whole ms) and rounds waits up; performance.now
// is sub-millisecond, so a start can read up to ~2 ms "early" against it.
const CLOCK_GRANULARITY_MS = 3;

describe("process fetch-rate cap in executeBronRun", () => {
  it("spaces request starts across brons that each allow more", async () => {
    const reference = performance.now();
    const capped = await runTwoBronnen(new FetchRateCap({ perSecond: 20 }));
    // Two brons x (discovery + 4 fetches), every start through the cap.
    expect(capped).toHaveLength(2 * (ITEMS + 1));
    // 20/s = one slot per 50 ms across both brons together. The cap reserves slot k no
    // earlier than slot 0 + k x 50 ms, and slot 0 no earlier than `reference`. A late
    // callback only delays a start, so the gap to the NEXT start can shrink below 50 ms
    // (CI saw 44.8 ms after a 5 ms late start) while the schedule still holds. So assert
    // the schedule, not pairwise gaps: start k is never before reference + k x 50 ms,
    // minus the cap's whole-millisecond clock (Date.now + Math.ceil + timer rounding).
    const lateness = capped.map(
      (start, slot) => start - reference - slot * CAP_INTERVAL_MS
    );
    expect(Math.min(...lateness)).toBeGreaterThanOrEqual(-CLOCK_GRANULARITY_MS);
  });

  it("leaves brons on their own pacing when no cap is configured", async () => {
    const uncapped = await runTwoBronnen();
    expect(uncapped).toHaveLength(2 * (ITEMS + 1));
    // The two brons interleave: some starts are closer than the cap's 50 ms.
    expect(smallestGap(uncapped)).toBeLessThan(45);
  });
});
