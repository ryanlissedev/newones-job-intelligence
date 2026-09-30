/* oxlint-disable max-classes-per-file -- cohesive Postgres adapters share schema mapping and mutation guards */
import type {
  BronPersistence,
  BronRegisterRecord,
} from "@ji/application/bronnen";
import { validateSecretRef } from "@ji/application/bronnen";
import type {
  CheckpointKey,
  ConnectorObservation,
  ConnectorRunMetrics,
  ConnectorRunProgress,
  ObservationRecordInput,
  ObservationRecorder,
  RunCompletionInput,
  RunFailureInput,
  RunFailureEnvelope,
  RunLifecycleStore,
  RunStartInput,
  RunStartResult,
  SourceRecordWriteOutcome,
  SourceRecordWriteResult,
} from "@ji/connectors";
import {
  RunAlreadyInProgressError,
  RunOwnershipLostError,
} from "@ji/connectors";
import {
  BRON_STATUSES,
  CONNECTOR_METHODS,
  VOORWAARDEN_STATUSES,
} from "@ji/domain";
import type { BronId } from "@ji/domain";
import { ABANDON_RUN_AFTER_MS_DEFAULT } from "@ji/env/poller";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { PostgresPollerHealthTelemetryStore } from "./poller-health-telemetry-store";
import type { PollerHealthTelemetryTransaction } from "./poller-health-telemetry-store";
import { runStalenessCutoff } from "./run-staleness";
import type * as schema from "./schema";
import { aanvraagObservation, bron, scrapeRun, sourceRecord } from "./schema";

export type BronRuntimeDatabase = PostgresJsDatabase<typeof schema>;

export interface ActivateBronInput {
  bronId: BronId;
  testImportRunId: string;
  minimumTestImportObservations?: number;
}

export const DEFAULT_MINIMUM_TEST_IMPORT_OBSERVATIONS = 20;
const HISTORICAL_POINTER_PAYLOAD_SCHEMA = z.object({
  observedAt: z.iso.datetime({ offset: true }),
  rawPayloadRef: z.string().trim().min(1),
});

/** RJC-357: absent listing hash persists as NULL (never authorises a skip). */
const toStoredListingHash = (value: string | null | undefined): string | null =>
  value ?? null;

const requireMutation = <Row>(rows: Row[], description: string): Row => {
  const [row] = rows;
  if (!row) {
    throw new Error(`Unable to ${description}`);
  }
  return row;
};

const RUN_FAILURE_ENVELOPES: readonly RunFailureEnvelope[] = [
  {
    class: "connector",
    code: "DISCOVER_FAILED",
    message: "Connector discovery failed",
    phase: "discover",
  },
  {
    class: "connector",
    code: "FETCH_FAILED",
    message: "Connector fetch failed",
    phase: "fetch",
  },
  {
    class: "storage",
    code: "RAW_STORE_WRITE_FAILED",
    message: "Raw object persistence failed",
    phase: "raw-store",
  },
  {
    class: "persistence",
    code: "OBSERVATION_WRITE_FAILED",
    message: "Observation persistence failed",
    phase: "observation",
  },
  {
    class: "persistence",
    code: "CHECKPOINT_WRITE_FAILED",
    message: "Run checkpoint persistence failed",
    phase: "checkpoint",
  },
  {
    class: "persistence",
    code: "COMPLETE_WRITE_FAILED",
    message: "Run completion persistence failed",
    phase: "complete",
  },
  {
    class: "internal",
    code: "UNEXPECTED_FAILURE",
    message: "Connector run failed",
    phase: "unknown",
  },
  {
    class: "internal",
    code: "LEGACY_FAILURE",
    message: "Legacy run failed; details unavailable",
    phase: "unknown",
  },
];

const toFailureEnvelope = (
  row: typeof scrapeRun.$inferSelect
): RunFailureEnvelope | null => {
  if (
    row.failurePhase === null &&
    row.failureClass === null &&
    row.failureCode === null &&
    row.failureMessage === null
  ) {
    return null;
  }
  const envelope = RUN_FAILURE_ENVELOPES.find(
    (candidate) =>
      candidate.phase === row.failurePhase &&
      candidate.class === row.failureClass &&
      candidate.code === row.failureCode &&
      candidate.message === row.failureMessage
  );
  if (!envelope) {
    throw new Error("Invalid persisted run failure envelope");
  }
  return envelope;
};

