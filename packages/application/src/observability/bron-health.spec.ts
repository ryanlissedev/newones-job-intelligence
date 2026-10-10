import { describe, expect, it } from "bun:test";

import type {
  BronHealthInput,
  BronHealthSignalCode,
  BronHealthStatus,
  BronRunActivity,
} from "./bron-health";
import {
  deriveBronHealth,
  deriveBronHealthOverview,
  deriveNextRunAt,
  isSchedulerStale,
  smallestIntervalMs,
} from "./bron-health";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const minutesAgo = (minutes: number): Date =>
  new Date(NOW.getTime() - minutes * MINUTE);

const quietRun = (): BronRunActivity => ({
  gewijzigd: 0,
  nieuw: 0,
  ongewijzigd: 42,
  status: "succeeded",
});

/** A source that is up, on schedule and unremarkable. */
const healthyBron = (
  overrides: Partial<BronHealthInput> = {}
): BronHealthInput => ({
  actief: true,
  bronId: "00000000-0000-4000-8000-000000000001",
  failedRuns24h: 0,
  interval: "*/15 * * * *",
  lastFailureClass: null,
  lastFailureCode: null,
  lastRunAt: minutesAgo(5),
  lastRunCircuitStatus: "closed",
  lastRunStatus: "succeeded",
  naam: "TenderNed",
  recentRuns: [],
  silenceAlertOpen: false,
  ...overrides,
});

const codesOf = (
  input: BronHealthInput,
  options = {}
): BronHealthSignalCode[] =>
  deriveBronHealth(input, NOW, options).signals.map((entry) => entry.code);

const levelOf = (
  input: BronHealthInput,
  code: BronHealthSignalCode,
  options = {}
): string | undefined =>
  deriveBronHealth(input, NOW, options).signals.find(
    (entry) => entry.code === code
  )?.level;

describe("deriveBronHealth is pure", () => {
  it("derives the same result twice from the same input", () => {
    const input = healthyBron({ failedRuns24h: 2, silenceAlertOpen: true });
    expect(deriveBronHealth(input, NOW)).toEqual(deriveBronHealth(input, NOW));
  });

  it("moves only with the injected clock, never the wall clock", () => {
    const input = healthyBron({ lastRunAt: minutesAgo(90) });
    expect(deriveBronHealth(input, NOW).isOverdue).toBe(true);
    // Same input, a clock rewound to just after the last run.
    expect(
      deriveBronHealth(input, new Date(NOW.getTime() - 88 * MINUTE)).isOverdue
    ).toBe(false);
  });
});

