import { executeBronRun } from "@ji/application/bronnen";
import type {
  BronPersistence,
  ExecuteBronRunInput,
  ExecuteBronRunResult,
} from "@ji/application/bronnen";
import type { LifecycleReconcilePorts } from "@ji/application/lifecycle";
import type {
  DiscoveryFloorEvidence,
  RunBaselineSample,
} from "@ji/application/observability";
import {
  DISCOVERY_FLOOR_ALERT_KIND,
  DISCOVERY_FLOOR_BREACH_CODE,
  DISCOVERY_FLOOR_FAILURE,
  buildDiscoveryFloorDedupeKey,
  buildDiscoveryFloorMessage,
  buildSilenceDedupeKey,
  createSilenceAlertWriter,
  createStderrAlertSink,
  createWebhookAlertSink,
  deliverOpenedAlert,
  evaluateDiscoveryFloor,
  observeConnectorRunSilence,
} from "@ji/application/observability";
import type { AlertStore, BronHealthStore } from "@ji/application/registry";
import { SOURCES } from "@ji/application/sources";
import type { SourceDefinition } from "@ji/application/sources";
import { fullJitter, RunOwnershipLostError } from "@ji/connectors";
import type {
  Connector,
  ConnectorRunKind,
  ConnectorRunMetrics,
  RunCompleteness,
  RunIncompleteReason,
  KnownHashStore,
  ObjectStore,
  ObservationRecorder,
  RunLifecycleStore,
} from "@ji/connectors";
// Bun-only: see the equivalent import note in apps/server/src/slice-a-registry.ts.
import { createRawObjectStore } from "@ji/connectors/s3-object-client";
import {
  createBronRuntimeClient,
  drainPostgresOutbox,
  PostgresAlertStore,
  PostgresBronHealthStore,
  PostgresSearchDocumentLoader,
  PostgresSearchVersionStore,
  querySilenceBaselineSamples,
  scrapeRun,
} from "@ji/db";
import type { BronRuntimeDatabase } from "@ji/db";
import type { BronHealthDatabase } from "@ji/db/bron-health-stores";
import { curateScrapeRun } from "@ji/db/curate-scrape-run";
import { describeCauseChain, errorNameOf } from "@ji/db/error-cause-chain";
import { PostgresCurateStore } from "@ji/db/postgres-curate-store";
import { aanvraagObservation } from "@ji/db/schema/staging";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { ManticoreSearchEngine } from "@ji/search";
import { and, eq } from "drizzle-orm";

import {
  readAlertWebhookUrl,
  readSearchProjectorMode,
  requireManticoreUrl,
} from "./poll-bron-env";
import { withAbortFinalization } from "./poller/abort-finalization";
import { redactErrorMessage } from "./poller/source-log";
import { reportTelemetryCallback } from "./poller/telemetry-callback";
import type { SliceABronSlug } from "./slice-a-bronnen";
import type { PollBronPayload } from "./tasks/poll-bron-schema";

/**
 * RJC-397: JSON-safe mirror of the reconcile result (counts, not id
 * arrays) so the task output stays small and greppable. Null when the run
 * was not a poll.
 */
export interface PollBronLifecycleSummary {
  incremented: number;
  reopened: number;
  reset: number;
  skippedIncrementReason: RunIncompleteReason | null;
  staled: number;
}

export interface PollBronRunResult {
  bronId: BronId;
  bronSlug: SliceABronSlug;
  /** Null when the result was replayed from an already-succeeded run row. */
  completeness: RunCompleteness | null;
  fenceToken: number;
  lifecycle: PollBronLifecycleSummary | null;
  metrics: ConnectorRunMetrics;
  scrapeRunId: ScrapeRunId;
  status: "succeeded";
  writtenRecords: number;
}

export const SILENCE_AUTO_RESOLVE_ACTOR = "system:silence-recovered";

