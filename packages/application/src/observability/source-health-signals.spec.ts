import { describe, expect, it } from "bun:test";

import { deriveSourceHealthSignals } from "./source-health-signals";
import type { SourceHealthSignalsInput } from "./source-health-signals";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const MINUTE = 60_000;

const healthyInput = (
  overrides: Partial<SourceHealthSignalsInput> = {}
): SourceHealthSignalsInput => ({
  advisoryLock: {
    observation: "held",
    observedAt: new Date(NOW.getTime() - 1 * MINUTE),
  },
  database: {
    available: true,
    observedAt: new Date(NOW.getTime() - 1 * MINUTE),
  },
  freshness: {
    currentRun: "none",
    lastFullySuccessfulAt: new Date(NOW.getTime() - 1 * MINUTE),
  },
  process: {
    heartbeatAt: new Date(NOW.getTime() - 1 * MINUTE),
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
    advisoryLockMaxAgeMs: 5 * MINUTE,
    curationBudgetMs: 30 * MINUTE,
    freshnessMaxAgeMs: 60 * MINUTE,
    heartbeatMaxAgeMs: 5 * MINUTE,
    runBudgetMs: 15 * MINUTE,
  },
  ...overrides,
});

describe("deriveSourceHealthSignals", () => {
  it("returns independent reasons and ages for every signal", () => {
    const result = deriveSourceHealthSignals(healthyInput(), NOW);

    expect(result.database).toMatchObject({
      ageMs: MINUTE,
      reason: "database_available",
      state: "ok",
    });
    expect(result.process).toMatchObject({
      ageMs: MINUTE,
      reason: "heartbeat_fresh",
      state: "ok",
    });
    expect(result.advisoryLock).toMatchObject({
      ageMs: MINUTE,
      reason: "lock_held",
      state: "ok",
    });
    expect(result.progress).toMatchObject({
      ageMs: null,
      reason: "no_active_run",
      state: "ok",
    });
    expect(result.freshness).toMatchObject({
      ageMs: MINUTE,
      reason: "last_full_success_fresh",
      state: "ok",
    });
    expect(result.aggregate).toEqual({
      ageMs: null,
      reason: "healthy",
      state: "green",
    });
  });

  it("keeps a stale heartbeat red even when progress is recent", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        freshness: {
          currentRun: "none",
          lastFullySuccessfulAt: new Date(NOW.getTime() - 2 * 60 * MINUTE),
        },
        process: { heartbeatAt: new Date(NOW.getTime() - 6 * MINUTE) },
        progress: {
          active: true,
          activeStartedAt: new Date(NOW.getTime() - 10 * MINUTE),
          observedAt: new Date(NOW.getTime() - 1 * MINUTE),
          phase: "persist",
          phaseStartedAt: new Date(NOW.getTime() - 10 * MINUTE),
        },
      }),
      NOW
    );

    expect(result.process).toMatchObject({
      reason: "heartbeat_stale",
      state: "stale",
    });
    expect(result.progress).toMatchObject({
      reason: "progressing",
      state: "progressing",
    });
    expect(result.aggregate).toMatchObject({
      reason: "worker_dead",
      state: "red",
    });
  });

  it("marks a stalled source red despite a live heartbeat", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        progress: {
          active: true,
          activeStartedAt: new Date(NOW.getTime() - 20 * MINUTE),
          observedAt: new Date(NOW.getTime() - 16 * MINUTE),
          phase: "persist",
          phaseStartedAt: new Date(NOW.getTime() - 20 * MINUTE),
        },
      }),
      NOW
    );

    expect(result.process.state).toBe("ok");
    expect(result.progress).toMatchObject({
      reason: "progress_stalled",
      state: "stale",
    });
    expect(result.aggregate).toMatchObject({
      reason: "progress_stalled",
      state: "red",
    });
  });

  it("keeps an active long run progressing instead of red on old freshness", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        freshness: {
          currentRun: "incomplete",
          lastFullySuccessfulAt: new Date(NOW.getTime() - 2 * 60 * MINUTE),
        },
        progress: {
          active: true,
          activeStartedAt: new Date(NOW.getTime() - 10 * MINUTE),
          observedAt: new Date(NOW.getTime() - 1 * MINUTE),
          phase: "curation",
          phaseStartedAt: new Date(NOW.getTime() - 1 * MINUTE),
        },
      }),
      NOW
    );

    expect(result.freshness.reason).toBe("current_run_incomplete");
    expect(result.aggregate).toMatchObject({
      reason: "progressing",
      state: "progressing",
    });
  });

  it("distinguishes a missing runtime row from a stale heartbeat", () => {
    const missing = deriveSourceHealthSignals(
      healthyInput({
        process: { heartbeatAt: null },
      }),
      NOW
    );
    const stale = deriveSourceHealthSignals(
      healthyInput({
        process: { heartbeatAt: new Date(NOW.getTime() - 6 * MINUTE) },
      }),
      NOW
    );

    expect(missing.process).toMatchObject({
      reason: "never_reported",
      state: "unknown",
    });
    expect(missing.aggregate).toMatchObject({
      reason: "process_telemetry_unknown",
      state: "unknown",
    });
    expect(stale.process).toMatchObject({
      reason: "heartbeat_stale",
      state: "stale",
    });
    expect(stale.aggregate).toMatchObject({
      reason: "worker_dead",
      state: "red",
    });
  });

  it("marks first progress overdue without fabricating observedAt", () => {
    const waiting = deriveSourceHealthSignals(
      healthyInput({
        progress: {
          active: true,
          activeStartedAt: new Date(NOW.getTime() - MINUTE),
          observedAt: null,
          phase: "persist",
          phaseStartedAt: new Date(NOW.getTime() - MINUTE),
        },
      }),
      NOW
    );
    const overdue = deriveSourceHealthSignals(
      healthyInput({
        progress: {
          active: true,
          activeStartedAt: new Date(NOW.getTime() - 20 * MINUTE),
          observedAt: null,
          phase: "persist",
          phaseStartedAt: new Date(NOW.getTime() - 20 * MINUTE),
        },
      }),
      NOW
    );

    expect(waiting.progress).toMatchObject({
      observedAt: null,
      reason: "progress_not_reported",
      state: "unknown",
      waitingAgeMs: MINUTE,
    });
    expect(overdue.progress).toMatchObject({
      observedAt: null,
      reason: "first_progress_overdue",
      state: "stale",
      waitingAgeMs: 20 * MINUTE,
    });
    expect(overdue.aggregate).toMatchObject({
      ageMs: 20 * MINUTE,
      reason: "first_progress_overdue",
      state: "red",
    });
  });

  it("uses the current curation phase start for first-progress deadlines", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        progress: {
          active: true,
          activeStartedAt: new Date(NOW.getTime() - 60 * MINUTE),
          observedAt: null,
          phase: "curation",
          phaseStartedAt: new Date(NOW.getTime() - MINUTE),
        },
      }),
      NOW
    );

    expect(result.progress).toMatchObject({
      reason: "progress_not_reported",
      state: "unknown",
      waitingAgeMs: MINUTE,
    });
  });

  it("keeps progress unknown when its configured budget is unavailable", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        progress: {
          active: true,
          activeStartedAt: new Date(NOW.getTime() - 60 * MINUTE),
          observedAt: new Date(NOW.getTime() - 60 * MINUTE),
          phase: "persist",
          phaseStartedAt: new Date(NOW.getTime() - 60 * MINUTE),
        },
        thresholds: {
          advisoryLockMaxAgeMs: 5 * MINUTE,
          curationBudgetMs: 30 * MINUTE,
          freshnessMaxAgeMs: 60 * MINUTE,
          heartbeatMaxAgeMs: 5 * MINUTE,
          runBudgetMs: null,
        },
      }),
      NOW
    );

    expect(result.progress).toMatchObject({
      reason: "progress_policy_unknown",
      state: "unknown",
    });
    expect(result.aggregate).toMatchObject({
      reason: "progress_policy_unknown",
      state: "unknown",
    });
  });

  it("keeps freshness unknown when its policy is unavailable", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        thresholds: {
          advisoryLockMaxAgeMs: 5 * MINUTE,
          curationBudgetMs: 30 * MINUTE,
          freshnessMaxAgeMs: null,
          heartbeatMaxAgeMs: 5 * MINUTE,
          runBudgetMs: 15 * MINUTE,
        },
      }),
      NOW
    );

    expect(result.freshness).toMatchObject({
      reason: "freshness_policy_unknown",
      state: "unknown",
    });
    expect(result.aggregate).toMatchObject({
      reason: "freshness_policy_unknown",
      state: "unknown",
    });
  });

  it("does not invent process or lock cutoffs when policies are unavailable", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        thresholds: {
          advisoryLockMaxAgeMs: null,
          curationBudgetMs: 30 * MINUTE,
          freshnessMaxAgeMs: 60 * MINUTE,
          heartbeatMaxAgeMs: null,
          runBudgetMs: 15 * MINUTE,
        },
      }),
      NOW
    );

    expect(result.process).toMatchObject({
      reason: "process_policy_unknown",
      state: "unknown",
    });
    expect(result.advisoryLock).toMatchObject({
      reason: "lock_policy_unknown",
      state: "unknown",
    });
    expect(result.aggregate).toMatchObject({
      reason: "process_policy_unknown",
      state: "unknown",
    });
  });

  it("does not call a database read failure a dead worker", () => {
    const result = deriveSourceHealthSignals(
      healthyInput({
        advisoryLock: {
          observation: "lost",
          observedAt: new Date(NOW.getTime() - 60 * MINUTE),
        },
        database: { available: false, observedAt: null },
        process: { heartbeatAt: new Date(NOW.getTime() - 60 * MINUTE) },
      }),
      NOW
    );

    expect(result.database).toMatchObject({
      reason: "database_unavailable",
      state: "unknown",
    });
    expect(result.process).toMatchObject({
      reason: "database_unavailable",
      state: "unknown",
    });
    expect(result.advisoryLock).toMatchObject({
      reason: "database_unavailable",
      state: "unknown",
    });
    expect(result.aggregate).toMatchObject({
      reason: "database_unknown",
      state: "unknown",
    });
  });

  it("never makes inactive or blocked sources green", () => {
    for (const sourceState of ["inactive", "blocked"] as const) {
      const result = deriveSourceHealthSignals(
        healthyInput({ sourceState }),
        NOW
      );

      expect(result.aggregate.state).toBe(sourceState);
      expect(result.process.state).toBe(sourceState);
      expect(result.progress.state).toBe(sourceState);
      expect(result.freshness.state).toBe(sourceState);
    }
  });

  it("keeps incomplete, backlogged, and parked outcomes distinct", () => {
    const currentRunValues = [
      ["incomplete", "current_run_incomplete"],
      ["backlogged", "current_run_backlogged"],
      ["parked", "current_run_parked"],
    ] as const;

    for (const [currentRun, reason] of currentRunValues) {
      const result = deriveSourceHealthSignals(
        healthyInput({
          freshness: {
            currentRun,
            lastFullySuccessfulAt: new Date(NOW.getTime() - MINUTE),
          },
        }),
        NOW
      );
      expect(result.freshness).toMatchObject({ reason, state: "stale" });
      expect(result.aggregate).toMatchObject({
        reason: "freshness_stale",
        state: "red",
      });
    }
  });
});