describe("signal codes", () => {
  it("inactive: reports only inactive and suppresses every other signal", () => {
    const input = healthyBron({
      actief: false,
      failedRuns24h: 9,
      lastFailureClass: "connector",
      lastFailureCode: "FETCH_FAILED",
      lastRunAt: minutesAgo(600),
      lastRunCircuitStatus: "open",
      lastRunStatus: "failed",
      silenceAlertOpen: true,
    });
    const result = deriveBronHealth(input, NOW, { schedulerStale: true });

    expect(result.signals.map((entry) => entry.code)).toEqual(["inactive"]);
    expect(result.signals[0]?.level).toBe("info");
    expect(result.status).toBe("inactief");
    expect(result.isOverdue).toBe(false);
  });

  it("never_run: warns when the source has no run at all", () => {
    const input = healthyBron({ lastRunAt: null, lastRunCircuitStatus: null });
    expect(codesOf(input)).toContain("never_run");
    expect(levelOf(input, "never_run")).toBe("warning");
  });

  it("circuit_open: is critical whenever the circuit is not closed", () => {
    const input = healthyBron({ lastRunCircuitStatus: "open" });
    expect(codesOf(input)).toContain("circuit_open");
    expect(levelOf(input, "circuit_open")).toBe("critical");
  });

  it("schedule_overdue: warns only once the grace window has passed", () => {
    // Due at 12:00Z exactly; the grace window still covers it.
    const onTime = healthyBron({ lastRunAt: minutesAgo(5) });
    expect(codesOf(onTime)).not.toContain("schedule_overdue");
    expect(deriveBronHealth(onTime, NOW).isOverdue).toBe(false);

    const late = healthyBron({ lastRunAt: minutesAgo(90) });
    expect(codesOf(late)).toContain("schedule_overdue");
    expect(levelOf(late, "schedule_overdue")).toBe("warning");
    expect(deriveBronHealth(late, NOW).isOverdue).toBe(true);
  });

  it("schedule_overdue: escalates to critical when the circuit is open", () => {
    const input = healthyBron({
      lastRunAt: minutesAgo(90),
      lastRunCircuitStatus: "open",
    });
    expect(levelOf(input, "schedule_overdue")).toBe("critical");
  });

  it("scheduler_stale: is critical and comes from the overview, not the source", () => {
    const input = healthyBron();
    expect(codesOf(input)).not.toContain("scheduler_stale");
    expect(codesOf(input, { schedulerStale: true })).toContain(
      "scheduler_stale"
    );
    expect(levelOf(input, "scheduler_stale", { schedulerStale: true })).toBe(
      "critical"
    );
  });

  it("recent_failures: warns below the threshold and is critical at or above it", () => {
    expect(levelOf(healthyBron({ failedRuns24h: 1 }), "recent_failures")).toBe(
      "warning"
    );
    expect(levelOf(healthyBron({ failedRuns24h: 2 }), "recent_failures")).toBe(
      "warning"
    );
    expect(levelOf(healthyBron({ failedRuns24h: 3 }), "recent_failures")).toBe(
      "critical"
    );
    expect(codesOf(healthyBron({ failedRuns24h: 0 }))).not.toContain(
      "recent_failures"
    );
  });

  it("latest_error: carries the failure envelope, critical when the last run failed", () => {
    const recovered = healthyBron({
      lastFailureClass: "connector",
      lastFailureCode: "FETCH_FAILED",
      lastRunStatus: "succeeded",
    });
    expect(levelOf(recovered, "latest_error")).toBe("warning");

    const failing = healthyBron({
      lastFailureClass: "connector",
      lastFailureCode: "FETCH_FAILED",
      lastRunStatus: "failed",
    });
    expect(levelOf(failing, "latest_error")).toBe("critical");

    const detail = deriveBronHealth(failing, NOW).signals.find(
      (entry) => entry.code === "latest_error"
    )?.detail;
    expect(detail).toBe("connector/FETCH_FAILED");
  });

  it("silence_open: warns while the bron.stil alert is open", () => {
    const input = healthyBron({ silenceAlertOpen: true });
    expect(codesOf(input)).toContain("silence_open");
    expect(levelOf(input, "silence_open")).toBe("warning");
  });

  it("zero_activity: is informational and never raises the status", () => {
    const input = healthyBron({
      recentRuns: [quietRun(), quietRun(), quietRun()],
    });
    const result = deriveBronHealth(input, NOW);

    expect(result.signals.map((entry) => entry.code)).toEqual([
      "zero_activity",
    ]);
    expect(result.signals[0]?.level).toBe("info");
    // Alive, nothing new upstream — explicitly not an alarm.
    expect(result.status).toBe("gezond");
  });

  it.each([
    ["fewer than three runs", [quietRun(), quietRun()]],
    [
      "a run that found something new",
      [{ ...quietRun(), nieuw: 1 }, quietRun(), quietRun()],
    ],
    [
      "a run that changed something",
      [quietRun(), { ...quietRun(), gewijzigd: 1 }, quietRun()],
    ],
    [
      "a run that saw nothing at all",
      [quietRun(), quietRun(), { ...quietRun(), ongewijzigd: 0 }],
    ],
    [
      "a run that did not succeed",
      [quietRun(), quietRun(), { ...quietRun(), status: "failed" }],
    ],
  ])("zero_activity: does not fire for %s", (_label, recentRuns) => {
    expect(codesOf(healthyBron({ recentRuns }))).not.toContain("zero_activity");
  });
});

describe("status precedence", () => {
  const precedence: readonly [string, BronHealthInput, BronHealthStatus][] = [
    [
      "inactief when the source is switched off, whatever else is wrong",
      healthyBron({ actief: false, failedRuns24h: 9 }),
      "inactief",
    ],
    [
      "kritiek when any signal is critical",
      healthyBron({ lastRunCircuitStatus: "open" }),
      "kritiek",
    ],
    [
      "kritiek even when warnings outnumber the critical",
      healthyBron({
        failedRuns24h: 1,
        lastRunCircuitStatus: "half-open",
        silenceAlertOpen: true,
      }),
      "kritiek",
    ],
    [
      "waarschuwing when warnings are the worst present",
      healthyBron({ failedRuns24h: 1, silenceAlertOpen: true }),
      "waarschuwing",
    ],
    ["gezond when nothing is signalled", healthyBron(), "gezond"],
    [
      "gezond when only informational signals are present",
      healthyBron({ recentRuns: [quietRun(), quietRun(), quietRun()] }),
      "gezond",
    ],
  ];

  it.each(precedence)("%s", (_label, input, expected) => {
    expect(deriveBronHealth(input, NOW).status).toBe(expected);
  });
});

