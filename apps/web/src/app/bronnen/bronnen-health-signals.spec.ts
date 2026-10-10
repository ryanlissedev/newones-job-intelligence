import { expect, it } from "bun:test";

import type { SourceHealthSignalsView } from "@ji/application/registry";

import {
  formatHealthAge,
  formatSilenceAlert,
  healthSignalRows,
} from "./bronnen-health-signals";
import { statusFor } from "./bronnen-status";

const signals: SourceHealthSignalsView = {
  advisoryLock: {
    ageMs: 10_000,
    observedAt: "2026-09-19T12:00:00Z",
    reason: "lock_held",
    state: "ok",
  },
  aggregate: { ageMs: 10_000, reason: "progressing", state: "progressing" },
  database: {
    ageMs: 0,
    observedAt: "2026-09-19T12:00:10Z",
    reason: "database_available",
    state: "ok",
  },
  freshness: {
    ageMs: null,
    observedAt: null,
    reason: "never_succeeded",
    state: "unknown",
  },
  process: {
    ageMs: 10_000,
    observedAt: "2026-09-19T12:00:00Z",
    reason: "heartbeat_fresh",
    state: "ok",
  },
  progress: {
    ageMs: null,
    observedAt: null,
    reason: "progress_not_reported",
    state: "unknown",
    waitingAgeMs: 120_000,
  },
};

const bron = (healthSignals: SourceHealthSignalsView, actief = true) => ({
  health: {
    circuitStatus: "closed",
    healthSignals,
    lastRunAt: null,
    silenceAlertOpen: false,
  },
  stats: { actief, lastRunAt: null, lastRunStatus: "failed", runs: 3 },
});

it("uses aggregate health ahead of generic last-run failure", () => {
  expect(statusFor(bron(signals)).label).toBe("Bezig");
  expect(
    statusFor(
      bron({
        ...signals,
        aggregate: { ageMs: null, reason: "healthy", state: "green" },
      })
    ).label
  ).toBe("Gezond");
  expect(
    statusFor(
      bron({
        ...signals,
        aggregate: { ageMs: null, reason: "source_blocked", state: "blocked" },
      })
    ).label
  ).toBe("Geblokkeerd");
  expect(
    statusFor(
      bron({
        ...signals,
        aggregate: {
          ageMs: null,
          reason: "database_unknown",
          state: "unknown",
        },
      })
    ).label
  ).toBe("Onbekend");
  expect(statusFor(bron(signals, false)).label).toBe("Inactief");
});

it("keeps first-progress waiting separate from measurement age", () => {
  const rows = healthSignalRows(signals);
  expect(rows.map((row) => row.label)).toEqual([
    "Proces",
    "Database",
    "Lock",
    "Voortgang",
    "Versheid",
  ]);
  expect(rows[3]).toEqual({
    age: "Onbekend",
    label: "Voortgang",
    reason: "Nog geen voortgang bevestigd",
    waitingAge: "2 min",
  });
  expect(rows[4]?.age).toBe("Onbekend");
  expect(rows[0]?.reason).toBe("Proces meldt zich op tijd");
});

it("does not invent observations when the API has no telemetry", () => {
  expect(
    healthSignalRows(null).every(
      (row) => row.age === "Onbekend" && row.waitingAge === null
    )
  ).toBe(true);
  expect(formatHealthAge(0)).toBe("Minder dan een minuut");
  expect(formatHealthAge(3_600_000)).toBe("1 uur");
  expect(formatHealthAge(172_800_000)).toBe("2 dagen");
});

it("preserves explicit alarms and nullable silence observations", () => {
  const healthy = bron({
    ...signals,
    aggregate: { ageMs: null, reason: "healthy", state: "green" },
  });
  expect(
    statusFor({
      ...healthy,
      health: { ...healthy.health, circuitStatus: "open" },
    }).label
  ).toBe("Aandacht");
  expect(
    statusFor({
      ...healthy,
      health: { ...healthy.health, silenceAlertOpen: true },
    }).label
  ).toBe("Aandacht");
  expect(formatSilenceAlert(null)).toBe("Onbekend");
  expect(formatSilenceAlert(false)).toBe("Nee");
});
