/**
 * Pure source telemetry derivation for the H1 health contract.
 *
 * This module deliberately does not read the database or the clock. Runtime
 * adapters supply observations and existing run/curation budgets, while the
 * returned signals retain their own reason and age. It is separate from the
 * existing bron-health rules so existing dashboard callers keep their current
 * behaviour until the runtime and API layers are wired to this contract.
 */

export type SourceHealthSourceState = "active" | "inactive" | "blocked";

export type SourceHealthSignalState =
  | "ok"
  | "progressing"
  | "stale"
  | "failed"
  | "unknown"
  | "inactive"
  | "blocked";

export type SourceHealthAggregateState =
  | "green"
  | "progressing"
  | "red"
  | "inactive"
  | "blocked"
  | "unknown";

export type ProcessSignalReason =
  | "heartbeat_fresh"
  | "heartbeat_stale"
  | "process_policy_unknown"
  | "never_reported"
  | "database_unavailable"
  | "source_inactive"
  | "source_blocked";

export type DatabaseSignalReason =
  | "database_available"
  | "database_unavailable"
  | "probe_not_observed";

export type AdvisoryLockSignalReason =
  | "lock_held"
  | "waiting_for_advisory_lock"
  | "lock_lost"
  | "lock_not_reported"
  | "lock_observation_stale"
  | "lock_policy_unknown"
  | "database_unavailable"
  | "source_inactive"
  | "source_blocked";

export type ProgressSignalReason =
  | "no_active_run"
  | "progressing"
  | "progress_stalled"
  | "first_progress_overdue"
  | "progress_policy_unknown"
  | "progress_not_reported"
  | "source_inactive"
  | "source_blocked";

export type FreshnessSignalReason =
  | "last_full_success_fresh"
  | "last_full_success_stale"
  | "never_succeeded"
  | "current_run_incomplete"
  | "current_run_backlogged"
  | "current_run_parked"
  | "current_run_unknown"
  | "freshness_policy_unknown"
  | "source_inactive"
  | "source_blocked";

export type SourceHealthAggregateReason =
  | "source_inactive"
  | "source_blocked"
  | "database_unknown"
  | "worker_dead"
  | "process_policy_unknown"
  | "process_telemetry_unknown"
  | "advisory_lock_not_owned"
  | "advisory_lock_unknown"
  | "lock_policy_unknown"
  | "progress_stalled"
  | "first_progress_overdue"
  | "progress_policy_unknown"
  | "progress_unknown"
  | "progressing"
  | "freshness_stale"
  | "freshness_unknown"
  | "freshness_policy_unknown"
  | "healthy";

export interface SourceHealthSignal<Reason extends string> {
  readonly state: SourceHealthSignalState;
  readonly reason: Reason;
  /** The source observation time, not the time this contract was read. */
  readonly observedAt: Date | null;
  /** Age at the injected read time; null when no observation exists. */
  readonly ageMs: number | null;
}

export type ProcessHealthSignal = SourceHealthSignal<ProcessSignalReason>;
export type DatabaseHealthSignal = SourceHealthSignal<DatabaseSignalReason>;
export type AdvisoryLockHealthSignal =
  SourceHealthSignal<AdvisoryLockSignalReason>;
export interface ProgressHealthSignal extends SourceHealthSignal<ProgressSignalReason> {
  /** Elapsed time since the active run/phase began when no milestone exists. */
  readonly waitingAgeMs: number | null;
}
export type FreshnessHealthSignal = SourceHealthSignal<FreshnessSignalReason>;

export type AdvisoryLockObservation = "held" | "waiting" | "lost" | "unknown";

export type ProgressPhase = "fetch" | "persist" | "curation";

export type CurrentRunFreshness =
  | "none"
  | "complete"
  | "incomplete"
  | "backlogged"
  | "parked"
  | "unknown";

export interface SourceHealthSignalThresholds {
  /** Existing heartbeat allowance. */
  readonly heartbeatMaxAgeMs: number | null;
  /** Existing liveness observation allowance for the advisory lock. */
  readonly advisoryLockMaxAgeMs: number | null;
  /** Existing connector run budget. */
  readonly runBudgetMs: number | null;
  /** Existing curation/drain budget. */
  readonly curationBudgetMs: number | null;
  /** Existing freshness policy supplied by the caller. */
  readonly freshnessMaxAgeMs: number | null;
}

