import { and, eq, exists, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";
import { Context, Layer } from "effect";
import type { Effect } from "effect";

import { fromStorePromise } from "./effect";
import type { DbStoreFault } from "./effect";
import type * as schema from "./schema";
import { bronHealth, pollerRuntime, scrapeRun } from "./schema";

export type PollerHealthTelemetryDatabase = PostgresJsDatabase<typeof schema>;
export type PollerHealthTelemetryTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type PollerHealthTelemetryExecutor =
  | PollerHealthTelemetryDatabase
  | PollerHealthTelemetryTransaction;

export type PollerRuntimeStatus = "running" | "lock_lost" | "stopped";
export type SourceProgressPhase = "fetch" | "persist" | "curation";
export type SourceRunOutcome =
  | "backlogged"
  | "complete"
  | "failed"
  | "incomplete"
  | "parked"
  | "quarantined"
  | "unknown";

export interface PollerRuntimeRecord {
  readonly advisoryLockMaxAgeMs: number | null;
  readonly curationBudgetMs: number | null;
  readonly heartbeatMaxAgeMs: number | null;
  readonly runBudgetMs: number | null;

  readonly component: "poller";
  readonly fenceToken: number;
  readonly heartbeatAt: Date;
  readonly instanceId: string;
  readonly lastLockCheckAt: Date;
  readonly ownerToken: string;
  readonly releaseSha: string | null;
  readonly startedAt: Date;
  readonly status: PollerRuntimeStatus;
  readonly updatedAt: Date;
}

export interface PollerRuntimeClaimInput {
  readonly advisoryLockMaxAgeMs: number;
  readonly curationBudgetMs: number;
  readonly heartbeatMaxAgeMs: number;
  readonly runBudgetMs: number;

  /** The caller must acquire the session advisory lock before this claim. */
  readonly advisoryLockAcquired: true;
  readonly heartbeatAt: Date;
  readonly instanceId: string;
  readonly lastLockCheckAt: Date;
  readonly ownerToken: string;
  readonly releaseSha: string | null;
  readonly startedAt: Date;
}

export interface PollerRuntimeClaim {
  readonly fenceToken: number;
  readonly ownerToken: string;
  readonly record: PollerRuntimeRecord;
}

export interface RuntimeObservationInput {
  readonly at: Date;
  readonly fenceToken: number;
  readonly ownerToken: string;
}

export interface SourceOwnershipInput {
  readonly bronId: string;
  readonly fenceToken: number;
  readonly phase: SourceProgressPhase;
  readonly phaseStartedAt: Date;
  readonly progressAt?: Date;
  readonly runId: string;
}

export interface SourceProgressInput {
  readonly at: Date;
  readonly bronId: string;
  readonly fenceToken: number;
  readonly phase: SourceProgressPhase;
  readonly phaseStartedAt?: Date;
  readonly runId: string;
}

export interface SourcePhaseInput {
  readonly bronId: string;
  readonly fenceToken: number;
  readonly phase: SourceProgressPhase;
  readonly phaseStartedAt: Date;
  readonly runId: string;
}

export interface SourceFinalizeInput {
  readonly bronId: string;
  readonly completedAt: Date;
  readonly discoveryComplete: boolean;
  readonly drained: boolean;
  readonly fenceToken: number;
  readonly hasFailures: boolean;
  readonly hasQuarantined: boolean;
  /** `complete` is only fresh when all explicit completion proofs are true. */
  readonly outcome: SourceRunOutcome;
  readonly runId: string;
}

export interface PollerHealthTelemetryStore {
  readonly claimRuntime: (
    input: PollerRuntimeClaimInput
  ) => Promise<PollerRuntimeClaim>;
  readonly readRuntime: () => Promise<PollerRuntimeRecord | null>;
  readonly heartbeat: (input: RuntimeObservationInput) => Promise<boolean>;
  readonly recordLockCheck: (
    input: RuntimeObservationInput
  ) => Promise<boolean>;
  readonly markLockLost: (input: RuntimeObservationInput) => Promise<boolean>;
  readonly stopRuntime: (input: RuntimeObservationInput) => Promise<boolean>;
  readonly claimSourceOwnership: (
    input: SourceOwnershipInput
  ) => Promise<boolean>;
  readonly recordSourceProgress: (
    input: SourceProgressInput
  ) => Promise<boolean>;
  readonly beginSourcePhase: (input: SourcePhaseInput) => Promise<boolean>;
  readonly finalizeSource: (input: SourceFinalizeInput) => Promise<boolean>;
  readonly finishSource: (input: SourceFinalizeInput) => Promise<boolean>;
}

const runtimeOwnerWhere = (input: RuntimeObservationInput) =>
  and(
    eq(pollerRuntime.component, "poller"),
    eq(pollerRuntime.ownerToken, input.ownerToken),
    eq(pollerRuntime.fenceToken, input.fenceToken)
  );

const toPollerRuntimeRecord = (
  row: typeof pollerRuntime.$inferSelect
): PollerRuntimeRecord => {
  if (row.component !== "poller") {
    throw new Error(`Unexpected poller runtime component: ${row.component}`);
  }
  if (
    row.status !== "running" &&
    row.status !== "lock_lost" &&
    row.status !== "stopped"
  ) {
    throw new Error(`Unexpected poller runtime status: ${row.status}`);
  }
  return { ...row, component: "poller", status: row.status };
};

const expectedRunStatus = (
  phase: SourceProgressPhase
): "running" | "succeeded" => (phase === "curation" ? "succeeded" : "running");

const runOwnership = (
  database: PollerHealthTelemetryExecutor,
  input: Pick<SourceOwnershipInput, "bronId" | "fenceToken" | "runId" | "phase">
) =>
  exists(
    database
      .select({ id: scrapeRun.id })
      .from(scrapeRun)
      .where(
        and(
          eq(scrapeRun.id, input.runId),
          eq(scrapeRun.bronId, input.bronId),
          eq(scrapeRun.fenceToken, input.fenceToken),
          eq(scrapeRun.status, expectedRunStatus(input.phase))
        )
      )
  );

const terminalRunOwnership = (
  database: PollerHealthTelemetryExecutor,
  input: Pick<SourceFinalizeInput, "bronId" | "fenceToken" | "runId">
) =>
  exists(
    database
      .select({ id: scrapeRun.id })
      .from(scrapeRun)
      .where(
        and(
          eq(scrapeRun.id, input.runId),
          eq(scrapeRun.bronId, input.bronId),
          eq(scrapeRun.fenceToken, input.fenceToken),
          inArray(scrapeRun.status, ["succeeded", "failed", "cancelled"])
        )
      )
  );

export class PostgresPollerHealthTelemetryStore implements PollerHealthTelemetryStore {
  private readonly database: PollerHealthTelemetryExecutor;

  constructor(database: PollerHealthTelemetryExecutor) {
    this.database = database;
  }

  async readRuntime(): Promise<PollerRuntimeRecord | null> {
    const [row] = await this.database
      .select()
      .from(pollerRuntime)
      .where(eq(pollerRuntime.component, "poller"))
      .limit(1);
    return row ? toPollerRuntimeRecord(row) : null;
  }

  async claimRuntime(
    input: PollerRuntimeClaimInput
  ): Promise<PollerRuntimeClaim> {
    if (input.advisoryLockAcquired !== true) {
      throw new Error(
        "Poller runtime claim requires an acquired advisory lock"
      );
    }

    const [row] = await this.database
      .insert(pollerRuntime)
      .values({
        advisoryLockMaxAgeMs: input.advisoryLockMaxAgeMs,
        component: "poller",
        curationBudgetMs: input.curationBudgetMs,
        fenceToken: 1,
        heartbeatAt: input.heartbeatAt,
        heartbeatMaxAgeMs: input.heartbeatMaxAgeMs,
        instanceId: input.instanceId,
        lastLockCheckAt: input.lastLockCheckAt,
        ownerToken: input.ownerToken,
        releaseSha: input.releaseSha,
        runBudgetMs: input.runBudgetMs,
        startedAt: input.startedAt,
        status: "running",
        updatedAt: input.heartbeatAt,
      })
      .onConflictDoUpdate({
        set: {
          advisoryLockMaxAgeMs: input.advisoryLockMaxAgeMs,
          curationBudgetMs: input.curationBudgetMs,
          fenceToken: sql`${pollerRuntime.fenceToken} + 1`,
          heartbeatAt: input.heartbeatAt,
          heartbeatMaxAgeMs: input.heartbeatMaxAgeMs,
          instanceId: input.instanceId,
          lastLockCheckAt: input.lastLockCheckAt,
          ownerToken: input.ownerToken,
          releaseSha: input.releaseSha,
          runBudgetMs: input.runBudgetMs,
          startedAt: input.startedAt,
          status: "running",
          updatedAt: input.heartbeatAt,
        },
        target: pollerRuntime.component,
      })
      .returning();

    if (!row) {
      throw new Error("Unable to claim poller runtime");
    }

    return {
      fenceToken: row.fenceToken,
      ownerToken: row.ownerToken,
      record: toPollerRuntimeRecord(row),
    };
  }

  async heartbeat(input: RuntimeObservationInput): Promise<boolean> {
    const [row] = await this.database
      .update(pollerRuntime)
      .set({ heartbeatAt: input.at, updatedAt: input.at })
      .where(runtimeOwnerWhere(input))
      .returning({ component: pollerRuntime.component });
    return row !== undefined;
  }

  async recordLockCheck(input: RuntimeObservationInput): Promise<boolean> {
    const [row] = await this.database
      .update(pollerRuntime)
      .set({ lastLockCheckAt: input.at, updatedAt: input.at })
      .where(runtimeOwnerWhere(input))
      .returning({ component: pollerRuntime.component });
    return row !== undefined;
  }

  async markLockLost(input: RuntimeObservationInput): Promise<boolean> {
    const [row] = await this.database
      .update(pollerRuntime)
      .set({
        lastLockCheckAt: input.at,
        status: "lock_lost",
        updatedAt: input.at,
      })
      .where(runtimeOwnerWhere(input))
      .returning({ component: pollerRuntime.component });
    return row !== undefined;
  }

  async stopRuntime(input: RuntimeObservationInput): Promise<boolean> {
    const [row] = await this.database
      .update(pollerRuntime)
      .set({ status: "stopped", updatedAt: input.at })
      .where(runtimeOwnerWhere(input))
      .returning({ component: pollerRuntime.component });
    return row !== undefined;
  }

  /**
   * Call from the existing run-start transaction after the poller advisory
   * lock has been acquired. The transaction keeps run creation and this
   * guarded active-run replacement atomic for the caller.
   */
  async claimSourceOwnership(input: SourceOwnershipInput): Promise<boolean> {
    await this.database
      .insert(bronHealth)
      .values({ bronId: input.bronId })
      .onConflictDoNothing({ target: bronHealth.bronId });

    const [row] = await this.database
      .update(bronHealth)
      .set({
        activeRunId: input.runId,
        phaseStartedAt: input.phaseStartedAt,
        progressAt: input.progressAt ?? null,
        progressPhase: input.phase,
        updatedAt: input.phaseStartedAt,
      })
      .where(
        and(
          eq(bronHealth.bronId, input.bronId),
          runOwnership(this.database, input)
        )
      )
      .returning({ bronId: bronHealth.bronId });
    return row !== undefined;
  }

  async recordSourceProgress(input: SourceProgressInput): Promise<boolean> {
    const values = input.phaseStartedAt
      ? {
          phaseStartedAt: input.phaseStartedAt,
          progressAt: input.at,
          progressPhase: input.phase,
          updatedAt: input.at,
        }
      : {
          progressAt: input.at,
          progressPhase: input.phase,
          updatedAt: input.at,
        };

    const [row] = await this.database
      .update(bronHealth)
      .set(values)
      .where(
        and(
          eq(bronHealth.bronId, input.bronId),
          eq(bronHealth.activeRunId, input.runId),
          or(
            isNull(bronHealth.progressAt),
            lte(bronHealth.progressAt, input.at)
          ),
          runOwnership(this.database, input)
        )
      )
      .returning({ bronId: bronHealth.bronId });
    return row !== undefined;
  }

  async beginSourcePhase(input: SourcePhaseInput): Promise<boolean> {
    const [row] = await this.database
      .update(bronHealth)
      .set({
        phaseStartedAt: input.phaseStartedAt,
        progressAt: null,
        progressPhase: input.phase,
        updatedAt: input.phaseStartedAt,
      })
      .where(
        and(
          eq(bronHealth.bronId, input.bronId),
          eq(bronHealth.activeRunId, input.runId),
          runOwnership(this.database, input)
        )
      )
      .returning({ bronId: bronHealth.bronId });
    return row !== undefined;
  }

  async finishSource(input: SourceFinalizeInput): Promise<boolean> {
    if (
      input.outcome === "complete" &&
      (!input.discoveryComplete ||
        !input.drained ||
        input.hasFailures ||
        input.hasQuarantined)
    ) {
      throw new Error(
        "Complete source outcome requires full discovery, drained curation, and no failures"
      );
    }

    const isFullySuccessful =
      input.outcome === "complete" &&
      input.discoveryComplete &&
      input.drained &&
      !input.hasFailures &&
      !input.hasQuarantined;

    const values = isFullySuccessful
      ? {
          activeRunId: null,
          lastCompletionOutcome: input.outcome,
          lastFullySuccessfulAt: input.completedAt,
          phaseStartedAt: null,
          progressPhase: null,
          updatedAt: input.completedAt,
        }
      : {
          activeRunId: null,
          lastCompletionOutcome: input.outcome,
          phaseStartedAt: null,
          progressPhase: null,
          updatedAt: input.completedAt,
        };

    const [row] = await this.database
      .update(bronHealth)
      .set(values)
      .where(
        and(
          eq(bronHealth.bronId, input.bronId),
          eq(bronHealth.activeRunId, input.runId),
          terminalRunOwnership(this.database, {
            bronId: input.bronId,
            fenceToken: input.fenceToken,
            runId: input.runId,
          })
        )
      )
      .returning({ bronId: bronHealth.bronId });
    return row !== undefined;
  }

  finalizeSource(input: SourceFinalizeInput): Promise<boolean> {
    return this.finishSource(input);
  }
}

export interface PollerHealthTelemetryEffectService {
  readonly claimRuntime: (
    input: PollerRuntimeClaimInput
  ) => Effect.Effect<PollerRuntimeClaim, DbStoreFault>;
  readonly readRuntime: () => Effect.Effect<
    PollerRuntimeRecord | null,
    DbStoreFault
  >;
  readonly heartbeat: (
    input: RuntimeObservationInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly recordLockCheck: (
    input: RuntimeObservationInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly markLockLost: (
    input: RuntimeObservationInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly stopRuntime: (
    input: RuntimeObservationInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly claimSourceOwnership: (
    input: SourceOwnershipInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly recordSourceProgress: (
    input: SourceProgressInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly beginSourcePhase: (
    input: SourcePhaseInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly finalizeSource: (
    input: SourceFinalizeInput
  ) => Effect.Effect<boolean, DbStoreFault>;
  readonly finishSource: (
    input: SourceFinalizeInput
  ) => Effect.Effect<boolean, DbStoreFault>;
}

export const PollerHealthTelemetry =
  Context.Service<PollerHealthTelemetryEffectService>(
    "@ji/db/PollerHealthTelemetry"
  );

export const PollerHealthTelemetryLive = (
  store: PollerHealthTelemetryStore
): Layer.Layer<PollerHealthTelemetryEffectService> =>
  Layer.succeed(PollerHealthTelemetry, {
    beginSourcePhase: (input) =>
      fromStorePromise(() => store.beginSourcePhase(input)),
    claimRuntime: (input) => fromStorePromise(() => store.claimRuntime(input)),
    claimSourceOwnership: (input) =>
      fromStorePromise(() => store.claimSourceOwnership(input)),
    finalizeSource: (input) =>
      fromStorePromise(() => store.finalizeSource(input)),
    finishSource: (input) => fromStorePromise(() => store.finishSource(input)),
    heartbeat: (input) => fromStorePromise(() => store.heartbeat(input)),
    markLockLost: (input) => fromStorePromise(() => store.markLockLost(input)),
    readRuntime: () => fromStorePromise(() => store.readRuntime()),
    recordLockCheck: (input) =>
      fromStorePromise(() => store.recordLockCheck(input)),
    recordSourceProgress: (input) =>
      fromStorePromise(() => store.recordSourceProgress(input)),
    stopRuntime: (input) => fromStorePromise(() => store.stopRuntime(input)),
  });