export interface BronIngestPipelineResult extends PollBronRunResult {
  alreadyCommitted: number;
  attemptedObservationIds: string[];
  blockedOrdering: number;
  curated: number;
  drained: number;
  /** Observations parked on `curation_failed` by this pass; see CTP-499. */
  failed: number;
  /** Null in "onbox" mode: this process never drains, so it has no version to report. */
  indexVersion: number | null;
  quarantined: number;
  pending: number;
  remaining: number;
  silenceAlert?: { alertId?: string; created: boolean } | null;
  unchanged: number;
  superseded: number;
}

export interface PollBronRuntime {
  alerts?: AlertStore;
  bronHealth?: BronHealthStore;
  bronPersistence: BronPersistence;
  close: () => Promise<void>;
  createConnector: (input: {
    bronId: BronId;
    bronSlug: SliceABronSlug;
    knownHashes: KnownHashStore;
    runKind: ConnectorRunKind;
  }) => Connector;
  curateStore: PostgresCurateStore;
  database: BronRuntimeDatabase;
  knownHashStore: KnownHashStore;
  /** RJC-397: missed-poll reconcile ports handed to every poll run. */
  lifecycle: LifecycleReconcilePorts;
  loadBaseline?: (bronId: string) => Promise<readonly RunBaselineSample[]>;
  objectStore: ObjectStore;
  observationRecorder: ObservationRecorder;
  runLifecycleStore: RunLifecycleStore;
  withSourceHealthTransaction: <T>(
    runOperation: (stores: {
      alerts: AlertStore;
      bronHealth: BronHealthStore;
      database: BronHealthDatabase;
    }) => Promise<T>
  ) => Promise<T>;
}

export const createPollBronRuntime = (
  databaseUrl: string,
  options: { pollRunStaleAfterMs?: number } = {}
): PollBronRuntime => {
  const client = createBronRuntimeClient(databaseUrl, options);
  // RJC-386: same selection factory the server uses, so the worker never
  // falls back to the filesystem store behind the server's back when S3 is
  // configured — they must share one durable backend for raw payload refs
  // written here to be readable back by the server.
  const rawObjectStore = createRawObjectStore({
    RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
    RAW_S3_ACCESS_KEY_ID: process.env.RAW_S3_ACCESS_KEY_ID,
    RAW_S3_BUCKET: process.env.RAW_S3_BUCKET,
    RAW_S3_ENDPOINT: process.env.RAW_S3_ENDPOINT,
    RAW_S3_REGION: process.env.RAW_S3_REGION,
    RAW_S3_SECRET_ACCESS_KEY: process.env.RAW_S3_SECRET_ACCESS_KEY,
  });
  const objectStore = rawObjectStore.store;

  // RJC-386: the worker is a separate deployment (Trigger.dev, its own env)
  // and the WRITER of raw payloads — the server's equivalent guard in
  // slice-a-registry.ts cannot see this process. Forgetting RAW_S3_BUCKET
  // here only would silently write to the worker-local filesystem while the
  // server reads S3, so every readback comes back null: the exact failure
  // this store exists to prevent. Same check, same spirit.
  if (
    process.env.NODE_ENV === "production" &&
    rawObjectStore.kind === "filesystem"
  ) {
    throw new Error(
      "Production startup refused: raw object store is the worker-local " +
        "filesystem backend, not S3. Set RAW_S3_BUCKET (and RAW_S3_ENDPOINT/" +
        "RAW_S3_REGION/credentials as needed) to select the durable S3 backend."
    );
  }

  return {
    alerts: new PostgresAlertStore(client.database),
    bronHealth: new PostgresBronHealthStore(client.database),
    bronPersistence: client.bronPersistence,
    close: client.close,
    createConnector: ({ bronId, bronSlug, knownHashes, runKind }) => {
      // Payload slugs are schema-validated, but the registry lookup stays guarded
      // so a stale task payload fails loudly instead of with a TypeError.
      const source: SourceDefinition | undefined = SOURCES[bronSlug];
      if (!source) {
        throw new Error(
          `Unknown bronSlug for connector routing: ${String(bronSlug)}`
        );
      }
      return source.createConnector({
        bronId,
        knownHashes,
        live: process.env[source.liveEnv] === "1",
        runKind,
      });
    },
    curateStore: new PostgresCurateStore(client.database),
    database: client.database,
    knownHashStore: client.knownHashStore,
    lifecycle: client.lifecycle,
    objectStore,
    observationRecorder: client.observationRecorder,
    runLifecycleStore: client.runLifecycleStore,
    withSourceHealthTransaction: (runOperation) =>
      client.database.transaction((transaction) =>
        runOperation({
          alerts: new PostgresAlertStore(transaction),
          bronHealth: new PostgresBronHealthStore(transaction),
          database: transaction,
        })
      ),
  };
};