export interface SourceHealthSignalsInput {
  readonly sourceState: SourceHealthSourceState;
  readonly database: {
    readonly available: boolean;
    readonly observedAt: Date | null;
  };
  readonly process: {
    /** The worker heartbeat timestamp, if the runtime row reported one. */
    readonly heartbeatAt: Date | null;
  };
  readonly advisoryLock: {
    readonly observation: AdvisoryLockObservation;
    readonly observedAt: Date | null;
  };
  readonly progress: {
    readonly active: boolean;
    readonly phase: ProgressPhase | null;
    /** Start of the active run, before its first committed milestone. */
    readonly activeStartedAt: Date | null;
    /** Start of the current phase; takes precedence over activeStartedAt. */
    readonly phaseStartedAt: Date | null;
    /** Last committed fetch, persist, or curation milestone. */
    readonly observedAt: Date | null;
  };
  readonly freshness: {
    readonly lastFullySuccessfulAt: Date | null;
    /** Current run result, including incomplete/backlogged/parked outcomes. */
    readonly currentRun: CurrentRunFreshness;
  };
  readonly thresholds: SourceHealthSignalThresholds;
}

export interface SourceHealthAggregate {
  readonly state: SourceHealthAggregateState;
  readonly reason: SourceHealthAggregateReason;
  readonly ageMs: number | null;
}

export interface SourceHealthSignals {
  readonly process: ProcessHealthSignal;
  readonly database: DatabaseHealthSignal;
  readonly advisoryLock: AdvisoryLockHealthSignal;
  readonly progress: ProgressHealthSignal;
  readonly freshness: FreshnessHealthSignal;
  readonly aggregate: SourceHealthAggregate;
}

const ageAt = (observedAt: Date | null, now: Date): number | null =>
  observedAt === null
    ? null
    : Math.max(0, now.getTime() - observedAt.getTime());

const signal = <Reason extends string>(
  state: SourceHealthSignalState,
  reason: Reason,
  observedAt: Date | null,
  now: Date
): SourceHealthSignal<Reason> => ({
  ageMs: ageAt(observedAt, now),
  observedAt,
  reason,
  state,
});

const progressSignal = (
  state: SourceHealthSignalState,
  reason: ProgressSignalReason,
  observedAt: Date | null,
  now: Date,
  waitingAgeMs: number | null
): ProgressHealthSignal => ({
  ...signal(state, reason, observedAt, now),
  waitingAgeMs,
});

const inactiveSignal = <Reason extends string>(
  sourceState: SourceHealthSourceState,
  reason: Reason,
  now: Date
): SourceHealthSignal<Reason> =>
  signal(
    sourceState === "inactive" ? "inactive" : "blocked",
    reason,
    null,
    now
  );

const deriveDatabase = (
  input: SourceHealthSignalsInput,
  now: Date
): DatabaseHealthSignal => {
  if (!input.database.available) {
    return signal(
      "unknown",
      "database_unavailable",
      input.database.observedAt,
      now
    );
  }
  if (input.database.observedAt === null) {
    return signal("unknown", "probe_not_observed", null, now);
  }
  return signal("ok", "database_available", input.database.observedAt, now);
};

const deriveProcess = (
  input: SourceHealthSignalsInput,
  database: DatabaseHealthSignal,
  now: Date
): ProcessHealthSignal => {
  if (input.sourceState !== "active") {
    return inactiveSignal(
      input.sourceState,
      input.sourceState === "inactive" ? "source_inactive" : "source_blocked",
      now
    );
  }
  if (database.state === "unknown") {
    return signal("unknown", "database_unavailable", null, now);
  }
  const { heartbeatAt } = input.process;
  if (heartbeatAt === null) {
    return signal("unknown", "never_reported", null, now);
  }
  if (input.thresholds.heartbeatMaxAgeMs === null) {
    return signal("unknown", "process_policy_unknown", heartbeatAt, now);
  }
  const age = ageAt(heartbeatAt, now);
  return signal(
    age !== null && age > input.thresholds.heartbeatMaxAgeMs ? "stale" : "ok",
    age !== null && age > input.thresholds.heartbeatMaxAgeMs
      ? "heartbeat_stale"
      : "heartbeat_fresh",
    heartbeatAt,
    now
  );
};

