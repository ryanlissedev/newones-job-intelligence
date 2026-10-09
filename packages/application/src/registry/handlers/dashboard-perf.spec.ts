import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createMemorySliceAStores } from "../stores/memory";
import type { BronRunStatsReader, BronRunStatsRow } from "../stores/types";
import { createGetDashboardOverviewHandler } from "./dashboard";

const emptyStatsRow = (
  bronId: string | null,
  naam: string | null
): BronRunStatsRow => ({
  aantalGevonden: 0,
  actief: true,
  avgDurationMs: null,
  bronId,
  cancelled: 0,
  failed: 0,
  fouten: 0,
  gesloten: 0,
  gewijzigd: 0,
  interval: "*/15 * * * *",
  lastFailureClass: null,
  lastFailureCode: null,
  lastFailureKind: null,
  lastFailureMessage: null,
  lastFailurePhase: null,
  lastRunAt: null,
  lastRunStatus: null,
  naam,
  nieuw: 0,
  ongewijzigd: 0,
  overgeslagen: 0,
  p95DurationMs: null,
  rejected: 0,
  running: 0,
  runs: 0,
  succeeded: 0,
  successRate: null,
  topFailures: [],
});

describe("get_dashboard_overview request-path discipline (RJC-415)", () => {
  it("keeps get_bron_overlap off the KPI critical path (CTP-417)", () => {
    const dashboardSource = readFileSync(
      path.join(import.meta.dir, "dashboard.ts"),
      "utf-8"
    );
    const pageSource = readFileSync(
      path.join(
        import.meta.dir,
        "../../../../../apps/web/src/app/bronnen/page.tsx"
      ),
      "utf-8"
    );
    expect(dashboardSource).not.toContain("bronOverlap");
    expect(dashboardSource).not.toContain("get_bron_overlap");
    expect(pageSource).toContain("BronnenOverlapSection");
    expect(pageSource).toMatch(
      /<Suspense[\s\S]*?<DashboardData[\s\S]*?<\/Suspense>[\s\S]*?<Suspense[\s\S]*?<BronnenOverlapSection/u
    );
  });

  it("does not import Trigger.dev runs.list in the dashboard handler or /bronnen page", () => {
    const roots = [
      path.join(import.meta.dir, "dashboard.ts"),
      path.resolve(
        import.meta.dir,
        "../../../../../apps/web/src/app/bronnen/page.tsx"
      ),
      path.resolve(
        import.meta.dir,
        "../../../../../apps/web/src/app/bronnen/runs/page.tsx"
      ),
    ];
    for (const file of roots) {
      const source = readFileSync(file, "utf-8");
      expect(source).not.toMatch(/runs\.list\s*\(/u);
      expect(source).not.toMatch(/@trigger\.dev\/sdk/u);
      expect(source).not.toMatch(/from\s+["']@trigger\.dev/u);
    }
  });

  it("loads bron health with one list() instead of N getByBronId", async () => {
    const stores = createMemorySliceAStores();
    const bronIds = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    for (const bronId of bronIds) {
      stores.bronHealth.seed({
        bronId,
        circuitStatus: "closed",
        lastRunAt: new Date("2026-09-04T12:00:00.000Z"),
        lastRunStatus: "succeeded",
        silenceAlertOpen: false,
      });
    }

    let listCalls = 0;
    let getByBronIdCalls = 0;
    const originalList = stores.bronHealth.list.bind(stores.bronHealth);
    const originalGet = stores.bronHealth.getByBronId.bind(stores.bronHealth);
    stores.bronHealth.list = () => {
      listCalls += 1;
      return originalList();
    };
    stores.bronHealth.getByBronId = (bronId: string) => {
      getByBronIdCalls += 1;
      return originalGet(bronId);
    };

    const reader: BronRunStatsReader = {
      bronRunStats: () =>
        Promise.resolve({
          bronnen: bronIds.map((id, index) =>
            emptyStatsRow(id, `Bron ${index}`)
          ),
          runKind: "poll",
          since: new Date("2026-08-05T12:00:00.000Z"),
          totaal: emptyStatsRow(null, null),
          window: "30d",
        }),
      bronRunTimeseries: () => Promise.resolve([]),
    };

    const handler = createGetDashboardOverviewHandler({
      bronRunStatsReader: reader,
      stores,
    });

    const result = await handler({ window: "30d" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bronnen).toHaveLength(3);
      expect(result.value.bronnen.every((row) => row.health !== null)).toBe(
        true
      );
    }
    expect(listCalls).toBe(1);
    expect(getByBronIdCalls).toBe(0);
  });
});