const toLastRun = (
  row: typeof scrapeRun.$inferSelect | undefined
): BronRegisterRecord["lastRun"] => {
  if (!row) {
    return null;
  }
  return {
    changed: row.gewijzigd,
    closed: row.gesloten,
    error: row.fouten,
    failure: toFailureEnvelope(row),
    found: row.aantalGevonden,
    geindigd: row.geindigd,
    gestart: row.gestart,
    new: row.nieuw,
    rejected: row.rejected,
    scrapeRunId: row.id,
    status: row.status,
  };
};

const requireEnumValue = <Value extends string>(
  values: readonly Value[],
  value: string,
  field: string
): Value => {
  const match = values.find((candidate) => candidate === value);
  if (!match) {
    throw new Error(`Invalid persisted ${field}: ${value}`);
  }
  return match;
};

const toBronRecord = (
  row: typeof bron.$inferSelect,
  lastRun: BronRegisterRecord["lastRun"]
): BronRegisterRecord => ({
  actief: row.actief,
  bronId: row.id,
  categorie: row.categorie,
  crawlDelayMs: row.crawlDelayMs,
  interval: row.interval,
  lastRun,
  loginVereist: row.loginVereist,
  mappingRef: row.mappingRef,
  method: requireEnumValue(CONNECTOR_METHODS, row.ingestieType, "method"),
  naam: row.naam,
  rateLimitPerMinute: row.rateLimitPerMinute,
  retentionDays: row.retentionDays,
  secretRef: row.secretRef,
  status: requireEnumValue(BRON_STATUSES, row.status, "status"),
  voorwaardenStatus: requireEnumValue(
    VOORWAARDEN_STATUSES,
    row.voorwaardenStatus,
    "voorwaardenStatus"
  ),
});

export class PostgresBronPersistence implements BronPersistence {
  private readonly database: BronRuntimeDatabase;

  constructor(database: BronRuntimeDatabase) {
    this.database = database;
  }

  async create(record: BronRegisterRecord): Promise<BronRegisterRecord> {
    if (record.actief) {
      throw new Error(
        "Bron must be created inactive; use activate after a succeeded test-import"
      );
    }

    const secretRefIssues = validateSecretRef(record.secretRef);
    if (secretRefIssues.length > 0) {
      throw new Error(
        `Invalid secret reference: ${secretRefIssues.join("; ")}`
      );
    }

    const rows = await this.database
      .insert(bron)
      .values({
        actief: record.actief,
        categorie: record.categorie,
        crawlDelayMs: record.crawlDelayMs,
        id: record.bronId,
        ingestieType: record.method,
        interval: record.interval,
        loginVereist: record.loginVereist,
        mappingRef: record.mappingRef,
        naam: record.naam,
        rateLimitPerMinute: record.rateLimitPerMinute,
        retentionDays: record.retentionDays,
        secretRef: record.secretRef,
        status: record.status,
        voorwaardenStatus: record.voorwaardenStatus,
      })
      .returning();
    return toBronRecord(requireMutation(rows, "create bron"), null);
  }

  async findById(bronId: BronId): Promise<BronRegisterRecord | null> {
    const [row] = await this.database
      .select()
      .from(bron)
      .where(eq(bron.id, bronId))
      .limit(1);
    if (!row) {
      return null;
    }
    return toBronRecord(row, await this.findLastRun(row.id));
  }

  async list(): Promise<BronRegisterRecord[]> {
    const rows = await this.database.select().from(bron).orderBy(bron.naam);
    return Promise.all(
      rows.map(async (row) => toBronRecord(row, await this.findLastRun(row.id)))
    );
  }