const summarizeLifecycle = (
  lifecycle: ExecuteBronRunResult["lifecycle"]
): PollBronLifecycleSummary | null =>
  lifecycle && {
    incremented: lifecycle.incremented,
    reopened: lifecycle.reopened.length,
    reset: lifecycle.reset,
    skippedIncrementReason: lifecycle.skippedIncrementReason,
    staled: lifecycle.staled.length,
  };

export interface PollBronRunOptions {
  onAborted?: (pollResult: PollBronRunResult) => Promise<void> | void;
  /** CTP-490: bounds the connector run; see `ConnectorRunInput.signal`. */
  signal?: AbortSignal;
  /** Optional connector milestone observer; telemetry failures are isolated. */
  onProgress?: ExecuteBronRunInput["onProgress"];
  /** Called immediately before the first curation pass for this run. */
  onCurationStarted?: (pollResult: PollBronRunResult) => Promise<void> | void;
  /** Called after committed terminal curation work; failures are isolated. */
  onCurationProgress?: (pollResult: PollBronRunResult) => Promise<void> | void;
}

export const runPollBron = async (
  payload: PollBronPayload,
  runtime: PollBronRuntime,
  runKind: ConnectorRunKind = "poll",
  options: PollBronRunOptions = {}
): Promise<PollBronRunResult> => {
  // SAFETY: poll-bron payload schema validates UUID-shaped ids before the run starts.
  const bronId = payload.bronId as BronId;
  // SAFETY: poll-bron payload schema validates UUID-shaped ids before the run starts.
  const scrapeRunId = payload.scrapeRunId as ScrapeRunId;
  const connector = runtime.createConnector({
    bronId,
    bronSlug: payload.bronSlug,
    knownHashes: runtime.knownHashStore,
    runKind,
  });

  const result = await executeBronRun(runtime.bronPersistence, {
    bronId,
    bronSlug: payload.bronSlug,
    connector,
    lifecycle: runtime.lifecycle,
    objectStore: runtime.objectStore,
    observationRecorder: runtime.observationRecorder,
    onProgress: options.onProgress
      ? (milestone) =>
          reportTelemetryCallback(
            options.onProgress,
            milestone,
            {
              bronId,
              bronSlug: payload.bronSlug,
              scrapeRunId,
              telemetryPhase: "connector_progress",
            },
            options.signal
          )
      : undefined,
    retryPolicy: {
      initialDelayMs: 250,
      jitter: fullJitter,
      maxAttempts: 3,
      maxDelayMs: 5000,
      multiplier: 2,
    },
    runKind,
    runLifecycleStore: runtime.runLifecycleStore,
    scrapeRunId,
    signal: options.signal,
  });

  if (result.lifecycle && result.lifecycle.staled.length > 0) {
    const [updatedRun] = await runtime.database
      .update(scrapeRun)
      .set({ gesloten: result.lifecycle.staled.length })
      .where(
        and(
          eq(scrapeRun.id, scrapeRunId),
          eq(scrapeRun.bronId, bronId),
          eq(scrapeRun.status, "succeeded"),
          eq(scrapeRun.fenceToken, result.fenceToken)
        )
      )
      .returning({ id: scrapeRun.id });
    if (!updatedRun) {
      throw new RunOwnershipLostError();
    }
  }

  return {
    bronId,
    bronSlug: payload.bronSlug,
    completeness: result.completeness,
    fenceToken: result.fenceToken,
    lifecycle: summarizeLifecycle(result.lifecycle),
    metrics: result.metrics,
    scrapeRunId,
    status: "succeeded",
    writtenRecords: result.writtenRecords,
  };
};

