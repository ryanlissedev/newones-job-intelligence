import { env } from "@ji/env/database";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import migrationJournal from "./migrations/meta/_journal.json";
import type { DbReadinessResult } from "./readiness";
import {
  evaluateDbReadiness,
  resolveExpectedMigrationTimestamp,
} from "./readiness";
import * as schema from "./schema";

export {
  ABANDONED_RUN_FAILURE,
  abandonStaleRuns,
  type AbandonStaleRunsDatabase,
  type AbandonStaleRunsOptions,
} from "./abandon-stale-runs";
export {
  emitPgStatStatementRecords,
  readPgStatStatementSummaries,
  timeSqlQuery,
} from "./instrumentation";
export type {
  PgStatStatementSummary,
  TimedSqlOptions,
} from "./instrumentation";
export {
  PostgresAlertStore,
  PostgresBronHealthStore,
  querySilenceBaselineSamples,
  type AlertDatabase,
  type BronHealthDatabase,
} from "./bron-health-stores";
export {
  PostgresExportEffectStore,
  PostgresExportAttemptStore,
  PostgresExternalIdCrosswalkStore,
  PostgresExternalReceiptStore,
  type ExportDatabase,
} from "./export-stores";
export {
  PostgresQuerySnapshotStore,
  type ReadPathDatabase,
} from "./read-path-stores";
export {
  PollerHealthTelemetry,
  PollerHealthTelemetryLive,
  PostgresPollerHealthTelemetryStore,
  type PollerHealthTelemetryDatabase,
  type PollerHealthTelemetryEffectService,
  type PollerHealthTelemetryExecutor,
  type PollerHealthTelemetryStore,
  type PollerHealthTelemetryTransaction,
  type PollerRuntimeClaim,
  type PollerRuntimeClaimInput,
  type PollerRuntimeRecord,
  type PollerRuntimeStatus,
  type RuntimeObservationInput,
  type SourceFinalizeInput,
  type SourceOwnershipInput,
  type SourcePhaseInput,
  type SourceProgressInput,
  type SourceProgressPhase,
  type SourceRunOutcome,
} from "./poller-health-telemetry-store";
export {
  PostgresApprovalStore,
  PostgresAuditStore,
  PostgresMarkeringStore,
  PostgresSavedSearchStore,
  type UserWriteDatabase,
} from "./user-write-stores";
export {
  PostgresBackfillProvenanceStore,
  PostgresBackfillRunStore,
  seedMotianV1Bronnen,
  type BackfillDatabase,
  type MotianV1BronSeed,
} from "./backfill-stores";
export {
  PostgresCurateStore,
  type PostgresCurateDatabase,
  type PostgresCurateTransaction,
} from "./postgres-curate-store";
export {
  PROJECTION_REPAIR_EVENT_TYPE,
  PROJECTION_REPAIR_DEFAULT_PAGE_SIZE,
  PROJECTION_REPAIR_DEFAULT_SAMPLE_LIMIT,
  ProjectionRepairGenerationChangedError,
  ProjectionRepairInventoryCompletenessError,
  ProjectionRepairInventorySafetyError,
  ProjectionRepairPhysicalCorruptionError,
  ProjectionRepairSchemaMismatchError,
  manticoreIdsForBoundedLookup,
  reconcileProjection,
  type ProjectionDivergence,
  type ProjectionDivergenceReason,
  type ProjectionPhysicalCorruption,
  type ProjectionPhysicalCorruptionReason,
  type ReconcileProjectionInput,
  type ReconcileProjectionResult,
  type SearchProjectionInventoryPort,
  type SearchProjectionInventoryRecord,
} from "./projection-repair";
export {
  SEARCH_REINDEX_DEFAULT_PAGE_SIZE,
  SEARCH_REINDEX_EVENT_TYPE,
  SEARCH_REINDEX_PENDING_PREFIX,
  SearchReindexDeadLetterError,
  SearchReindexGenerationChangedError,
  SearchReindexPendingGenerationError,
  runSearchReindex,
  searchReindexEventId,
  type RunSearchReindexInput,
  type RunSearchReindexResult,
  type SearchReindexProgress,
} from "./search-reindex";
export {
  resolveNeonV1BackfillSource,
  runMotianV1Backfill,
  runMotianV1BackfillInMemory,
  type RunMotianV1BackfillOptions,
} from "./backfill-runner";
export {
  DEFAULT_MINIMUM_TEST_IMPORT_OBSERVATIONS,
  PostgresBronPersistence,
  PostgresObservationRecorder,
  PostgresRunStore,
  progressValues,
  toRunProgress,
  type ActivateBronInput,
  type BronRuntimeDatabase,
} from "./bron-runtime";
export { scrapeRun } from "./schema/curated";
export {
  PostgresAanvraagStore,
  PostgresRawPayloadStore,
  PostgresSearchDocumentLoader,
} from "./aanvraag-stores";
export {
  type BronRunStatsDatabase,
  PostgresBronRunStatsReader,
} from "./bron-run-stats";
export {
  type BronOverlapDatabase,
  PostgresBronOverlapReader,
} from "./bron-overlap";
export {
  createPostgresMartsReader,
  guardMartsSql,
  MARTS_DEFAULT_ROW_CAP,
  MARTS_DEFAULT_STATEMENT_TIMEOUT_MS,
  type MartsSqlGuardResult,
  type PostgresMartsReaderHandle,
  type PostgresMartsReaderOptions,
} from "./marts-reader";
export { PostgresKnownHashStore } from "./known-hash-store";
export {
  PostgresEnrichmentStore,
  type AanvraagEnrichmentRow,
  type EnrichmentDatabase,
  type IncompleteAanvraagCandidate,
  type PendingCuratedApplyCandidate,
} from "./enrichment-store";
export {
  createPostgresLifecyclePorts,
  PostgresMissedPollsStore,
  type MissedPollsDatabase,
} from "./missed-polls-store";
export {
  drainPostgresOutbox,
  listDeadLetteredOutboxEvents,
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_DEFAULT_LEASE_SECONDS,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  readOutboxLag,
  requeueDeadLetteredOutboxEvents,
  summarizeOutboxFailures,
  type DeadLetteredOutboxEvent,
  type DrainPostgresOutboxInput,
  type DrainPostgresOutboxResult,
  type OutboxFailureGroup,
  type OutboxLag,
} from "./outbox-drain";
export {
  PostgresSearchVersionStore,
  type PostgresSearchVersionStoreOptions,
  type SearchVersionDatabase,
} from "./search-version-store";
export {
  PostgresSearchProjectorRuntimeStore,
  type PostgresSearchProjectorRuntimeStoreOptions,
  type SearchProjectorRuntimeDatabase,
  type SearchProjectorRuntimeInput,
  type SearchProjectorRuntimeRecord,
} from "./search-projector-runtime-store";
export {
  createBronRuntimeClient,
  type BronRuntimeClient,
} from "./runtime-client";
export {
  DbStoreCancelFault,
  DbStoreDependencyFault,
  DbStoreNotFoundFault,
  DbStoreValidationFault,
  fromStorePromise,
  isDbStoreFault,
  mapUnknownToDbStoreFault,
  runDbStorePromise,
  type DbStoreFault,
  type DbStoreFaultCategory,
  type RunDbStorePromiseOptions,
} from "./effect";
export {
  aanvraagGetByIdEffect,
  alertGetByIdEffect,
  bronHealthGetByBronIdEffect,
  knownHashGetEffect,
  missedPollsMarkSeenEffect,
  querySnapshotGetByIdEffect,
  rawPayloadGetByRefEffect,
  savedSearchGetByIdEffect,
  scrapeRunGetByIdEffect,
  searchVersionReadEffect,
  applyDbStoreEffectCanary,
  wrapAanvraagStoreEffect,
  wrapAlertStoreEffect,
  wrapBronHealthStoreEffect,
  wrapKnownHashStoreEffect,
  wrapMissedPollsStoreEffect,
  wrapQuerySnapshotStoreEffect,
  type DbEffectCanaryStores,
  wrapRawPayloadStoreEffect,
  wrapSavedSearchStoreEffect,
  wrapScrapeRunReaderEffect,
  wrapSearchVersionStoreEffect,
  type WrapStoreEffectOptions,
} from "./store-effects";

