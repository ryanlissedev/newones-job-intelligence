import { describe, expect, it } from "bun:test";

import type { SearchAdapter } from "@ji/search";

import { deriveSourceHealthSignals } from "../../observability";
import type { SourceHealthReader } from "../source-health";
import { createMemorySliceAStores } from "../stores/memory";
import type { BronRunStatsReader, BronRunStatsRow } from "../stores/types";
import { createGetDashboardOverviewHandler } from "./dashboard";
import { createGetBronHealthHandler } from "./index";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const BRON_IDS = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
] as const;

const statsRow = (bronId: string): BronRunStatsRow => ({
  aantalGevonden: 2,
  actief: true,
  avgDurationMs: 100,
  bronId,
  cancelled: 0,
  failed: 0,
  fouten: 0,
  gesloten: 0,
  gewijzigd: 1,
  interval: "*/15 * * * *",
  lastCompletion: null,
  lastFailureClass: null,
  lastFailureCode: null,
  lastFailureKind: null,
  lastFailureMessage: null,
  lastFailurePhase: null,
  lastRunAt: NOW,
  lastRunStatus: "succeeded",
  naam: `Bron ${bronId.slice(-3)}`,
  nieuw: 1,
  ongewijzigd: 0,
  onvolledig: 0,
  overgeslagen: 0,
  p95DurationMs: 100,
  rejected: 0,
  running: 0,
  runs: 1,
  succeeded: 1,
  successRate: 1,
  topFailures: [],
});

const statsReader: BronRunStatsReader = {
  bronRunStats: () =>
    Promise.resolve({
      bronnen: BRON_IDS.map(statsRow),
      runKind: "poll" as const,
      since: new Date("2026-09-01T00:00:00.000Z"),
      totaal: statsRow("00000000-0000-4000-8000-000000000199"),
      window: "30d" as const,
    }),
  bronRunTimeseries: () => Promise.resolve([]),
};

const signals = (databaseAvailable = true) =>
  deriveSourceHealthSignals(
    {
      advisoryLock: {
        observation: "held",
        observedAt: new Date("2026-09-19T11:59:00.000Z"),
      },
      database: {
        available: databaseAvailable,
        observedAt: new Date("2026-09-19T11:59:30.000Z"),
      },
      freshness: {
        currentRun: "none",
        lastFullySuccessfulAt: new Date("2026-09-19T11:58:00.000Z"),
      },
      process: {
        heartbeatAt: new Date("2026-09-19T11:59:45.000Z"),
      },
      progress: {
        active: false,
        activeStartedAt: null,
        observedAt: null,
        phase: null,
        phaseStartedAt: null,
      },
      sourceState: "active",
      thresholds: {
        advisoryLockMaxAgeMs: 5 * 60_000,
        curationBudgetMs: 30 * 60_000,
        freshnessMaxAgeMs: 60 * 60_000,
        heartbeatMaxAgeMs: 5 * 60_000,
        runBudgetMs: 15 * 60_000,
      },
    },
    NOW
  );

const depsForDashboard = (sourceHealthReader?: SourceHealthReader) => {
  const stores = createMemorySliceAStores();
  for (const bronId of BRON_IDS) {
    stores.bronHealth.seed({
      bronId,
      circuitStatus: "closed",
      lastRunAt: NOW,
      lastRunStatus: "succeeded",
      silenceAlertOpen: false,
    });
  }
  return {
    bronRunStatsReader: statsReader,
    bronnen: {
      getById: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
    },
    scopeId: "test-scope",
    // SAFETY: dashboard handlers never call searchAdapter.
    searchAdapter: {} as SearchAdapter,
    sourceHealthReader,
    stores,
  };
};

describe("source health application read boundary", () => {
  it("bulk-loads dashboard signals once and serializes observed Dates", async () => {
    let listCalls = 0;
    let getCalls = 0;
    const reader: SourceHealthReader = {
      getByBronId: () => {
        getCalls += 1;
        return Promise.resolve(null);
      },
      listByBronIds: (bronIds) => {
        listCalls += 1;
        expect(bronIds).toEqual(BRON_IDS);
        return Promise.resolve(
          bronIds.map((bronId) => ({ bronId, signals: signals() }))
        );
      },
    };

    const result = await createGetDashboardOverviewHandler(
      depsForDashboard(reader)
    )({ window: "30d" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const [firstBron] = result.value.bronnen;
      expect(firstBron?.health?.healthSignals).toMatchObject({
        process: {
          observedAt: "2026-09-19T11:59:45.000Z",
          reason: "heartbeat_fresh",
        },
      });
    }
    expect(listCalls).toBe(1);
    expect(getCalls).toBe(0);
  });

  it("returns null signals when no telemetry reader is composed", async () => {
    const result = await createGetDashboardOverviewHandler(depsForDashboard())({
      window: "30d",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const [firstBron] = result.value.bronnen;
      expect(firstBron?.health?.healthSignals).toBeNull();
    }
  });

  it("uses the single-source reader for the existing bron health endpoint", async () => {
    const stores = createMemorySliceAStores();
    const [bronId] = BRON_IDS;
    if (bronId === undefined) {
      throw new Error("Expected a source id fixture");
    }
    stores.bronHealth.seed({
      bronId,
      circuitStatus: "closed",
      lastRunAt: NOW,
      lastRunStatus: "succeeded",
      silenceAlertOpen: false,
    });
    let requestedBronId: string | null = null;
    const reader: SourceHealthReader = {
      getByBronId: (requested) => {
        requestedBronId = requested;
        return Promise.resolve({ bronId: requested, signals: signals() });
      },
      listByBronIds: () => Promise.resolve([]),
    };
    const deps = {
      ...depsForDashboard(),
      sourceHealthReader: reader,
      stores,
    };

    const result = await createGetBronHealthHandler(deps)({ bronId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.healthSignals?.database.observedAt).toBe(
        "2026-09-19T11:59:30.000Z"
      );
    }
    expect(requestedBronId).not.toBeNull();
    if (requestedBronId === null) {
      throw new Error("Expected source health reader to be called");
    }
    expect(requestedBronId === bronId).toBe(true);
  });

  it("serves telemetry when the historical bron health row is absent", async () => {
    const stores = createMemorySliceAStores();
    const [bronId] = BRON_IDS;
    if (bronId === undefined) {
      throw new Error("Expected a source id fixture");
    }
    const result = await createGetBronHealthHandler({
      ...depsForDashboard(),
      sourceHealthReader: {
        getByBronId: (requested) =>
          Promise.resolve({ bronId: requested, signals: signals() }),
        listByBronIds: () => Promise.resolve([]),
      },
      stores,
    })({ bronId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        bronId,
        circuitStatus: null,
        healthSignals: { aggregate: { state: "green" } },
        lastRunAt: null,
        lastRunStatus: null,
        silenceAlertOpen: null,
      });
    }
  });
  it("returns unknown telemetry without retrying legacy reads against an unavailable database", async () => {
    const deps = depsForDashboard();
    let legacyReads = 0;
    deps.stores.bronHealth.getByBronId = () => {
      legacyReads += 1;
      return Promise.reject(new Error("database unavailable"));
    };
    const result = await createGetBronHealthHandler({
      ...deps,
      sourceHealthReader: {
        getByBronId: (bronId) =>
          Promise.resolve({ bronId, signals: signals(false) }),
        listByBronIds: () => Promise.resolve([]),
      },
    })({ bronId: BRON_IDS[0] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.healthSignals?.aggregate.reason).toBe(
        "database_unknown"
      );
      expect(result.value.circuitStatus).toBeNull();
    }
    expect(legacyReads).toBe(0);
  });
});