export interface DrainSummary {
  drained: number;
  indexVersion: number | null;
}

/**
 * RJC-387: in "onbox" mode a separate projector process (next to Manticore)
 * drains the outbox instead — this worker never constructs a
 * ManticoreSearchEngine and never needs MANTICORE_URL, so ingest keeps
 * working even when this process has no route to a private Manticore.
 * Exported so the mode branch is unit-testable without a live Postgres.
 */
export const drainOrDeferToProjector = async (
  runtime: Pick<PollBronRuntime, "database">
): Promise<DrainSummary> => {
  if (readSearchProjectorMode() === "onbox") {
    return { drained: 0, indexVersion: null };
  }

  const versionStore = new PostgresSearchVersionStore(runtime.database);
  const engine = ManticoreSearchEngine.fromUrl(
    requireManticoreUrl(),
    versionStore
  );
  const drainResult = await drainPostgresOutbox({
    database: runtime.database,
    engine,
    loader: new PostgresSearchDocumentLoader(runtime.database),
    versionStore,
  });
  return {
    drained: drainResult.drained,
    indexVersion: drainResult.indexVersion,
  };
};

type BaselineLoad =
  | { baseline: readonly RunBaselineSample[]; ok: true }
  | { error: unknown; errorMessage: string; ok: false };

/**
 * Reads the bron's run baseline. A failed read is reported as such (and
 * logged) rather than as an empty baseline, so callers can tell "no history
 * yet" apart from "could not read history".
 */
const loadRunBaseline = async (
  pollResult: PollBronRunResult,
  runtime: PollBronRuntime,
  now: Date
): Promise<BaselineLoad> => {
  try {
    if (runtime.loadBaseline) {
      return {
        baseline: await runtime.loadBaseline(pollResult.bronId),
        ok: true,
      };
    }
    if (runtime.database) {
      return {
        baseline: await querySilenceBaselineSamples(
          runtime.database,
          pollResult.bronId,
          now,
          pollResult.scrapeRunId
        ),
        ok: true,
      };
    }
    return { baseline: [], ok: true };
  } catch (error) {
    const errorMessage = redactErrorMessage(describeCauseChain({ error }));
    process.stderr.write(
      `${JSON.stringify({
        bronId: pollResult.bronId,
        bronSlug: pollResult.bronSlug,
        errorMessage,
        errorName: errorNameOf({ error }),
        event: "run_baseline_read_failed",
        scrapeRunId: pollResult.scrapeRunId,
      })}\n`
    );
    return { error, errorMessage, ok: false };
  }
};

const upsertBronHealthForRun = async (
  bronHealth: BronHealthStore,
  run: Pick<PollBronRunResult, "bronId" | "fenceToken" | "scrapeRunId">,
  record: Parameters<BronHealthStore["upsert"]>[0]
): Promise<void> => {
  if (!bronHealth.upsertForRun) {
    throw new Error("Run-owned source health writes are unavailable");
  }
  const updated = await bronHealth.upsertForRun({
    bronId: run.bronId,
    fenceToken: run.fenceToken,
    record,
    runId: run.scrapeRunId,
  });
  if (!updated) {
    throw new RunOwnershipLostError();
  }
};

const recordSucceededRun = async (
  runtime: PollBronRuntime,
  bronId: BronId,
  now: Date,
  metrics: ConnectorRunMetrics,
  context: Pick<
    PollBronRunResult,
    "bronId" | "bronSlug" | "fenceToken" | "scrapeRunId"
  >
): Promise<void> => {
  await runtime.withSourceHealthTransaction(
    async ({ alerts: transactionAlerts, bronHealth: transactionHealth }) => {
      const existing = await transactionHealth.getByBronId(bronId);
      const openAlert = await transactionAlerts.findOpenByDedupeKey(
        buildSilenceDedupeKey(bronId)
      );
      const recovered = openAlert !== null && metrics.new + metrics.changed > 0;

      await upsertBronHealthForRun(transactionHealth, context, {
        bronId,
        circuitStatus: existing?.circuitStatus ?? "closed",
        lastRunAt: now,
        lastRunStatus: "succeeded",
        silenceAlertOpen: openAlert !== null && !recovered,
      });

      if (recovered) {
        await transactionAlerts.ack(openAlert.id, SILENCE_AUTO_RESOLVE_ACTOR);
        process.stderr.write(
          `${JSON.stringify({
            alertId: openAlert.id,
            bronId,
            bronSlug: context.bronSlug,
            event: "silence_alert_auto_resolved",
            scrapeRunId: context.scrapeRunId,
          })}\n`
        );
      }
    }
  );
};