  async setActive(bronId: BronId, actief: boolean): Promise<void> {
    if (actief) {
      throw new Error("Use activate with a succeeded test-import run");
    }
    const rows = await this.database
      .update(bron)
      .set({ actief })
      .where(eq(bron.id, bronId))
      .returning({ id: bron.id });
    requireMutation(rows, "update bron activation");
  }

  activate(input: ActivateBronInput): Promise<BronRegisterRecord> {
    const minimum =
      input.minimumTestImportObservations ??
      DEFAULT_MINIMUM_TEST_IMPORT_OBSERVATIONS;
    return this.database.transaction(async (tx) => {
      if (!(Number.isInteger(minimum) && minimum >= 1)) {
        throw new Error(
          "minimumTestImportObservations must be a positive integer"
        );
      }
      const [testRun] = await tx
        .select({ id: scrapeRun.id })
        .from(scrapeRun)
        .where(
          and(
            eq(scrapeRun.id, input.testImportRunId),
            eq(scrapeRun.bronId, input.bronId),
            eq(scrapeRun.runKind, "test"),
            eq(scrapeRun.status, "succeeded")
          )
        )
        .limit(1);
      if (!testRun) {
        throw new Error(
          "A succeeded test-import run is required for activation"
        );
      }
      const testObservations = await tx
        .selectDistinct({ sourceRecordId: aanvraagObservation.sourceRecordId })
        .from(aanvraagObservation)
        .where(
          and(
            eq(aanvraagObservation.bronId, input.bronId),
            eq(aanvraagObservation.scrapeRunId, input.testImportRunId)
          )
        )
        .limit(minimum);
      if (testObservations.length < minimum) {
        throw new Error(
          `A succeeded test-import with at least ${minimum} distinct persisted source records is required for activation`
        );
      }

      const rows = await tx
        .update(bron)
        .set({ actief: true, status: "ready" })
        .where(
          and(
            eq(bron.id, input.bronId),
            eq(bron.voorwaardenStatus, "toegestaan")
          )
        )
        .returning();
      return toBronRecord(
        requireMutation(rows, "activate bron after test-import"),
        toLastRun(
          await tx.query.scrapeRun.findFirst({
            orderBy: desc(scrapeRun.gestart),
            where: eq(scrapeRun.bronId, input.bronId),
          })
        )
      );
    });
  }

  private async findLastRun(
    bronId: BronId
  ): Promise<BronRegisterRecord["lastRun"]> {
    const [row] = await this.database
      .select()
      .from(scrapeRun)
      .where(eq(scrapeRun.bronId, bronId))
      .orderBy(desc(scrapeRun.gestart))
      .limit(1);
    return toLastRun(row);
  }
}

export const progressValues = (progress: ConnectorRunProgress) => ({
  aantalGevonden: progress.metrics.found,
  checkpoint: progress.checkpoint,
  fouten: progress.metrics.error,
  gesloten: progress.metrics.closed ?? 0,
  gewijzigd: progress.metrics.changed,
  nieuw: progress.metrics.new,
  rejected: progress.metrics.rejected,
});

export const toRunProgress = (row: {
  changed: number;
  checkpoint: unknown;
  closed?: number;
  error: number;
  found: number;
  new: number;
  rejected: number;
}): ConnectorRunProgress => {
  const metrics: ConnectorRunMetrics = {
    changed: row.changed,
    error: row.error,
    found: row.found,
    new: row.new,
    rejected: row.rejected,
    unchanged: 0,
  };
  if (row.closed !== undefined && row.closed > 0) {
    metrics.closed = row.closed;
  }
  return {
    // SAFETY: Connector checkpoints are the only JSON values written through this adapter.
    checkpoint: row.checkpoint as ConnectorRunProgress["checkpoint"],
    metrics,
  };
};

const completionValues = (input: RunCompletionInput) => ({
  ...progressValues(input.progress),
  geindigd: input.finishedAt,
});

const requireOwnership = (rows: { id: string }[]): void => {
  if (rows.length === 0) {
    throw new RunOwnershipLostError();
  }
};

const validateFenceToken = (fenceToken: number): void => {
  if (!Number.isSafeInteger(fenceToken) || fenceToken < 1) {
    throw new RunOwnershipLostError();
  }
};

