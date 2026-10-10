import {
  BRON_HEALTH_TIME_ZONE,
  SCHEDULE_OVERDUE_GRACE_MS,
  deriveSourceHealthSignals,
  nextCronRun,
} from "@ji/application/observability";
import type {
  CurrentRunFreshness,
  ProgressPhase,
  SourceHealthSignalsInput,
  SourceHealthSourceState,
} from "@ji/application/observability";
import type {
  SourceHealthReader,
  SourceHealthRecord,
} from "@ji/application/registry";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { bron, bronHealth, pollerRuntime, scrapeRun } from "./schema";

const selectSourceHealth = (
  database: PostgresJsDatabase<typeof schema>,
  bronIds: readonly string[]
) =>
  database
    .select({
      active: bron.actief,
      activeRunId: bronHealth.activeRunId,
      advisoryLockMaxAgeMs: pollerRuntime.advisoryLockMaxAgeMs,
      bronId: bron.id,
      curationBudgetMs: pollerRuntime.curationBudgetMs,
      heartbeatAt: pollerRuntime.heartbeatAt,
      heartbeatMaxAgeMs: pollerRuntime.heartbeatMaxAgeMs,
      interval: bron.interval,
      lastFullySuccessfulAt: bronHealth.lastFullySuccessfulAt,
      lastLockCheckAt: pollerRuntime.lastLockCheckAt,
      outcome: bronHealth.lastCompletionOutcome,
      phase: bronHealth.progressPhase,
      phaseStartedAt: bronHealth.phaseStartedAt,
      progressAt: bronHealth.progressAt,
      runBudgetMs: pollerRuntime.runBudgetMs,
      runStartedAt: scrapeRun.gestart,
      runStatus: scrapeRun.status,
      runtimeStatus: pollerRuntime.status,
      runtimeUpdatedAt: pollerRuntime.updatedAt,
      status: bron.status,
      terms: bron.voorwaardenStatus,
    })
    .from(bron)
    .leftJoin(bronHealth, eq(bronHealth.bronId, bron.id))
    .leftJoin(scrapeRun, eq(scrapeRun.id, bronHealth.activeRunId))
    .leftJoin(pollerRuntime, eq(pollerRuntime.component, "poller"))
    .where(inArray(bron.id, [...bronIds]));

type SourceHealthRow = Awaited<ReturnType<typeof selectSourceHealth>>[number];

const sourceState = (row: SourceHealthRow): SourceHealthSourceState => {
  // Same readiness/terms predicate as shouldScheduleBronPoll; inactive sources
  // retain their explicit disabled state unless a policy explicitly blocks them.
  if (row.status === "blocked" || row.terms === "verboden") {
    return "blocked";
  }
  if (!row.active) {
    return "inactive";
  }
  return row.status === "ready" && row.terms === "toegestaan"
    ? "active"
    : "blocked";
};

const progressPhase = (phase: string | null): ProgressPhase | null =>
  phase === "fetch" || phase === "persist" || phase === "curation"
    ? phase
    : null;

const currentOutcome = (row: SourceHealthRow): CurrentRunFreshness => {
  if (row.runStatus === "failed" || row.runStatus === "cancelled") {
    return "incomplete";
  }
  if (row.outcome === "quarantined" || row.outcome === "parked") {
    return "parked";
  }
  if (row.outcome === "failed") {
    return "incomplete";
  }
  if (
    row.outcome === "complete" ||
    row.outcome === "incomplete" ||
    row.outcome === "backlogged"
  ) {
    return row.outcome;
  }
  return row.outcome === null ? "none" : "unknown";
};

const freshnessAllowance = (row: SourceHealthRow): number | null => {
  if (!row.lastFullySuccessfulAt) {
    return null;
  }
  const next = nextCronRun(
    row.interval,
    row.lastFullySuccessfulAt,
    BRON_HEALTH_TIME_ZONE
  );
  return next === null
    ? null
    : next.getTime() -
        row.lastFullySuccessfulAt.getTime() +
        SCHEDULE_OVERDUE_GRACE_MS;
};

const lockObservation = (
  status: string | null
): "held" | "lost" | "unknown" => {
  if (status === "running") {
    return "held";
  }
  if (status === "lock_lost" || status === "stopped") {
    return "lost";
  }
  return "unknown";
};

const mapSourceHealth = (
  row: SourceHealthRow,
  now: Date
): SourceHealthRecord => {
  const phase = progressPhase(row.phase);
  const active =
    row.activeRunId !== null &&
    (row.runStatus === "running" ||
      (row.runStatus === "succeeded" && phase === "curation"));
  return {
    bronId: row.bronId,
    signals: deriveSourceHealthSignals(
      {
        advisoryLock: {
          observation: lockObservation(row.runtimeStatus),
          observedAt:
            row.runtimeStatus === "stopped"
              ? row.runtimeUpdatedAt
              : row.lastLockCheckAt,
        },
        database: { available: true, observedAt: now },
        freshness: {
          currentRun: currentOutcome(row),
          lastFullySuccessfulAt: row.lastFullySuccessfulAt,
        },
        process: { heartbeatAt: row.heartbeatAt },
        progress: {
          active,
          activeStartedAt: row.runStartedAt,
          observedAt: row.progressAt,
          phase,
          phaseStartedAt: row.phaseStartedAt,
        },
        sourceState: sourceState(row),
        thresholds: {
          advisoryLockMaxAgeMs: row.advisoryLockMaxAgeMs,
          curationBudgetMs: row.curationBudgetMs,
          freshnessMaxAgeMs: freshnessAllowance(row),
          heartbeatMaxAgeMs: row.heartbeatMaxAgeMs,
          runBudgetMs: row.runBudgetMs,
        },
      },
      now
    ),
  };
};

const unavailableInput: SourceHealthSignalsInput = {
  advisoryLock: { observation: "unknown", observedAt: null },
  database: { available: false, observedAt: null },
  freshness: { currentRun: "unknown", lastFullySuccessfulAt: null },
  process: { heartbeatAt: null },
  progress: {
    active: false,
    activeStartedAt: null,
    observedAt: null,
    phase: null,
    phaseStartedAt: null,
  },
  sourceState: "active",
  thresholds: {
    advisoryLockMaxAgeMs: null,
    curationBudgetMs: null,
    freshnessMaxAgeMs: null,
    heartbeatMaxAgeMs: null,
    runBudgetMs: null,
  },
};

/** One joined read for every requested source, including those without history. */
export class PostgresSourceHealthReader implements SourceHealthReader {
  private readonly database: PostgresJsDatabase<typeof schema>;
  private readonly now: () => Date;

  constructor(
    database: PostgresJsDatabase<typeof schema>,
    now: () => Date = () => new Date()
  ) {
    this.database = database;
    this.now = now;
  }

  async getByBronId(bronId: string): Promise<SourceHealthRecord | null> {
    const rows = await this.listByBronIds([bronId]);
    return rows[0] ?? null;
  }

  async listByBronIds(
    bronIds: readonly string[]
  ): Promise<readonly SourceHealthRecord[]> {
    const ids = [...new Set(bronIds)];
    if (ids.length === 0) {
      return [];
    }
    let rows: SourceHealthRow[];
    try {
      rows = await selectSourceHealth(this.database, ids);
    } catch {
      // A failed read proves only unavailable telemetry, never a dead worker.
      return ids.map((bronId) => ({
        bronId,
        signals: deriveSourceHealthSignals(unavailableInput, this.now()),
      }));
    }
    const now = this.now();
    return rows.map((row) => mapSourceHealth(row, now));
  }
}