const resolveBronNaam = async (
  pollResult: PollBronRunResult,
  runtime: PollBronRuntime
): Promise<string> => {
  try {
    const record = await runtime.bronPersistence.findById(pollResult.bronId);
    if (record?.naam) {
      return record.naam;
    }
  } catch {
    // fallback to bronSlug
  }
  return pollResult.bronSlug;
};

export class DiscoveryFloorBreachedError extends Error {
  readonly bronId: BronId;
  readonly code = DISCOVERY_FLOOR_BREACH_CODE;
  readonly evidence: DiscoveryFloorEvidence;

  constructor(
    bronId: BronId,
    bronNaam: string,
    evidence: DiscoveryFloorEvidence
  ) {
    super(buildDiscoveryFloorMessage(bronNaam, evidence));
    this.name = "DiscoveryFloorBreachedError";
    this.bronId = bronId;
    this.evidence = evidence;
  }
}

const writeDiscoveryFloorAlert = async (
  pollResult: PollBronRunResult,
  runtime: PollBronRuntime,
  input: {
    bronNaam: string;
    detectedAt: Date;
    evidence: DiscoveryFloorEvidence;
  }
): Promise<void> => {
  const dedupeKey = buildDiscoveryFloorDedupeKey(pollResult.bronId);

  await runtime.withSourceHealthTransaction(
    async ({ alerts: transactionAlerts, bronHealth: transactionHealth }) => {
      const existing = await transactionHealth.getByBronId(pollResult.bronId);
      await upsertBronHealthForRun(transactionHealth, pollResult, {
        bronId: pollResult.bronId,
        circuitStatus: existing?.circuitStatus ?? "closed",
        lastRunAt: input.detectedAt,
        lastRunStatus: "failed",
        silenceAlertOpen: existing?.silenceAlertOpen ?? false,
      });

      const open = await transactionAlerts.findOpenByDedupeKey(dedupeKey);
      if (!open) {
        await transactionAlerts.create({
          bronId: pollResult.bronId,
          dedupeKey,
          evidence: {
            baseline_samples: input.evidence.baselineSamples,
            baseline_window_days: input.evidence.baselineWindowDays,
            bron: pollResult.bronId,
            consecutive_zero_runs: input.evidence.consecutiveZeroRuns,
            current_found: input.evidence.found,
            detectietijd: input.detectedAt.toISOString(),
            last_non_zero_at: input.evidence.lastNonZeroAt,
            last_non_zero_found: input.evidence.lastNonZeroFound,
          },
          kind: DISCOVERY_FLOOR_ALERT_KIND,
          message: buildDiscoveryFloorMessage(input.bronNaam, input.evidence),
        });
      }
    }
  );
};

/**
 * Records a discovery-floor breach and hands the caller the error to raise.
 *
 * Returns null when the run is fine. It does not throw, because
 * `runBronIngestPipeline` has to drain the bron's curation backlog before the
 * poll fails: `curateScrapeRun` is the only curation driver and its `remaining`
 * covers every recoverable observation for the whole bron, so throwing here
 * would let one broken source stall curation for every request it already
 * staged, for as long as the breach lasts.
 *
 * Telling a floor breach from a connector that actually threw. Both land as
 * `DISCOVER_FAILED`, because `scrape_run_failure_tuple_check` whitelists the
 * tuple and a new code needs a migration. Three things separate them:
 *
 * - The poller logs `errorName: "DiscoveryFloorBreachedError"`. A connector
 *   failure logs the connector's own error name. See `failedSourceLog` in
 *   `poller/source-log.ts`.
 * - A floor breach leaves `scrape_run.fouten` at 0. The run completed; this
 *   guard rejected the result afterwards. A real discovery failure increments
 *   it.
 * - A floor breach writes a paired `bron.discovery_floor` alert. A connector
 *   failure writes none.
 */