describe("deriveNextRunAt", () => {
  it("measures from the last run so a late source is not instantly late again", () => {
    const input = healthyBron({
      lastRunAt: new Date("2026-09-04T11:52:00.000Z"),
    });
    expect(deriveNextRunAt(input, NOW)?.toISOString()).toBe(
      "2026-09-04T12:00:00.000Z"
    );
  });

  it("measures from now when the source has never run", () => {
    const input = healthyBron({ lastRunAt: null });
    expect(deriveNextRunAt(input, NOW)?.toISOString()).toBe(
      "2026-09-04T12:15:00.000Z"
    );
  });

  it("returns null for an interval that is not a usable cron", () => {
    expect(
      deriveNextRunAt(healthyBron({ interval: "hourly" }), NOW)
    ).toBeNull();
  });

  it("leaves nextRunAt null and never overdue when the interval is unusable", () => {
    const result = deriveBronHealth(healthyBron({ interval: "hourly" }), NOW);
    expect(result.nextRunAt).toBeNull();
    expect(result.isOverdue).toBe(false);
    expect(result.signals.map((entry) => entry.code)).not.toContain(
      "schedule_overdue"
    );
  });
});

describe("scheduler_stale is decided across every source", () => {
  const fifteen = healthyBron({
    bronId: "00000000-0000-4000-8000-00000000000a",
    interval: "*/15 * * * *",
  });
  const hourly = healthyBron({
    bronId: "00000000-0000-4000-8000-00000000000b",
    interval: "0 * * * *",
  });

  it("takes the smallest interval across active sources", () => {
    expect(smallestIntervalMs([fifteen, hourly], NOW)).toBe(15 * MINUTE);
  });

  it("ignores inactive sources when sizing the budget", () => {
    const tight = healthyBron({ actief: false, interval: "* * * * *" });
    expect(smallestIntervalMs([fifteen, hourly, tight], NOW)).toBe(15 * MINUTE);
  });

  it("is quiet while polls keep arriving inside two intervals", () => {
    expect(
      isSchedulerStale(
        { bronnen: [fifteen, hourly], lastPollRunAt: minutesAgo(20) },
        NOW
      )
    ).toBe(false);
  });

  it("fires once no source has polled for more than two intervals", () => {
    expect(
      isSchedulerStale(
        { bronnen: [fifteen, hourly], lastPollRunAt: minutesAgo(45) },
        NOW
      )
    ).toBe(true);
  });

  it("stays quiet when there are no active sources to schedule", () => {
    expect(
      isSchedulerStale(
        {
          bronnen: [healthyBron({ actief: false })],
          lastPollRunAt: new Date(NOW.getTime() - 30 * HOUR),
        },
        NOW
      )
    ).toBe(false);
  });

  it("propagates the verdict to every active source, and to no inactive one", () => {
    const off = healthyBron({
      actief: false,
      bronId: "00000000-0000-4000-8000-00000000000c",
    });
    const overview = deriveBronHealthOverview(
      { bronnen: [fifteen, hourly, off], lastPollRunAt: minutesAgo(45) },
      NOW
    );

    expect(overview.schedulerStale).toBe(true);
    for (const bron of overview.bronnen.filter(
      (entry) => entry.status !== "inactief"
    )) {
      expect(bron.signals.map((entry) => entry.code)).toContain(
        "scheduler_stale"
      );
      expect(bron.status).toBe("kritiek");
    }
    const inactive = overview.bronnen.find(
      (entry) => entry.bronId === off.bronId
    );
    expect(inactive?.signals.map((entry) => entry.code)).toEqual(["inactive"]);
  });

  it("does not mark a healthy register stale", () => {
    const overview = deriveBronHealthOverview(
      { bronnen: [fifteen, hourly], lastPollRunAt: minutesAgo(5) },
      NOW
    );
    expect(overview.schedulerStale).toBe(false);
    for (const bron of overview.bronnen) {
      expect(bron.status).toBe("gezond");
    }
  });
});
