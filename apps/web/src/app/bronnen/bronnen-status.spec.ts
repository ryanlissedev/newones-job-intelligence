import { describe, expect, it } from "bun:test";

import type { DashboardHealth, DashboardStats } from "./bronnen-status";
import { attentionReasons, statusFor } from "./bronnen-status";

const bron = (
  overrides: { health?: DashboardHealth | null; stats?: DashboardStats } = {}
) => ({
  health: overrides.health ?? null,
  stats: overrides.stats ?? {
    actief: true,
    lastRunAt: null,
    lastRunStatus: null,
    runs: 1,
  },
});

describe("bronnen status", () => {
  it("detects a failed last run", () => {
    const value = bron({
      stats: {
        actief: true,
        lastRunAt: null,
        lastRunStatus: "failed",
        runs: 1,
      },
    });
    expect(statusFor(value).label).toBe("Aandacht");
    expect(attentionReasons(value)).toEqual(["last-run-failed"]);
  });
  it("detects an open circuit", () => {
    const value = bron({
      health: {
        circuitStatus: "open",
        lastRunAt: null,
        silenceAlertOpen: false,
      },
    });
    expect(statusFor(value).label).toBe("Aandacht");
    expect(attentionReasons(value)).toEqual(["circuit-open"]);
  });
  it("detects an open silence alert", () => {
    const value = bron({
      health: {
        circuitStatus: "closed",
        lastRunAt: null,
        silenceAlertOpen: true,
      },
    });
    expect(statusFor(value).label).toBe("Aandacht");
    expect(attentionReasons(value)).toEqual(["silence-alert-open"]);
  });
  it("keeps zero-run sources new, not attention", () => {
    const value = bron({
      stats: { actief: true, lastRunAt: null, lastRunStatus: null, runs: 0 },
    });
    expect(statusFor(value).label).toBe("Nieuw");
    expect(attentionReasons(value)).toEqual([]);
  });
  it("does not infer health from historical runs without telemetry", () => {
    const value = bron();
    expect(statusFor(value).label).toBe("Onbekend");
    expect(attentionReasons(value)).toEqual([]);
  });
  it("returns simultaneous reasons", () => {
    const value = bron({
      health: {
        circuitStatus: "open",
        lastRunAt: null,
        silenceAlertOpen: false,
      },
      stats: {
        actief: true,
        lastRunAt: null,
        lastRunStatus: "failed",
        runs: 1,
      },
    });
    expect(attentionReasons(value)).toEqual([
      "circuit-open",
      "last-run-failed",
    ]);
  });
});

describe("bron activation status", () => {
  it.each(["succeeded", "failed", "running", null])(
    "keeps an inactive source inactive with last run %s",
    (lastRunStatus) => {
      const value = bron({
        stats: { actief: false, lastRunAt: null, lastRunStatus, runs: 1 },
      });
      expect(statusFor(value).label).toBe("Inactief");
      if (lastRunStatus === "failed") {
        expect(attentionReasons(value)).toContain("last-run-failed");
      }
    }
  );

  it("does not list an inactive source without runs as new", () => {
    expect(
      statusFor(
        bron({
          stats: {
            actief: false,
            lastRunAt: null,
            lastRunStatus: null,
            runs: 0,
          },
        })
      ).label
    ).toBe("Inactief");
  });

  it.each([null, undefined])(
    "does not infer active from missing state %s",
    (actief) => {
      expect(
        statusFor(
          bron({
            stats: {
              actief,
              lastRunAt: null,
              lastRunStatus: "succeeded",
              runs: 1,
            },
          })
        ).label
      ).toBe("Onbekend");
    }
  );
});