export const recordDiscoveryFloorBreach = async (
  pollResult: PollBronRunResult,
  runtime: PollBronRuntime,
  runKind: ConnectorRunKind
): Promise<DiscoveryFloorBreachedError | null> => {
  if (runKind !== "poll") {
    return null;
  }

  const now = new Date();
  const load = await loadRunBaseline(pollResult, runtime, now);
  // An unreadable baseline yields "no-history": the floor never fails a run
  // on evidence it could not read.
  const verdict = evaluateDiscoveryFloor({
    baseline: load.ok ? load.baseline : [],
    detectedAt: now,
    metrics: pollResult.metrics,
  });

  if (verdict.outcome !== "breached") {
    return null;
  }

  const bronNaam = await resolveBronNaam(pollResult, runtime);

  // The honest run record goes first, so it lands even if the alert write
  // fails. `RunLifecycleStore.fail()` cannot record it: it matches on
  // `status = 'running'` and `runConnector` has already completed the run (see
  // `PostgresRunLifecycleStore.fail` in packages/db/src/bron-runtime.ts). The
  // row must still read `failed` so `querySilenceBaselineSamples` — which
  // selects only `status = 'succeeded'` — excludes it and tomorrow's baseline
  // is not poisoned by today's collapse. Matching on `status = 'succeeded'`
  // keeps this from stomping a row that is running or already failed.
  await runtime.withSourceHealthTransaction(
    async ({ bronHealth, database }) => {
      const existing = await bronHealth.getByBronId(pollResult.bronId);
      await upsertBronHealthForRun(bronHealth, pollResult, {
        bronId: pollResult.bronId,
        circuitStatus: existing?.circuitStatus ?? "closed",
        lastRunAt: now,
        lastRunStatus: "failed",
        silenceAlertOpen: existing?.silenceAlertOpen ?? false,
      });
      const [failedRun] = await database
        .update(scrapeRun)
        .set({
          failureClass: DISCOVERY_FLOOR_FAILURE.class,
          failureCode: DISCOVERY_FLOOR_FAILURE.code,
          failureMessage: DISCOVERY_FLOOR_FAILURE.message,
          failurePhase: DISCOVERY_FLOOR_FAILURE.phase,
          status: "failed",
        })
        .where(
          and(
            eq(scrapeRun.id, pollResult.scrapeRunId),
            eq(scrapeRun.bronId, pollResult.bronId),
            eq(scrapeRun.fenceToken, pollResult.fenceToken),
            eq(scrapeRun.status, "succeeded")
          )
        )
        .returning({ id: scrapeRun.id });
      if (!failedRun) {
        throw new RunOwnershipLostError();
      }
    }
  );

  await writeDiscoveryFloorAlert(pollResult, runtime, {
    bronNaam,
    detectedAt: now,
    evidence: verdict.evidence,
  });

  return new DiscoveryFloorBreachedError(
    pollResult.bronId,
    bronNaam,
    verdict.evidence
  );
};

export interface SilenceOutcome {
  alertId?: string;
  /**
   * Redacted cause chain of a failed baseline read. Present only when the
   * read threw; silence was then not evaluated for this poll, because an
   * empty baseline would read as "no history yet" and never alert.
   */
  baselineReadError?: string;
  created: boolean;
}