const EXPECTED_MIGRATION_TIMESTAMP =
  resolveExpectedMigrationTimestamp(migrationJournal);

const sqlClient = postgres(env.DATABASE_URL, {
  connect_timeout: 5,
  idle_timeout: 20,
  max: 10,
  max_lifetime: 30 * 60,
});

let closePromise: Promise<void> | undefined;

export const db = drizzle(sqlClient, { schema });

export const getDbReadiness = (): Promise<DbReadinessResult> =>
  evaluateDbReadiness(EXPECTED_MIGRATION_TIMESTAMP, async () => {
    const migrations = await sqlClient<[{ createdAt: string }]>`
      SELECT created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 1
    `;

    return migrations[0]?.createdAt ?? null;
  });

export const closeDb = async (): Promise<void> => {
  closePromise ??= sqlClient.end({ timeout: 5 });
  await closePromise;
};

export {
  PostgresScrapeRunReader,
  type ScrapeRunDatabase,
} from "./scrape-run-reader";

export { abortableSleep } from "./abortable-sleep";
export {
  heartbeatAgeMs,
  isHeartbeatFresh,
  MAX_HEARTBEAT_AGE_MS,
  reportHeartbeatCheck,
  resolveHeartbeatFilePath,
  writeHeartbeat,
} from "./process-heartbeat";
export {
  acquireAdvisoryLock,
  LockLostError,
  waitForAdvisoryLock,
  type AdvisoryLockHandle,
  type WaitForAdvisoryLockOptions,
} from "./process-lock";
export {
  layerPostgresPersistedQueueStore,
  makePostgresPersistedQueueStore,
  type PersistedQueueStorePostgres,
  type PersistedQueueStorePostgresOptions,
} from "./persisted-queue-store";