const deriveAdvisoryLock = (
  input: SourceHealthSignalsInput,
  database: DatabaseHealthSignal,
  now: Date
): AdvisoryLockHealthSignal => {
  if (input.sourceState !== "active") {
    return inactiveSignal(
      input.sourceState,
      input.sourceState === "inactive" ? "source_inactive" : "source_blocked",
      now
    );
  }
  if (database.state === "unknown") {
    return signal("unknown", "database_unavailable", null, now);
  }
  const { observedAt } = input.advisoryLock;
  switch (input.advisoryLock.observation) {
    case "held": {
      if (observedAt === null) {
        return signal("unknown", "lock_not_reported", null, now);
      }
      if (input.thresholds.advisoryLockMaxAgeMs === null) {
        return signal("unknown", "lock_policy_unknown", observedAt, now);
      }
      const age = ageAt(observedAt, now);
      return signal(
        age !== null && age > input.thresholds.advisoryLockMaxAgeMs
          ? "stale"
          : "ok",
        age !== null && age > input.thresholds.advisoryLockMaxAgeMs
          ? "lock_observation_stale"
          : "lock_held",
        observedAt,
        now
      );
    }
    case "waiting": {
      return signal("failed", "waiting_for_advisory_lock", observedAt, now);
    }
    case "lost": {
      return signal("failed", "lock_lost", observedAt, now);
    }
    case "unknown": {
      return signal("unknown", "lock_not_reported", observedAt, now);
    }
    default: {
      return signal("unknown", "lock_not_reported", observedAt, now);
    }
  }
};

const deriveProgress = (
  input: SourceHealthSignalsInput,
  now: Date
): ProgressHealthSignal => {
  if (input.sourceState !== "active") {
    return {
      ...inactiveSignal(
        input.sourceState,
        input.sourceState === "inactive" ? "source_inactive" : "source_blocked",
        now
      ),
      waitingAgeMs: null,
    };
  }
  if (!input.progress.active) {
    return progressSignal("ok", "no_active_run", null, now, null);
  }
  const { activeStartedAt, observedAt, phase, phaseStartedAt } = input.progress;
  if (observedAt === null) {
    const waitingSince = phaseStartedAt ?? activeStartedAt;
    const waitingAgeMs = ageAt(waitingSince, now);
    const maxAgeMs =
      phase === "curation"
        ? input.thresholds.curationBudgetMs
        : input.thresholds.runBudgetMs;
    if (maxAgeMs === null) {
      return progressSignal(
        "unknown",
        "progress_policy_unknown",
        null,
        now,
        waitingAgeMs
      );
    }
    const overdue = waitingAgeMs !== null && waitingAgeMs > maxAgeMs;
    return progressSignal(
      overdue ? "stale" : "unknown",
      overdue ? "first_progress_overdue" : "progress_not_reported",
      null,
      now,
      waitingAgeMs
    );
  }
  const age = ageAt(observedAt, now);
  const maxAgeMs =
    phase === "curation"
      ? input.thresholds.curationBudgetMs
      : input.thresholds.runBudgetMs;
  if (maxAgeMs === null) {
    return progressSignal(
      "unknown",
      "progress_policy_unknown",
      observedAt,
      now,
      null
    );
  }
  return progressSignal(
    age !== null && age > maxAgeMs ? "stale" : "progressing",
    age !== null && age > maxAgeMs ? "progress_stalled" : "progressing",
    observedAt,
    now,
    null
  );
};

const deriveFreshness = (
  input: SourceHealthSignalsInput,
  now: Date
): FreshnessHealthSignal => {
  if (input.sourceState !== "active") {
    return inactiveSignal(
      input.sourceState,
      input.sourceState === "inactive" ? "source_inactive" : "source_blocked",
      now
    );
  }
  const observedAt = input.freshness.lastFullySuccessfulAt;
  const { currentRun } = input.freshness;
  let currentRunReason: FreshnessSignalReason | null = null;
  if (currentRun === "incomplete") {
    currentRunReason = "current_run_incomplete";
  } else if (currentRun === "backlogged") {
    currentRunReason = "current_run_backlogged";
  } else if (currentRun === "parked") {
    currentRunReason = "current_run_parked";
  } else if (currentRun === "unknown") {
    currentRunReason = "current_run_unknown";
  }

  if (currentRunReason !== null) {
    return signal(
      currentRun === "unknown" ? "unknown" : "stale",
      currentRunReason,
      observedAt,
      now
    );
  }
  if (observedAt === null) {
    return signal("unknown", "never_succeeded", null, now);
  }
  if (input.thresholds.freshnessMaxAgeMs === null) {
    return signal("unknown", "freshness_policy_unknown", observedAt, now);
  }
  const age = ageAt(observedAt, now);
  return signal(
    age !== null && age > input.thresholds.freshnessMaxAgeMs ? "stale" : "ok",
    age !== null && age > input.thresholds.freshnessMaxAgeMs
      ? "last_full_success_stale"
      : "last_full_success_fresh",
    observedAt,
    now
  );
};