export const handleSilenceAndHealth = async (
  pollResult: PollBronRunResult,
  runtime: PollBronRuntime,
  runKind: ConnectorRunKind
): Promise<SilenceOutcome | null> => {
  if (runKind !== "poll") {
    return null;
  }

  const now = new Date();

  const load = await loadRunBaseline(pollResult, runtime, now);
  if (!load.ok) {
    await recordSucceededRun(
      runtime,
      pollResult.bronId,
      now,
      pollResult.metrics,
      pollResult
    );
    return { baselineReadError: load.errorMessage, created: false };
  }

  const { baseline } = load;
  const lastSuccessAt = baseline.length > 0 ? (baseline[0]?.at ?? null) : null;
  const bronNaam = await resolveBronNaam(pollResult, runtime);

  // CTP-653: resolve the delivery channel BEFORE the transaction — a
  // malformed URL fails the run loudly — but deliver only AFTER commit
  // (below). A webhook POST inside `withSourceHealthTransaction` would run
  // under the source-health row lock and could page the operator about an
  // alert row that rolled back.
  const alertWebhookUrl = readAlertWebhookUrl();

  const result = await runtime.withSourceHealthTransaction(
    async ({ alerts: transactionAlerts, bronHealth: transactionHealth }) => {
      // Hold the source health row lock across the ownership gate, alert
      // mutation, and final health write. A successor waits for this
      // transaction, so it cannot race a stale alert side effect.
      const existing = await transactionHealth.getByBronId(pollResult.bronId);
      await upsertBronHealthForRun(transactionHealth, pollResult, {
        bronId: pollResult.bronId,
        circuitStatus: existing?.circuitStatus ?? "closed",
        lastRunAt: now,
        lastRunStatus: "succeeded",
        silenceAlertOpen: existing?.silenceAlertOpen ?? false,
      });

      const writer = createSilenceAlertWriter({
        alerts: transactionAlerts,
        bronHealth: transactionHealth,
        upsertBronHealth: (input) =>
          upsertBronHealthForRun(transactionHealth, pollResult, {
            ...input,
            circuitStatus: existing?.circuitStatus ?? "closed",
          }),
      });
      return observeConnectorRunSilence({
        baseline,
        bronId: pollResult.bronId,
        bronNaam,
        detectedAt: now,
        httpStatus: 200,
        lastSuccessAt,
        metrics: pollResult.metrics,
        writer,
      });
    }
  );

  if (!result.event) {
    await recordSucceededRun(
      runtime,
      pollResult.bronId,
      now,
      pollResult.metrics,
      pollResult
    );
  }

  // Post-commit delivery: the transaction resolved, so the alert row exists.
  // Re-read it through the non-transactional store — never deliver the
  // in-transaction snapshot.
  if (result.created && result.alertId) {
    const alert = await runtime.alerts?.getById(result.alertId);
    if (alert) {
      const sink = alertWebhookUrl
        ? createWebhookAlertSink({ url: alertWebhookUrl })
        : createStderrAlertSink();
      await deliverOpenedAlert(sink, alert);
    } else {
      process.stderr.write(
        `${JSON.stringify({
          alertId: result.alertId,
          bronId: pollResult.bronId,
          bronSlug: pollResult.bronSlug,
          event: "alert_unrouted",
        })}\n`
      );
    }
  }

  return {
    alertId: result.alertId,
    created: result.created,
  };
};

