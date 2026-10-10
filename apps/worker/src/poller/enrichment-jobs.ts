import type { BronRuntimeDatabase } from "@ji/db/bron-runtime";
import { makePostgresPersistedQueueStore } from "@ji/db/persisted-queue-store";
import type {
  PersistedQueueStorePostgres,
  PersistedQueueStorePostgresOptions,
} from "@ji/db/persisted-queue-store";
import { sql as drizzleSql } from "drizzle-orm";
import { Effect, Exit, Schema, Scope } from "effect";
import {
  layer as persistedQueueLayer,
  make as makePersistedQueue,
  PersistedQueueError,
  PersistedQueueStore,
} from "effect/unstable/persistence/PersistedQueue";
import type { PersistedQueue } from "effect/unstable/persistence/PersistedQueue";

import {
  mapUnknownToWorkerFault,
  WorkerCancelFault,
  WorkerDependencyFault,
  WorkerValidationFault,
} from "../effect/faults";
import type { WorkerFault } from "../effect/faults";
import { fromWorkerPromise } from "../effect/from-promise";
import { runWorkerPromise } from "../effect/run";

/**
 * Durable enrichment jobs (CTP-626 / W2-N2).
 *
 * One job enriches one incomplete aanvraag. The element carries the
 * `updated_at` the candidate was selected with; the store's
 * `applyEnrichmentAtomically` re-reads the row under lock and only writes
 * when that token still matches, so a replay after commit-before-ack finds a
 * newer `updated_at` and acks without a second write or outbox row. The
 * element has no `bronId` key on purpose: `durable_job_open_bron_uidx` is a
 * bron-ingest rule and must not serialise enrichment per bron.
 */

export const ENRICHMENT_QUEUE = "aanvraag-enrichment";

export const ENRICHMENT_JOB_MAX_ATTEMPTS = 3;

export const enrichmentJobSchema = Schema.Struct({
  aanvraagId: Schema.String.check(Schema.isUUID()),
  /** `aanvraag.updated_at` (ISO) as read when the candidate was selected. */
  expectedUpdatedAt: Schema.String,
});

export type EnrichmentJob = typeof enrichmentJobSchema.Type;

/** Same candidate state re-offered is the same job. */
export const enrichmentJobId = (job: EnrichmentJob): string =>
  `${job.aanvraagId}:${job.expectedUpdatedAt}`;

export interface EnrichmentQueue {
  readonly queue: PersistedQueue<EnrichmentJob>;
  readonly store: PersistedQueueStorePostgres;
  /** Ends the queue's SQL client and stops its lease-refresh fiber. */
  readonly close: () => Promise<void>;
}

export const createEnrichmentQueue = async (
  databaseUrl: string,
  options: PersistedQueueStorePostgresOptions = {}
): Promise<EnrichmentQueue> => {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const store = await Effect.runPromise(
      makePostgresPersistedQueueStore(databaseUrl, options).pipe(
        Effect.provideService(Scope.Scope, scope)
      )
    );
    const queue = await Effect.runPromise(
      makePersistedQueue({
        name: ENRICHMENT_QUEUE,
        schema: enrichmentJobSchema,
      }).pipe(
        Effect.provide(persistedQueueLayer),
        Effect.provideService(PersistedQueueStore, store)
      )
    );
    return {
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      queue,
      store,
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => null);
    throw error;
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-boundary mapper for the queue/pipeline error union
const toWorkerFault = (error: unknown): WorkerFault => {
  if (error instanceof PersistedQueueError) {
    return new WorkerDependencyFault({ cause: error, message: error.message });
  }
  if (error instanceof Schema.SchemaError) {
    return new WorkerValidationFault({ cause: error, message: error.message });
  }
  return mapUnknownToWorkerFault(error);
};

export const offerEnrichmentJob = (
  queue: Pick<EnrichmentQueue["queue"], "offer">,
  job: EnrichmentJob
): Promise<string> =>
  runWorkerPromise(
    queue
      .offer(job, { id: enrichmentJobId(job) })
      .pipe(Effect.mapError(toWorkerFault))
  );

/**
 * Rows a `take` could claim right now: open, under the attempt cap, and not
 * held by a live lease. The drain reads this before every take so it stops
 * on an empty queue instead of blocking on the store's poll loop.
 */
export const countClaimableEnrichmentJobs = async (
  database: Pick<BronRuntimeDatabase, "execute">,
  maxAttempts: number,
  lockExpirationSeconds: number
): Promise<number> => {
  const rows = await database.execute<{ claimable: string | number }>(
    drizzleSql`
      SELECT count(*) AS claimable
      FROM curated.durable_job
      WHERE queue_name = ${ENRICHMENT_QUEUE}
      AND completed = false
      AND attempts < ${maxAttempts}
      AND (
        acquired_at IS NULL
        OR acquired_at < now() - (${lockExpirationSeconds} * interval '1 second')
      )
    `
  );
  return Number(rows[0]?.claimable ?? 0);
};

export interface DrainEnrichmentQueueOptions {
  readonly database: Pick<BronRuntimeDatabase, "execute">;
  readonly queue: Pick<EnrichmentQueue["queue"], "take">;
  readonly maxAttempts: number;
  /** Upper bound on jobs handled by this drain; the rest wait for the next run. */
  readonly maxJobs: number;
  /** Must match the store's `lockExpiration` so the pre-count sees the same rows as the claim. */
  readonly lockExpirationSeconds: number;
  /** One job's work; must reject for the attempt to count and retry. */
  readonly processJob: (job: EnrichmentJob, attempts: number) => Promise<void>;
  readonly onJobError?: (error: Error) => void;
  readonly signal: AbortSignal;
}

export interface DrainEnrichmentQueueSummary {
  readonly failed: number;
  readonly processed: number;
}

/**
 * Takes jobs one at a time until the queue has nothing claimable or
 * `maxJobs` were handled. A failing job is accounted for by the store's
 * finalizer (attempts + 1, claim released) and counts as `failed` here; the
 * drain moves on to the next row.
 */
export const drainEnrichmentQueue = async (
  options: DrainEnrichmentQueueOptions
): Promise<DrainEnrichmentQueueSummary> => {
  let processed = 0;
  let failed = 0;
  while (!options.signal.aborted && processed + failed < options.maxJobs) {
    // oxlint-disable-next-line no-await-in-loop -- one job at a time is the single-executor contract
    const claimable = await countClaimableEnrichmentJobs(
      options.database,
      options.maxAttempts,
      options.lockExpirationSeconds
    );
    if (claimable === 0) {
      break;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one job at a time is the single-executor contract
      await runWorkerPromise(
        options.queue
          .take(
            (job, metadata) =>
              fromWorkerPromise(() =>
                options.processJob(job, metadata.attempts)
              ),
            { maxAttempts: options.maxAttempts }
          )
          .pipe(Effect.mapError(toWorkerFault)),
        { signal: options.signal }
      );
      processed += 1;
    } catch (error) {
      if (options.signal.aborted || error instanceof WorkerCancelFault) {
        break;
      }
      failed += 1;
      options.onJobError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
  return { failed, processed };
};