const progressAggregateReason = (
  reason: ProgressSignalReason
):
  | "first_progress_overdue"
  | "progress_policy_unknown"
  | "progress_stalled" => {
  if (reason === "first_progress_overdue") {
    return "first_progress_overdue";
  }
  if (reason === "progress_policy_unknown") {
    return "progress_policy_unknown";
  }
  return "progress_stalled";
};

const deriveAggregate = (
  input: SourceHealthSignalsInput,
  signals: Omit<SourceHealthSignals, "aggregate">
): SourceHealthAggregate => {
  if (input.sourceState === "inactive") {
    return { ageMs: null, reason: "source_inactive", state: "inactive" };
  }
  if (input.sourceState === "blocked") {
    return { ageMs: null, reason: "source_blocked", state: "blocked" };
  }
  if (signals.database.state === "unknown") {
    return {
      ageMs: signals.database.ageMs,
      reason: "database_unknown",
      state: "unknown",
    };
  }
  // Process liveness has precedence over progress. A stale heartbeat is a
  // dead-worker signal even if a row claims to have recent progress.
  if (signals.process.state === "stale") {
    return {
      ageMs: signals.process.ageMs,
      reason: "worker_dead",
      state: "red",
    };
  }
  if (signals.process.state === "unknown") {
    return {
      ageMs: signals.process.ageMs,
      reason:
        signals.process.reason === "process_policy_unknown"
          ? "process_policy_unknown"
          : "process_telemetry_unknown",
      state: "unknown",
    };
  }
  if (
    signals.advisoryLock.state === "failed" ||
    signals.advisoryLock.state === "stale"
  ) {
    return {
      ageMs: signals.advisoryLock.ageMs,
      reason: "advisory_lock_not_owned",
      state: "red",
    };
  }
  if (signals.advisoryLock.state === "unknown") {
    return {
      ageMs: signals.advisoryLock.ageMs,
      reason:
        signals.advisoryLock.reason === "lock_policy_unknown"
          ? "lock_policy_unknown"
          : "advisory_lock_unknown",
      state: "unknown",
    };
  }
  if (signals.progress.state === "stale") {
    return {
      ageMs: signals.progress.ageMs ?? signals.progress.waitingAgeMs,
      reason: progressAggregateReason(signals.progress.reason),
      state: "red",
    };
  }
  if (signals.progress.state === "unknown") {
    return {
      ageMs: signals.progress.ageMs,
      reason:
        signals.progress.reason === "progress_policy_unknown"
          ? "progress_policy_unknown"
          : "progress_unknown",
      state: "unknown",
    };
  }
  // An active, recent milestone keeps a long run visibly progressing instead
  // of turning an old last-success timestamp into a false unhealthy result.
  if (signals.progress.state === "progressing") {
    return {
      ageMs: signals.progress.ageMs,
      reason: "progressing",
      state: "progressing",
    };
  }
  if (signals.freshness.state === "stale") {
    return {
      ageMs: signals.freshness.ageMs,
      reason: "freshness_stale",
      state: "red",
    };
  }
  if (signals.freshness.state === "unknown") {
    return {
      ageMs: signals.freshness.ageMs,
      reason:
        signals.freshness.reason === "freshness_policy_unknown"
          ? "freshness_policy_unknown"
          : "freshness_unknown",
      state: "unknown",
    };
  }
  return { ageMs: null, reason: "healthy", state: "green" };
};

/** Derive independent source signals without I/O or an implicit clock. */
export const deriveSourceHealthSignals = (
  input: SourceHealthSignalsInput,
  now: Date
): SourceHealthSignals => {
  const database = deriveDatabase(input, now);
  const independent = {
    advisoryLock: deriveAdvisoryLock(input, database, now),
    database,
    freshness: deriveFreshness(input, now),
    process: deriveProcess(input, database, now),
    progress: deriveProgress(input, now),
  };
  return {
    ...independent,
    aggregate: deriveAggregate(input, independent),
  };
};