export const runBronIngestPipeline = async (
  payload: PollBronPayload,
  runtime: PollBronRuntime,
  runKind: ConnectorRunKind = "poll",
  options: PollBronRunOptions = {}
): Promise<BronIngestPipelineResult> => {
  const [persistedRun] = await runtime.database
    .select({
      bronId: scrapeRun.bronId,
      changed: scrapeRun.gewijzigd,
      error: scrapeRun.fouten,
      fenceToken: scrapeRun.fenceToken,
      found: scrapeRun.aantalGevonden,
      new: scrapeRun.nieuw,
      rejected: scrapeRun.rejected,
      runKind: scrapeRun.runKind,
      status: scrapeRun.status,
    })
    .from(scrapeRun)
    .where(eq(scrapeRun.id, payload.scrapeRunId))
    .limit(1);
  if (
    persistedRun &&
    (persistedRun.bronId !== payload.bronId || persistedRun.runKind !== runKind)
  ) {
    throw new Error("Cannot resume mismatched scrape run");
  }
  const source = SOURCES[payload.bronSlug];
  if (!source || source.bronId !== payload.bronId) {
    throw new Error("Poll source slug does not match bronId");
  }
  const unchangedRows =
    persistedRun?.status === "succeeded"
      ? await runtime.database
          .select({ id: aanvraagObservation.id })
          .from(aanvraagObservation)
          .where(
            and(
              eq(aanvraagObservation.scrapeRunId, payload.scrapeRunId),
              eq(aanvraagObservation.outcome, "unchanged")
            )
          )
      : [];
  const persistedUnchanged = unchangedRows.length;
  const pollResult: PollBronRunResult =
    persistedRun?.status === "succeeded"
      ? {
          // SAFETY: poll-bron payload validation requires UUID-shaped bron ids.
          bronId: payload.bronId as BronId,
          bronSlug: payload.bronSlug,
          completeness: null,
          fenceToken: persistedRun.fenceToken,
          lifecycle: null,
          metrics: {
            changed: persistedRun.changed,
            error: persistedRun.error,
            found: persistedRun.found,
            new: persistedRun.new,
            rejected: persistedRun.rejected,
            unchanged: persistedUnchanged,
          },
          // SAFETY: poll-bron payload validation requires UUID-shaped run ids.
          scrapeRunId: payload.scrapeRunId as ScrapeRunId,
          status: "succeeded",
          writtenRecords: persistedRun.new + persistedRun.changed,
        }
      : await runPollBron(payload, runtime, runKind, options);
  if (
    pollResult.completeness?.complete === false &&
    pollResult.completeness.reason === "aborted"
  ) {
    await options.onAborted?.(pollResult);
    throw (
      options.signal?.reason ??
      new DOMException("Source run aborted", "AbortError")
    );
  }
  return withAbortFinalization(
    options.signal,
    async () => {
      await options.onAborted?.(pollResult);
    },
    async () => {
      const floorBreach = await recordDiscoveryFloorBreach(
        pollResult,
        runtime,
        runKind
      );
      // A breached run is already recorded as failed with its own alert.
      // Running the silence detector on top would overwrite that health row
      // back to `succeeded` and raise a second alert for one event.
      const silenceAlert = floorBreach
        ? null
        : await handleSilenceAndHealth(pollResult, runtime, runKind);
      await reportTelemetryCallback(
        options.onCurationStarted,
        pollResult,
        {
          bronId: pollResult.bronId,
          bronSlug: pollResult.bronSlug,
          scrapeRunId: pollResult.scrapeRunId,
          telemetryPhase: "curation_started",
        },
        options.signal
      );
      const curateResult = await curateScrapeRun({
        bronId: pollResult.bronId,
        bronSlug: pollResult.bronSlug,
        database: runtime.database,
        objectStore: runtime.objectStore,
        onProgress: options.onCurationProgress
          ? () =>
              reportTelemetryCallback(
                options.onCurationProgress,
                pollResult,
                {
                  bronId: pollResult.bronId,
                  bronSlug: pollResult.bronSlug,
                  scrapeRunId: pollResult.scrapeRunId,
                  telemetryPhase: "curation_progress",
                },
                options.signal
              )
          : undefined,
        scrapeRunId: pollResult.scrapeRunId,
        signal: options.signal,
      });

      const drainSummary = await drainOrDeferToProjector(runtime);

      // After the backlog drains, not before. The breaching run staged
      // nothing of its own, so this costs the guard no detection latency.
      if (floorBreach) {
        throw floorBreach;
      }

      return {
        ...pollResult,
        alreadyCommitted: curateResult.alreadyCommitted,
        attemptedObservationIds: curateResult.attemptedObservationIds,
        blockedOrdering: curateResult.blockedOrdering,
        curated: curateResult.curated,
        drained: drainSummary.drained,
        failed: curateResult.failed,
        indexVersion: drainSummary.indexVersion,
        pending: curateResult.pending,
        quarantined: curateResult.quarantined,
        remaining: curateResult.remaining,
        silenceAlert,
        superseded: curateResult.superseded,
        unchanged: curateResult.unchanged,
      };
    }
  );
};

export { requireDatabaseUrl, requireManticoreUrl } from "./poll-bron-env";