export class PostgresRunStore implements RunLifecycleStore {
  private readonly database: BronRuntimeDatabase;
  private readonly now: () => Date;
  private readonly pollRunStaleAfterMs: number;

  constructor(
    database: BronRuntimeDatabase,
    options: { now?: () => Date; pollRunStaleAfterMs?: number } = {}
  ) {
    this.database = database;
    this.now = options.now ?? (() => new Date());
    this.pollRunStaleAfterMs =
      options.pollRunStaleAfterMs ?? ABANDON_RUN_AFTER_MS_DEFAULT;
  }

  async load(key: CheckpointKey): Promise<ConnectorRunProgress | null> {
    const [row] = await this.database
      .select({
        changed: scrapeRun.gewijzigd,
        checkpoint: scrapeRun.checkpoint,
        closed: scrapeRun.gesloten,
        error: scrapeRun.fouten,
        found: scrapeRun.aantalGevonden,
        new: scrapeRun.nieuw,
        rejected: scrapeRun.rejected,
      })
      .from(scrapeRun)
      .where(
        and(eq(scrapeRun.id, key.scrapeRunId), eq(scrapeRun.bronId, key.bronId))
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return toRunProgress(row);
  }

  start(input: RunStartInput): Promise<RunStartResult> {
    return this.startWithKind(input);
  }

  async checkpoint(
    key: CheckpointKey,
    progress: ConnectorRunProgress,
    fenceToken: number
  ): Promise<void> {
    validateFenceToken(fenceToken);
    const rows = await this.database
      .update(scrapeRun)
      .set(progressValues(progress))
      .where(
        and(
          eq(scrapeRun.id, key.scrapeRunId),
          eq(scrapeRun.bronId, key.bronId),
          eq(scrapeRun.status, "running"),
          eq(scrapeRun.fenceToken, fenceToken)
        )
      )
      .returning({ id: scrapeRun.id });
    requireOwnership(rows);
  }

  async complete(input: RunCompletionInput): Promise<void> {
    validateFenceToken(input.fenceToken);
    const rows = await this.database
      .update(scrapeRun)
      .set({ ...completionValues(input), status: "succeeded" })
      .where(
        and(
          eq(scrapeRun.id, input.key.scrapeRunId),
          eq(scrapeRun.bronId, input.key.bronId),
          eq(scrapeRun.status, "running"),
          eq(scrapeRun.fenceToken, input.fenceToken)
        )
      )
      .returning({ id: scrapeRun.id });
    requireOwnership(rows);
  }

  async fail(input: RunFailureInput): Promise<void> {
    validateFenceToken(input.fenceToken);
    const rows = await this.database
      .update(scrapeRun)
      .set({
        ...completionValues(input),
        failureClass: input.failure.class,
        failureCode: input.failure.code,
        failureMessage: input.failure.message,
        failurePhase: input.failure.phase,
        status: "failed",
      })
      .where(
        and(
          eq(scrapeRun.id, input.key.scrapeRunId),
          eq(scrapeRun.bronId, input.key.bronId),
          eq(scrapeRun.status, "running"),
          eq(scrapeRun.fenceToken, input.fenceToken)
        )
      )
      .returning({ id: scrapeRun.id });
    requireOwnership(rows);
  }

  /**
   * One live poll per bron: a second `running` poll row newer than the
   * staleness cutoff means another executor owns this bron right now. Called
   * under the per-bron advisory lock, before a new row is inserted and before
   * a `failed` row is reopened for a durable retry.
   */
  private async assertNoLivePoll(
    tx: BronRuntimeTransaction,
    input: RunStartInput
  ): Promise<void> {
    if (input.runKind !== "poll") {
      return;
    }
    const cutoff = runStalenessCutoff(this.now(), this.pollRunStaleAfterMs);
    const [running] = await tx
      .select({ id: scrapeRun.id })
      .from(scrapeRun)
      .where(
        and(
          eq(scrapeRun.bronId, input.key.bronId),
          eq(scrapeRun.runKind, "poll"),
          eq(scrapeRun.status, "running"),
          gte(scrapeRun.gestart, cutoff)
        )
      )
      .limit(1);
    if (running) {
      throw new RunAlreadyInProgressError(input.key.bronId);
    }
  }

  private async claimPollHealth(
    tx: PollerHealthTelemetryTransaction,
    input: RunStartInput,
    result: RunStartResult
  ): Promise<RunStartResult> {
    if (input.runKind === "poll") {
      // Claim while the launch transaction holds the per-source lock. A late
      // milestone must never replace the ownership of a newer poll.
      const claimed = await new PostgresPollerHealthTelemetryStore(
        tx
      ).claimSourceOwnership({
        bronId: input.key.bronId,
        fenceToken: result.fenceToken,
        phase: "fetch",
        phaseStartedAt: this.now(),
        runId: input.key.scrapeRunId,
      });
      if (!claimed) {
        throw new RunOwnershipLostError();
      }
    }
    return result;
  }

  private startWithKind(input: RunStartInput): Promise<RunStartResult> {
    return this.database.transaction(async (tx) => {
      if (input.runKind === "poll") {
        // The two-int advisory-lock namespace is disjoint from the single-bigint
        // namespace used by the poller and projector singleton process locks.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('ji_poll_start'), hashtext(${input.key.bronId}))`
        );
      }

      let [existing] = await tx
        .select({
          bronId: scrapeRun.bronId,
          changed: scrapeRun.gewijzigd,
          checkpoint: scrapeRun.checkpoint,
          closed: scrapeRun.gesloten,
          error: scrapeRun.fouten,
          fenceToken: scrapeRun.fenceToken,
          found: scrapeRun.aantalGevonden,
          new: scrapeRun.nieuw,
          rejected: scrapeRun.rejected,
          runKind: scrapeRun.runKind,
          startedAt: scrapeRun.gestart,
          status: scrapeRun.status,
        })
        .from(scrapeRun)
        .where(eq(scrapeRun.id, input.key.scrapeRunId))
        .limit(1)
        .for("update");
      if (!existing) {
        await this.assertNoLivePoll(tx, input);

        const inserted = await tx
          .insert(scrapeRun)
          .values({
            bronId: input.key.bronId,
            ...progressValues(input.progress),
            fenceToken: 1,
            gestart: input.startedAt,
            id: input.key.scrapeRunId,
            runKind: input.runKind,
            status: "running",
          })
          .onConflictDoNothing({ target: scrapeRun.id })
          .returning({ id: scrapeRun.id });
        if (inserted.length > 0) {
          return this.claimPollHealth(tx, input, {
            fenceToken: 1,
            progress: structuredClone(input.progress),
            startedAt: input.startedAt,
          });
        }
        [existing] = await tx
          .select({
            bronId: scrapeRun.bronId,
            changed: scrapeRun.gewijzigd,
            checkpoint: scrapeRun.checkpoint,
            closed: scrapeRun.gesloten,
            error: scrapeRun.fouten,
            fenceToken: scrapeRun.fenceToken,
            found: scrapeRun.aantalGevonden,
            new: scrapeRun.nieuw,
            rejected: scrapeRun.rejected,
            runKind: scrapeRun.runKind,
            startedAt: scrapeRun.gestart,
            status: scrapeRun.status,
          })
          .from(scrapeRun)
          .where(eq(scrapeRun.id, input.key.scrapeRunId))
          .limit(1)
          .for("update");
      }
      if (
        !existing ||
        existing.bronId !== input.key.bronId ||
        existing.runKind !== input.runKind
      ) {
        throw new Error("Cannot resume mismatched or completed scrape run");
      }
      // CTP-643: a durable retry replays the same scrapeRunId, and the attempt
      // that failed has already recorded the row as `failed`. Reopening it
      // under a new fence keeps the checkpoint, so the retake refetches only
      // the page that failed. `gestart` moves to this attempt: it is the
      // liveness clock `abandonStaleRuns` reads, and a run that was abandoned
      // for being old would otherwise be abandoned again on the next tick. A
      // `succeeded` run stays closed: replaying one is the pipeline's job (it
      // reads the committed result), never a re-run.
      const reopenFailed =
        input.mode === "resume" && existing.status === "failed";
      if (existing.status !== "running" && !reopenFailed) {
        throw new Error("Cannot resume mismatched or completed scrape run");
      }
      if (input.mode === "resume") {
        const startedAt = reopenFailed ? input.startedAt : existing.startedAt;
        if (reopenFailed) {
          await this.assertNoLivePoll(tx, input);
        }
        const owned = await tx
          .update(scrapeRun)
          .set({
            failureClass: null,
            failureCode: null,
            failureMessage: null,
            failurePhase: null,
            fenceToken: sql`${scrapeRun.fenceToken} + 1`,
            geindigd: null,
            gestart: startedAt,
            status: "running",
          })
          .where(eq(scrapeRun.id, input.key.scrapeRunId))
          .returning({ fenceToken: scrapeRun.fenceToken });
        return this.claimPollHealth(tx, input, {
          fenceToken: requireMutation(owned, "acquire scrape-run ownership")
            .fenceToken,
          progress: toRunProgress(existing),
          startedAt,
        });
      }

      const [persistedObservation] = await tx
        .select({ id: aanvraagObservation.id })
        .from(aanvraagObservation)
        .where(eq(aanvraagObservation.scrapeRunId, input.key.scrapeRunId))
        .limit(1);
      if (persistedObservation) {
        throw new Error(
          "Cannot reset scrape run after observations are persisted; use a new scrapeRunId"
        );
      }

      const owned = await tx
        .update(scrapeRun)
        .set({
          ...progressValues(input.progress),
          fenceToken: sql`${scrapeRun.fenceToken} + 1`,
          gestart: input.startedAt,
        })
        .where(eq(scrapeRun.id, input.key.scrapeRunId))
        .returning({ fenceToken: scrapeRun.fenceToken });
      return this.claimPollHealth(tx, input, {
        fenceToken: requireMutation(owned, "reset scrape-run ownership")
          .fenceToken,
        progress: structuredClone(input.progress),
        startedAt: input.startedAt,
      });
    });
  }
}

