import { Schema } from "effect";

import type {
  AdvisoryLockSignalReason,
  DatabaseSignalReason,
  FreshnessSignalReason,
  ProcessSignalReason,
  ProgressSignalReason,
  SourceHealthAggregateReason,
  SourceHealthAggregateState,
  SourceHealthSignalState,
  SourceHealthSignals,
} from "../observability";
import { FiniteNumber, toCapabilitySchema } from "./schema-helpers";

export interface SourceHealthRecord {
  readonly bronId: string;
  readonly signals: SourceHealthSignals;
}

/**
 * Application read boundary for source telemetry. Implementations should
 * satisfy `listByBronIds` with one bulk read; handlers must not loop over
 * `getByBronId` for dashboard rows.
 */
export interface SourceHealthReader {
  readonly getByBronId: (bronId: string) => Promise<SourceHealthRecord | null>;
  readonly listByBronIds: (
    bronIds: readonly string[]
  ) => Promise<readonly SourceHealthRecord[]>;
}

export interface SourceHealthSignalView<Reason extends string> {
  readonly ageMs: number | null;
  readonly observedAt: string | null;
  readonly reason: Reason;
  readonly state: SourceHealthSignalState;
}

export type ProcessHealthSignalView =
  SourceHealthSignalView<ProcessSignalReason>;
export type DatabaseHealthSignalView =
  SourceHealthSignalView<DatabaseSignalReason>;
export type AdvisoryLockHealthSignalView =
  SourceHealthSignalView<AdvisoryLockSignalReason>;
export type ProgressHealthSignalView =
  SourceHealthSignalView<ProgressSignalReason> & {
    readonly waitingAgeMs: number | null;
  };
export type FreshnessHealthSignalView =
  SourceHealthSignalView<FreshnessSignalReason>;

export interface SourceHealthAggregateView {
  readonly ageMs: number | null;
  readonly reason: SourceHealthAggregateReason;
  readonly state: SourceHealthAggregateState;
}

export interface SourceHealthSignalsView {
  readonly advisoryLock: AdvisoryLockHealthSignalView;
  readonly aggregate: SourceHealthAggregateView;
  readonly database: DatabaseHealthSignalView;
  readonly freshness: FreshnessHealthSignalView;
  readonly process: ProcessHealthSignalView;
  readonly progress: ProgressHealthSignalView;
}

const signalState = Schema.Literals([
  "blocked",
  "failed",
  "inactive",
  "ok",
  "progressing",
  "stale",
  "unknown",
] as const);

const aggregateState = Schema.Literals([
  "blocked",
  "green",
  "inactive",
  "progressing",
  "red",
  "unknown",
] as const);

const observedAt = Schema.NullOr(Schema.String);
const ageMs = Schema.NullOr(FiniteNumber);

export const sourceHealthSignalsViewSchema = Schema.Struct({
  advisoryLock: Schema.Struct({
    ageMs,
    observedAt,
    reason: Schema.Literals([
      "database_unavailable",
      "lock_held",
      "lock_lost",
      "lock_not_reported",
      "lock_observation_stale",
      "lock_policy_unknown",
      "source_blocked",
      "source_inactive",
      "waiting_for_advisory_lock",
    ] as const),
    state: signalState,
  }),
  aggregate: Schema.Struct({
    ageMs,
    reason: Schema.Literals([
      "advisory_lock_not_owned",
      "advisory_lock_unknown",
      "database_unknown",
      "first_progress_overdue",
      "progress_policy_unknown",
      "freshness_stale",
      "freshness_unknown",
      "freshness_policy_unknown",
      "healthy",
      "lock_policy_unknown",
      "process_policy_unknown",
      "process_telemetry_unknown",
      "progress_stalled",
      "progress_unknown",
      "progressing",
      "source_blocked",
      "source_inactive",
      "worker_dead",
    ] as const),
    state: aggregateState,
  }),
  database: Schema.Struct({
    ageMs,
    observedAt,
    reason: Schema.Literals([
      "database_available",
      "database_unavailable",
      "probe_not_observed",
    ] as const),
    state: signalState,
  }),
  freshness: Schema.Struct({
    ageMs,
    observedAt,
    reason: Schema.Literals([
      "current_run_backlogged",
      "current_run_incomplete",
      "current_run_parked",
      "current_run_unknown",
      "freshness_policy_unknown",
      "last_full_success_fresh",
      "last_full_success_stale",
      "never_succeeded",
      "source_blocked",
      "source_inactive",
    ] as const),
    state: signalState,
  }),
  process: Schema.Struct({
    ageMs,
    observedAt,
    reason: Schema.Literals([
      "database_unavailable",
      "heartbeat_fresh",
      "heartbeat_stale",
      "never_reported",
      "process_policy_unknown",
      "source_blocked",
      "source_inactive",
    ] as const),
    state: signalState,
  }),
  progress: Schema.Struct({
    ageMs,
    observedAt,
    reason: Schema.Literals([
      "first_progress_overdue",
      "no_active_run",
      "progress_not_reported",
      "progress_policy_unknown",
      "progress_stalled",
      "progressing",
      "source_blocked",
      "source_inactive",
    ] as const),
    state: signalState,
    waitingAgeMs: ageMs,
  }),
});

export const sourceHealthSignalsViewCapabilitySchema = toCapabilitySchema(
  sourceHealthSignalsViewSchema
);

const serializeSignal = <Reason extends string>(signal: {
  readonly ageMs: number | null;
  readonly observedAt: Date | null;
  readonly reason: Reason;
  readonly state: SourceHealthSignalState;
}): SourceHealthSignalView<Reason> => ({
  ageMs: signal.ageMs,
  observedAt: signal.observedAt?.toISOString() ?? null,
  reason: signal.reason,
  state: signal.state,
});

/** Serialize runtime Dates at the application/API boundary. */
export const serializeSourceHealthSignals = (
  signals: SourceHealthSignals
): SourceHealthSignalsView => ({
  advisoryLock: serializeSignal(signals.advisoryLock),
  aggregate: {
    ageMs: signals.aggregate.ageMs,
    reason: signals.aggregate.reason,
    state: signals.aggregate.state,
  },
  database: serializeSignal(signals.database),
  freshness: serializeSignal(signals.freshness),
  process: serializeSignal(signals.process),
  progress: {
    ...serializeSignal(signals.progress),
    waitingAgeMs: signals.progress.waitingAgeMs,
  },
});
