import { describe, expect, it } from "bun:test";

import { deriveSourceHealthSignals } from "@ji/application/observability";
import {
  createSliceARegistry,
  createTestSliceADeps,
} from "@ji/application/registry";
import type {
  BronRunStatsReader,
  BronRunStatsRow,
  SourceHealthReader,
} from "@ji/application/registry";
import { Hono } from "hono";

import { createSessionPrincipalResolver } from "./auth";
import type { SessionLookup } from "./auth";
import { createRestCapabilityHandler, restRoutesFromRegistry } from "./rest";

const BRON_ID = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-19T12:00:00.000Z");

const statsRow = (bronId: string): BronRunStatsRow => ({
  aantalGevonden: 1,
  actief: true,
  avgDurationMs: 100,
  bronId,
  cancelled: 0,
  failed: 0,
  fouten: 0,
  gesloten: 0,
  gewijzigd: 1,
  interval: "*/15 * * * *",
  lastFailureClass: null,
  lastFailureCode: null,
  lastFailureKind: null,
  lastFailureMessage: null,
  lastFailurePhase: null,
  lastRunAt: NOW,
  lastRunStatus: "succeeded",
  naam: "Fixture bron",
  nieuw: 1,
  ongewijzigd: 0,
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
      bronnen: [statsRow(BRON_ID)],
      runKind: "poll" as const,
      since: new Date("2026-09-12T12:00:00.000Z"),
      totaal: statsRow("00000000-0000-0000-0000-000000000099"),
      window: "7d" as const,
    }),
  bronRunTimeseries: () => Promise.resolve([]),
};

const sourceHealthReader: SourceHealthReader = {
  getByBronId: () => Promise.resolve(null),
  listByBronIds: (bronIds) =>
    Promise.resolve(
      bronIds.map((bronId) => ({
        bronId,
        signals: deriveSourceHealthSignals(
          {
            advisoryLock: {
              observation: "held",
              observedAt: new Date("2026-09-19T11:59:00.000Z"),
            },
            database: {
              available: true,
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
        ),
      }))
    ),
};

const createDashboardApp = () => {
  const baseDeps = createTestSliceADeps();
  let sourceHealthReads = 0;
  const deps = {
    ...baseDeps,
    bronRunStatsReader: statsReader,
    sourceHealthReader: {
      ...sourceHealthReader,
      listByBronIds: (bronIds: readonly string[]) => {
        sourceHealthReads += 1;
        return sourceHealthReader.listByBronIds(bronIds);
      },
    },
  };
  const { registry } = createSliceARegistry(deps);
  const sessions = new Map([
    [
      "valid-session",
      {
        session: { expiresAt: new Date("2026-09-19T13:00:00.000Z") },
        user: { id: "operator-1", role: "operator" },
      },
    ],
    [
      "expired-session",
      {
        session: { expiresAt: new Date("2026-09-19T11:00:00.000Z") },
        user: { id: "operator-1", role: "operator" },
      },
    ],
  ]);

  const lookupSession: SessionLookup = (headers) => {
    const authorization = headers.get("Authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    return Promise.resolve(
      token === null ? null : (sessions.get(token) ?? null)
    );
  };
  const resolvePrincipal = createSessionPrincipalResolver(
    lookupSession,
    () => NOW
  );
  const handler = createRestCapabilityHandler(
    registry,
    restRoutesFromRegistry(registry),
    resolvePrincipal,
    { allowedCookieOrigin: "https://app.catapulze.test" }
  );
  const app = new Hono();
  app.all("/v1/*", handler);
  return { app, sourceHealthReads: () => sourceHealthReads };
};

describe("dashboard REST authentication and serialization", () => {
  it.each([
    ["anonymous", undefined],
    ["invalid session", "invalid-session"],
    ["expired session", "expired-session"],
  ])("returns 401 for %s", async (_label, token) => {
    const { app, sourceHealthReads } = createDashboardApp();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await app.request("/v1/dashboard?window=7d", {
      headers,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
      ok: false,
    });
    expect(sourceHealthReads()).toBe(0);
  });

  it("returns healthSignals with ISO dates for an authenticated operator", async () => {
    const { app, sourceHealthReads } = createDashboardApp();
    const response = await app.request("/v1/dashboard?window=7d", {
      headers: { Authorization: "Bearer valid-session" },
    });

    expect(response.status).toBe(200);
    // SAFETY: the successful dashboard response schema always includes bronnen with healthSignals here.
    const body = (await response.json()) as {
      readonly bronnen: readonly [
        {
          readonly health: {
            readonly healthSignals: {
              readonly database: { readonly observedAt: string };
              readonly process: { readonly observedAt: string };
            };
          };
        },
      ];
    };
    expect(body.bronnen[0]?.health.healthSignals).toMatchObject({
      database: { observedAt: "2026-09-19T11:59:30.000Z" },
      process: { observedAt: "2026-09-19T11:59:45.000Z" },
    });
    expect(sourceHealthReads()).toBe(1);
  });
});