const requireWriteOutcome = (value: string): SourceRecordWriteOutcome => {
  if (value !== "new" && value !== "changed" && value !== "unchanged") {
    throw new Error(`Invalid persisted observation outcome: ${value}`);
  }
  return value;
};

const classifyArrivalOutcome = (
  replayOutcome: string | undefined,
  inserted: boolean,
  existingContentHash: string | null,
  candidateContentHash: string
): SourceRecordWriteOutcome => {
  if (replayOutcome !== undefined) {
    return requireWriteOutcome(replayOutcome);
  }
  if (inserted) {
    return "new";
  }
  return existingContentHash === candidateContentHash ? "unchanged" : "changed";
};

interface SourcePointerOrder {
  contentHash: string;
  observedAt: string | null;
  rawPayloadRef: string;
  scrapeRunId: string;
  startedAt: Date;
}

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const toTimestamp = (value: string | null, description: string): number => {
  if (value === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`Invalid ${description}: ${value}`);
  }
  return timestamp;
};

export const compareSourcePointerOrder = (
  left: SourcePointerOrder,
  right: SourcePointerOrder
): number => {
  const startedAtDifference =
    left.startedAt.getTime() - right.startedAt.getTime();
  if (startedAtDifference !== 0) {
    return startedAtDifference;
  }
  const observedAtDifference =
    toTimestamp(left.observedAt, "observation timestamp") -
    toTimestamp(right.observedAt, "persisted observation timestamp");
  if (observedAtDifference !== 0) {
    return observedAtDifference;
  }
  const runDifference = compareText(left.scrapeRunId, right.scrapeRunId);
  if (runDifference !== 0) {
    return runDifference;
  }
  const hashDifference = compareText(left.contentHash, right.contentHash);
  if (hashDifference === 0) {
    return compareText(left.rawPayloadRef, right.rawPayloadRef);
  }
  return hashDifference;
};

