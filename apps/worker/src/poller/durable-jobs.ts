import { SUPPORTED_BRON_SLUGS } from "@ji/application/sources";
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
import type { SliceABronSlug } from "../slice-a-bronnen";

/**
 * Durable bron-ingest dispatch (CTP-622 / W2-Q2).
 *
 * A due bron can be handed to `curated.durable_job` instead of being run
 * inline: the scheduler offers one job whose identity IS the run's
 * scrapeRunId, and this module's consumer takes it and drives the existing
 * `runBronIngestPipeline`. The queue gives the dispatch durability; the
 * pipeline's own scrape_run fencing gives the domain commit idempotency —
 * a replayed job resumes a `running` run or replays a `succeeded` one, so
 * a crash anywhere produces exactly one domain result per job.
 */

export const BRON_INGEST_QUEUE = "bron-ingest";

export const DURABLE_JOB_MAX_ATTEMPTS = 5;

export const bronIngestJobSchema = Schema.Struct({
  bronId: Schema.String.check(Schema.isUUID()),
  bronSlug: Schema.String,
  scrapeRunId: Schema.String.check(Schema.isUUID()),
});

export type BronIngestJob = typeof bronIngestJobSchema.Type;

export interface BronIngestQueue {
  readonly queue: PersistedQueue<BronIngestJob>;
  readonly store: PersistedQueueStorePostgres;
  /** Ends the queue's SQL client and stops its lease-refresh fiber. */
  readonly close: () => Promise<void>;
}

/**
 * Builds the queue over a process-lifetime scope: the store's lease-refresh
 * fiber and SQL client live until `close()` runs `Scope.close` (poller
 * shutdown). No DDL is executed anywhere on this path — the table comes from
 * migration 0029 via the operator lane.
 */
export const createBronIngestQueue = async (
  databaseUrl: string,
  options: PersistedQueueStorePostgresOptions = {}
): Promise<BronIngestQueue> => {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const store = await Effect.runPromise(
      makePostgresPersistedQueueStore(databaseUrl, options).pipe(
        Effect.provideService(Scope.Scope, scope)
      )
    );
    const queue = await Effect.runPromise(
      makePersistedQueue({
        name: BRON_INGEST_QUEUE,
        schema: bronIngestJobSchema,
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
    // Best-effort close: the original error is what the caller needs.
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

/**
 * The replayable dispatcher half: `id = scrapeRunId` makes re-offering the
 * same job a no-op, and `durable_job_open_bron_uidx` makes a second offer of
 * a bron that still has an open job a no-op as well.
 */
export const offerBronIngestJob = (
  queue: Pick<BronIngestQueue["queue"], "offer">,
  job: BronIngestJob
): Promise<string> =>
  runWorkerPromise(
    queue
      .offer(job, { id: job.scrapeRunId })
      .pipe(Effect.mapError(toWorkerFault))
  );

export interface OpenBronJob {
  readonly id: string;
  readonly scrapeRunId: string | null;
}

/**
 * Pre-offer visibility check for an honest dispatch log: the unique index
 * decides correctness, this only decides what the operator reads. A racing
 * second writer can still dedupe inside the INSERT — that is the index's job.
 */
export const findOpenBronJob = async (
  database: Pick<BronRuntimeDatabase, "execute">,
  bronId: string
): Promise<OpenBronJob | null> => {
  const rows = await database.execute<{
    id: string;
    scrapeRunId: string | null;
  }>(
    drizzleSql`
      SELECT id, element ->> 'scrapeRunId' AS "scrapeRunId"
      FROM curated.durable_job
      WHERE queue_name = ${BRON_INGEST_QUEUE}
      AND completed = false
      AND element ->> 'bronId' = ${bronId}
      ORDER BY sequence ASC
      LIMIT 1
    `
  );
  return rows[0] ?? null;
};

export interface DurableBronJobConsumerOptions {
  readonly queue: Pick<BronIngestQueue["queue"], "take">;
  readonly maxAttempts: number;
  /** One job's domain work; must reject for the attempt to count and retry. */
  readonly processJob: (job: BronIngestJob, attempts: number) => Promise<void>;
  /** Called after every failed attempt with the row's last_failure context. */
  readonly onJobError?: (error: Error, job: BronIngestJob | null) => void;
  readonly signal: AbortSignal;
}

/**
 * The take side of the durable path. One job at a time — a bron's politeness
 * budget lives inside the run itself, and one executor per bron is what the
 * cutover contract requires. The loop only ends on shutdown: a failed job is
 * already accounted for by the store's scope finalizer (attempts + 1 and the
 * claim released), so the consumer just takes again.
 *
 * Between offer and ack the job survives any worker exit:
 * - kill before commit: the claim lease expires; a successor takes the same
 *   job and resumes the same scrapeRunId.
 * - kill after commit before ack: the replayed take finds the scrape_run
 *   `succeeded` and the pipeline replays instead of re-running.
 * - DB outage at ack: the finalizer's bounded retry then the lease expiry
 *   both route the row back to a live worker.
 * - connector failure recorded as `failed`: the retake resumes the same
 *   scrapeRunId from its checkpoint (`store.start` reopens a failed row,
 *   CTP-643) so only the failed page is refetched; a run `abandonStaleRuns`
 *   failed resumes the same way.
 * - exhausted attempts: the row closes (`completed = true`, `last_failure`
 *   kept) so the open-bron index frees the bron for the next due evaluation;
 *   `completed AND last_failure IS NOT NULL` is the dead letter.
 */
export const runDurableBronJobConsumer = async (
  options: DurableBronJobConsumerOptions
): Promise<void> => {
  while (!options.signal.aborted) {
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
    } catch (error) {
      if (options.signal.aborted || error instanceof WorkerCancelFault) {
        return;
      }
      options.onJobError?.(
        error instanceof Error ? error : new Error(String(error)),
        null
      );
    }
  }
};

/**
 * Parses `POLLER_DURABLE_BRONNEN`: a comma-separated list of source slugs
 * that dispatch through the durable queue instead of the inline poll path.
 * Unknown slugs fail closed at startup — a typo must not silently poll a
 * source through a path the operator did not mean to enable.
 */
export const resolveDurableBronnen = (
  raw?: string | undefined
): ReadonlySet<SliceABronSlug> => {
  const slugs = (raw ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
  const resolved = new Set<SliceABronSlug>();
  for (const slug of slugs) {
    const match = SUPPORTED_BRON_SLUGS.find((supported) => supported === slug);
    if (match === undefined) {
      throw new Error(
        `POLLER_DURABLE_BRONNEN contains unknown bron slug: ${slug}`
      );
    }
    resolved.add(match);
  }
  return resolved;
};

/**
 * Startup probe: the queue table is operator-lane DDL, so a worker can be
 * deployed before migration 0029 lands. Missing table + enabled durable
 * bronnen is a startup failure (fail closed); missing table + none enabled
 * just skips the consumer (nothing could ever have been queued).
 */
export const durableJobTablePresent = async (
  database: Pick<BronRuntimeDatabase, "execute">
): Promise<boolean> => {
  const rows = await database.execute<{ present: string | null }>(
    drizzleSql`SELECT to_regclass('curated.durable_job')::text AS present`
  );
  return rows[0]?.present === "curated.durable_job";
};
