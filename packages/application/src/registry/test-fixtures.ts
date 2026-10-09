import { SearchAdapter, InMemorySearchEngine } from "@ji/search";

import type { PublicBronView } from "../bronnen";
import { createSpottWriteClient } from "../export/spott/client";
import { createSliceARegistry } from "./catalog";
import type { SliceAHandlerDeps } from "./handlers/deps";
import { createMemorySliceAStores } from "./stores/memory";
import { MemoryMartsReader } from "./stores/memory/marts-reader";
import { MemoryScrapeRunReader } from "./stores/memory/scrape-run-reader";

const testBronnen: PublicBronView[] = [
  {
    actief: true,
    bronId: "00000000-0000-4000-8000-000000000001",
    crawlDelayMs: 0,
    hasSecretRef: false,
    interval: "0 * * * *",
    lastRun: null,
    loginVereist: false,
    mappingRef: null,
    method: "json-api",
    naam: "TenderNed",
    rateLimitPerMinute: 1,
    retentionDays: 90,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  },
];

export const TEST_DEPLOYMENT_SCOPE_ID = "catapulze-test";

export const createTestSliceADeps = (
  scopeId = TEST_DEPLOYMENT_SCOPE_ID
): SliceAHandlerDeps & {
  readonly engine: InMemorySearchEngine;
  readonly stores: ReturnType<typeof createMemorySliceAStores>;
} => {
  const stores = createMemorySliceAStores();
  const engine = new InMemorySearchEngine();
  const searchAdapter = new SearchAdapter({ engine });
  const bronnen = {
    getById: (bronId: string) =>
      Promise.resolve(
        testBronnen.find((item) => item.bronId === bronId) ?? null
      ),
    list: () => Promise.resolve(testBronnen),
  };
  const emptyStats = {
    bronnen: [],
    runKind: "poll" as const,
    since: new Date(0),
    totaal: {
      aantalGevonden: 0,
      actief: null,
      avgDurationMs: null,
      bronId: null,
      cancelled: 0,
      failed: 0,
      fouten: 0,
      gesloten: 0,
      gewijzigd: 0,
      interval: null,
      lastCompletion: null,
      lastFailureClass: null,
      lastFailureCode: null,
      lastFailureKind: null,
      lastFailureMessage: null,
      lastFailurePhase: null,
      lastRunAt: null,
      lastRunStatus: null,
      naam: null,
      nieuw: 0,
      ongewijzigd: 0,
      onvolledig: 0,
      overgeslagen: 0,
      p95DurationMs: null,
      rejected: 0,
      running: 0,
      runs: 0,
      succeeded: 0,
      successRate: null,
      topFailures: [],
    },
    window: "7d" as const,
  };
  return {
    bronOverlapReader: {
      bronOverlap: () =>
        Promise.resolve({
          overlapGroepCount: 0,
          perBron: [],
          topGroups: [],
        }),
    },
    bronRunStatsReader: {
      bronRunStats: () => Promise.resolve(emptyStats),
      bronRunTimeseries: () => Promise.resolve([]),
    },
    bronnen,
    engine,
    martsReader: new MemoryMartsReader(),
    scopeId,
    scrapeRunReader: new MemoryScrapeRunReader(),
    searchAdapter,
    spottWriteClient: createSpottWriteClient({ liveEnabled: false }),
    stores,
  };
};

export const createTestSliceARegistry = (
  scopeId = TEST_DEPLOYMENT_SCOPE_ID
) => {
  const deps = createTestSliceADeps(scopeId);
  return { deps, ...createSliceARegistry(deps) };
};

export type TestSliceARegistryBundle = ReturnType<
  typeof createTestSliceARegistry
>;