const toHistoricalPointer = (row: {
  contentHash: string;
  payload: unknown;
  scrapeRunId: string;
  startedAt: Date;
}): SourcePointerOrder | null => {
  const parsed = HISTORICAL_POINTER_PAYLOAD_SCHEMA.safeParse(row.payload);
  if (!parsed.success) {
    return null;
  }
  return {
    contentHash: row.contentHash,
    observedAt: parsed.data.observedAt,
    rawPayloadRef: parsed.data.rawPayloadRef,
    scrapeRunId: row.scrapeRunId,
    startedAt: row.startedAt,
  };
};

type BronRuntimeTransaction = Parameters<
  Parameters<BronRuntimeDatabase["transaction"]>[0]
>[0];

const selectCanonicalSourcePointer = async (
  tx: BronRuntimeTransaction,
  sourceRecordId: string,
  existing: typeof sourceRecord.$inferSelect,
  candidate: SourcePointerOrder | null
): Promise<SourcePointerOrder> => {
  const [currentRun] = await tx
    .select({ startedAt: scrapeRun.gestart })
    .from(scrapeRun)
    .where(eq(scrapeRun.id, existing.scrapeRunId))
    .limit(1);
  if (!currentRun) {
    throw new Error("Current source-record run could not be read");
  }
  const historicalRows = await tx
    .select({
      contentHash: aanvraagObservation.contentHash,
      payload: aanvraagObservation.payload,
      scrapeRunId: aanvraagObservation.scrapeRunId,
      startedAt: scrapeRun.gestart,
    })
    .from(aanvraagObservation)
    .innerJoin(scrapeRun, eq(aanvraagObservation.scrapeRunId, scrapeRun.id))
    .where(eq(aanvraagObservation.sourceRecordId, sourceRecordId));
  const pointers: SourcePointerOrder[] = [
    {
      contentHash: existing.contentHash,
      // The mutable legacy pointer remains a fallback when its immutable
      // observation is missing or invalid and therefore has no observedAt.
      observedAt: null,
      rawPayloadRef: existing.rawPayloadRef,
      scrapeRunId: existing.scrapeRunId,
      startedAt: currentRun.startedAt,
    },
  ];
  if (candidate) {
    pointers.push(candidate);
  }
  for (const row of historicalRows) {
    const historicalPointer = toHistoricalPointer(row);
    if (historicalPointer) {
      pointers.push(historicalPointer);
    }
  }
  const [maximumCandidate, ...remainingPointers] = pointers;
  let maximum = maximumCandidate;
  if (!maximum) {
    throw new Error("Canonical source-pointer candidates are unavailable");
  }
  for (const pointer of remainingPointers) {
    if (compareSourcePointerOrder(pointer, maximum) > 0) {
      maximum = pointer;
    }
  }
  return maximum;
};

