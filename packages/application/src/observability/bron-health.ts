/**
 * Pure health rules for the brondashboard (RJC-408 / D2).
 *
 * Adapted from Motian `derivePlatformHealth`, with two signals it lacked:
 * `scheduler_stale`, which separates "the scheduler is dead" from "this source
 * is dead", and `zero_activity`, which says a source is alive but has nothing
 * new — informational, never an alarm.
 *
 * No I/O, no clock: `now` is a parameter so the same inputs always derive the
 * same status.
 */

import {
  BRON_HEALTH_TIME_ZONE,
  CIRCUIT_STATUS_CLOSED,
  RECENT_FAILURES_CRITICAL_THRESHOLD,
  SCHEDULE_OVERDUE_GRACE_MS,
  SCHEDULER_STALE_INTERVAL_MULTIPLIER,
  ZERO_ACTIVITY_RUN_COUNT,
} from "./bron-health-thresholds";
import { nextCronRun, parseCronExpression } from "./cron";

export type BronHealthStatus =
  | "gezond"
  | "inactief"
  | "kritiek"
  | "waarschuwing";

export type BronHealthLevel = "critical" | "info" | "warning";

export type BronHealthSignalCode =
  | "circuit_open"
  | "inactive"
  | "latest_error"
  | "never_run"
  | "recent_failures"
  | "schedule_overdue"
  | "scheduler_stale"
  | "silence_open"
  | "zero_activity";

export interface BronHealthSignal {
  readonly code: BronHealthSignalCode;
  /** Operator-facing specifics, e.g. `connector/FETCH_FAILED`. */
  readonly detail: string | null;
  readonly level: BronHealthLevel;
}

/** Trailing run activity, newest first, used only by `zero_activity`. */
export interface BronRunActivity {
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly status: string;
}

export interface BronHealthInput {
  readonly actief: boolean;
  readonly bronId: string;
  /** Failed runs inside `RECENT_FAILURES_WINDOW_MS`. */
  readonly failedRuns24h: number;
  /** 5-field cron from `curated.bron.interval`. */
  readonly interval: string;
  readonly lastFailureClass: string | null;
  readonly lastFailureCode: string | null;
  readonly lastRunAt: Date | null;
  readonly lastRunCircuitStatus: string | null;
  readonly lastRunStatus: string | null;
  readonly naam: string;
  /** Newest first; only the first `ZERO_ACTIVITY_RUN_COUNT` are read. */
  readonly recentRuns: readonly BronRunActivity[];
  readonly silenceAlertOpen: boolean;
}

export interface BronHealthResult {
  readonly bronId: string;
  readonly isOverdue: boolean;
  readonly naam: string;
  readonly nextRunAt: Date | null;
  readonly signals: readonly BronHealthSignal[];
  readonly status: BronHealthStatus;
}

export interface DeriveBronHealthOptions {
  /**
   * Computed once across every source and propagated here, because a stale
   * scheduler is a property of the deployment, not of any one source.
   */
  readonly schedulerStale?: boolean;
  readonly timeZone?: string;
}

const signal = (
  code: BronHealthSignalCode,
  level: BronHealthLevel,
  detail: string | null = null
): BronHealthSignal => ({ code, detail, level });

/**
 * Next scheduled run, or null when the interval is not a usable cron.
 *
 * Measured from the last run when there is one, so a source that ran late is
 * not immediately late again.
 */
export const deriveNextRunAt = (
  input: Pick<BronHealthInput, "interval" | "lastRunAt">,
  now: Date,
  timeZone: string = BRON_HEALTH_TIME_ZONE
): Date | null => {
  if (parseCronExpression(input.interval) === null) {
    return null;
  }
  const anchor =
    input.lastRunAt !== null && input.lastRunAt.getTime() < now.getTime()
      ? input.lastRunAt
      : now;
  return nextCronRun(input.interval, anchor, timeZone);
};

const isZeroActivity = (runs: readonly BronRunActivity[]): boolean => {
  const window = runs.slice(0, ZERO_ACTIVITY_RUN_COUNT);
  if (window.length < ZERO_ACTIVITY_RUN_COUNT) {
    return false;
  }
  return window.every(
    (run) =>
      run.status === "succeeded" &&
      run.nieuw === 0 &&
      run.gewijzigd === 0 &&
      run.ongewijzigd > 0
  );
};

const failureDetail = (input: BronHealthInput): string | null => {
  if (input.lastFailureCode === null) {
    return null;
  }
  return input.lastFailureClass === null
    ? input.lastFailureCode
    : `${input.lastFailureClass}/${input.lastFailureCode}`;
};

const statusFor = (signals: readonly BronHealthSignal[]): BronHealthStatus => {
  if (signals.some((entry) => entry.level === "critical")) {
    return "kritiek";
  }
  if (signals.some((entry) => entry.level === "warning")) {
    return "waarschuwing";
  }
  return "gezond";
};