export class PostgresObservationRecorder implements ObservationRecorder {
  private readonly database: BronRuntimeDatabase;

  constructor(database: BronRuntimeDatabase) {
    this.database = database;
  }

  record(input: ObservationRecordInput): Promise<SourceRecordWriteResult> {
    return this.database.transaction(async (tx) => {
      validateFenceToken(input.fenceToken);
      if (
        input.key.bronId !== input.sourceRecord.bronId ||
        input.key.scrapeRunId !== input.sourceRecord.scrapeRunId ||
        input.key.bronId !== input.observation.bronId ||
        input.key.scrapeRunId !== input.observation.scrapeRunId
      ) {
        throw new RunOwnershipLostError();
      }
      const ownedRuns = await tx
        .select({ id: scrapeRun.id, startedAt: scrapeRun.gestart })
        .from(scrapeRun)
        .where(
          and(
            eq(scrapeRun.id, input.key.scrapeRunId),
            eq(scrapeRun.bronId, input.key.bronId),
            eq(scrapeRun.status, "running"),
            eq(scrapeRun.fenceToken, input.fenceToken)
          )
        )
        .limit(1)
        .for("update");
      requireOwnership(ownedRuns);
      const { sourceRecord: record } = input;
      const inserted = await tx
        .insert(sourceRecord)
        .values(record)
        .onConflictDoNothing({
          target: [sourceRecord.bronId, sourceRecord.bronReferentie],
        })
        .returning({ id: sourceRecord.id });
      const [insertedRow] = inserted;
      const [existingRow] = insertedRow
        ? []
        : await tx
            .select()
            .from(sourceRecord)
            .where(
              and(
                eq(sourceRecord.bronId, record.bronId),
                eq(sourceRecord.bronReferentie, record.bronReferentie)
              )
            )
            .limit(1)
            .for("update");
      const existing = existingRow ?? null;
      const sourceRecordId = insertedRow?.id ?? existing?.id;
      if (!sourceRecordId) {
        throw new Error("Source record identity could not be persisted");
      }

      const [replay] = await tx
        .select({ outcome: aanvraagObservation.outcome })
        .from(aanvraagObservation)
        .where(
          and(
            eq(aanvraagObservation.scrapeRunId, record.scrapeRunId),
            eq(aanvraagObservation.sourceRecordId, sourceRecordId),
            eq(aanvraagObservation.contentHash, record.contentHash)
          )
        )
        .limit(1);

      // Outcome and its metrics describe the arrival-state delta. Canonical
      // pointer ordering below intentionally does not reclassify history.
      const outcome = classifyArrivalOutcome(
        replay?.outcome,
        Boolean(insertedRow),
        existing?.contentHash ?? null,
        record.contentHash
      );
      const [ownedRun] = ownedRuns;
      if (!ownedRun) {
        throw new RunOwnershipLostError();
      }
      if (existing) {
        const canonicalPointer = await selectCanonicalSourcePointer(
          tx,
          sourceRecordId,
          existing,
          replay
            ? null
            : {
                contentHash: record.contentHash,
                observedAt: input.observation.observedAt,
                rawPayloadRef: record.rawPayloadRef,
                scrapeRunId: record.scrapeRunId,
                startedAt: ownedRun.startedAt,
              }
        );
        await tx
          .update(sourceRecord)
          .set({
            contentHash: canonicalPointer.contentHash,
            // RJC-357: always the CURRENT observation's listing hash, not the
            // canonical pointer's — the skip asks "does the live listing
            // still look like the last one we acted on". `?? null` clears a
            // stale value when this observation carried no listing hash, so
            // it can never wrongly authorise a skip.
            listingHash: toStoredListingHash(record.listingHash),
            rawPayloadRef: canonicalPointer.rawPayloadRef,
            scrapeRunId: canonicalPointer.scrapeRunId,
          })
          .where(eq(sourceRecord.id, sourceRecordId));
      }
      if (replay) {
        return { outcome, sourceRecordId };
      }

      const observation: ConnectorObservation = {
        ...input.observation,
        sourceRecordId,
      };
      const insertedObservations = await tx
        .insert(aanvraagObservation)
        .values({
          bronId: observation.bronId,
          contentHash: observation.contentHash,
          outcome,
          payload: observation,
          scrapeRunId: observation.scrapeRunId,
          sourceRecordId: observation.sourceRecordId,
          // RJC-433: distinguish forward-path work from legacy rows whose
          // historical `pending` default does not prove that replay is safe.
          status: "awaiting_curation",
        })
        .onConflictDoNothing({
          target: [
            aanvraagObservation.scrapeRunId,
            aanvraagObservation.sourceRecordId,
            aanvraagObservation.contentHash,
          ],
        })
        .returning({ outcome: aanvraagObservation.outcome });
      const [insertedObservation] = insertedObservations;
      if (insertedObservation) {
        return { outcome, sourceRecordId };
      }
      const [persistedReplay] = await tx
        .select({ outcome: aanvraagObservation.outcome })
        .from(aanvraagObservation)
        .where(
          and(
            eq(aanvraagObservation.scrapeRunId, record.scrapeRunId),
            eq(aanvraagObservation.sourceRecordId, sourceRecordId),
            eq(aanvraagObservation.contentHash, record.contentHash)
          )
        )
        .limit(1);
      if (!persistedReplay) {
        throw new Error("Observation replay could not be read after conflict");
      }
      return {
        outcome: requireWriteOutcome(persistedReplay.outcome),
        sourceRecordId,
      };
    });
  }
}