/** Health of one source. Pure; `now` is injected. */
export const deriveBronHealth = (
  input: BronHealthInput,
  now: Date,
  options: DeriveBronHealthOptions = {}
): BronHealthResult => {
  const timeZone = options.timeZone ?? BRON_HEALTH_TIME_ZONE;

  // An inactive source is not unhealthy, it is switched off. Reporting its
  // stale schedule as a failure is noise an operator has to learn to ignore.
  if (!input.actief) {
    return {
      bronId: input.bronId,
      isOverdue: false,
      naam: input.naam,
      nextRunAt: null,
      signals: [signal("inactive", "info")],
      status: "inactief",
    };
  }

  const nextRunAt = deriveNextRunAt(input, now, timeZone);
  const circuitOpen =
    input.lastRunCircuitStatus !== null &&
    input.lastRunCircuitStatus !== CIRCUIT_STATUS_CLOSED;
  const isOverdue =
    nextRunAt !== null &&
    nextRunAt.getTime() + SCHEDULE_OVERDUE_GRACE_MS <= now.getTime();

  const signals: BronHealthSignal[] = [];

  if (input.lastRunAt === null) {
    signals.push(signal("never_run", "warning"));
  }

  if (circuitOpen) {
    signals.push(
      signal("circuit_open", "critical", input.lastRunCircuitStatus)
    );
  }

  if (options.schedulerStale === true) {
    signals.push(signal("scheduler_stale", "critical"));
  }

  if (isOverdue) {
    // An overdue schedule on top of an open circuit is the source failing
    // repeatedly, not the scheduler drifting.
    signals.push(
      signal("schedule_overdue", circuitOpen ? "critical" : "warning")
    );
  }

  if (input.failedRuns24h > 0) {
    signals.push(
      signal(
        "recent_failures",
        input.failedRuns24h >= RECENT_FAILURES_CRITICAL_THRESHOLD
          ? "critical"
          : "warning",
        `${input.failedRuns24h}`
      )
    );
  }

  if (input.lastFailureCode !== null) {
    signals.push(
      signal(
        "latest_error",
        input.lastRunStatus === "failed" ? "critical" : "warning",
        failureDetail(input)
      )
    );
  }

  if (input.silenceAlertOpen) {
    signals.push(signal("silence_open", "warning"));
  }

  if (isZeroActivity(input.recentRuns)) {
    // Alive, just nothing new upstream. Informational on purpose: treating a
    // quiet source as broken is what taught operators to ignore the dashboard.
    signals.push(signal("zero_activity", "info"));
  }

  return {
    bronId: input.bronId,
    isOverdue,
    naam: input.naam,
    nextRunAt,
    signals,
    status: statusFor(signals),
  };
};

export interface BronHealthOverviewInput {
  readonly bronnen: readonly BronHealthInput[];
  /** Newest `poll` run across every source, regardless of outcome. */
  readonly lastPollRunAt: Date | null;
}

export interface BronHealthOverview {
  readonly bronnen: readonly BronHealthResult[];
  readonly schedulerStale: boolean;
}

/**
 * Smallest gap between consecutive fires across every active source.
 *
 * Derived from the cron rather than assumed, so a register of hourly sources
 * is not judged against a 15-minute expectation.
 */
export const smallestIntervalMs = (
  bronnen: readonly BronHealthInput[],
  now: Date,
  timeZone: string = BRON_HEALTH_TIME_ZONE
): number | null => {
  let smallest: number | null = null;

  for (const bron of bronnen) {
    if (!bron.actief) {
      continue;
    }
    const first = nextCronRun(bron.interval, now, timeZone);
    if (first === null) {
      continue;
    }
    const second = nextCronRun(bron.interval, first, timeZone);
    if (second === null) {
      continue;
    }
    const gap = second.getTime() - first.getTime();
    if (smallest === null || gap < smallest) {
      smallest = gap;
    }
  }

  return smallest;
};

/**
 * Whether the scheduler itself has stopped firing.
 *
 * Motian showed every scraper "achterstallig" on 25-08-2026 without saying
 * why. One source silent is that source's problem; every source silent past
 * two of the tightest interval is the scheduler, and that is a different
 * page to open.
 */
export const isSchedulerStale = (
  input: BronHealthOverviewInput,
  now: Date,
  timeZone: string = BRON_HEALTH_TIME_ZONE
): boolean => {
  const activeBronnen = input.bronnen.filter((bron) => bron.actief);
  if (activeBronnen.length === 0) {
    return false;
  }

  const smallest = smallestIntervalMs(activeBronnen, now, timeZone);
  if (smallest === null) {
    return false;
  }

  const budget = smallest * SCHEDULER_STALE_INTERVAL_MULTIPLIER;
  if (input.lastPollRunAt === null) {
    // Nothing has ever polled. That is only the scheduler's fault once at
    // least one source has been active long enough to have been polled.
    return activeBronnen.some((bron) => bron.lastRunAt === null);
  }
  return now.getTime() - input.lastPollRunAt.getTime() > budget;
};

/**
 * Health for every source, with `scheduler_stale` decided once at the top and
 * propagated to each active source.
 */
export const deriveBronHealthOverview = (
  input: BronHealthOverviewInput,
  now: Date,
  options: Omit<DeriveBronHealthOptions, "schedulerStale"> = {}
): BronHealthOverview => {
  const timeZone = options.timeZone ?? BRON_HEALTH_TIME_ZONE;
  const schedulerStale = isSchedulerStale(input, now, timeZone);

  return {
    bronnen: input.bronnen.map((bron) =>
      deriveBronHealth(bron, now, { schedulerStale, timeZone })
    ),
    schedulerStale,
  };
};
