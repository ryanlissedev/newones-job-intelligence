import {
  coalesceOutboxEvents,
  mutationId,
  planOutboxBatch,
  SEARCH_SCHEMA_HASH,
  SearchIndexSchemaMismatchError,
} from "@ji/search";
import type {
  BulkSearchDocumentLoader,
  OutboxBatchPlan,
  OutboxEventRecord,
  SearchEngine,
  SearchIndexBatchResult,
  SearchVersion,
  SearchVersionCheckpoint,
  SearchVersionStore,
} from "@ji/search";
import {
  aliasedTable,
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import { outboxEvent, searchProjectionState } from "./schema/curated";

/** Rows claimed per drain; one Manticore /bulk per drain in the common case. */
export const OUTBOX_DEFAULT_BATCH_SIZE = 1000;
/**
 * How long a claim shields rows from other drains. A drain that dies
 * mid-batch leaves its rows claimed until this expires, after which any
 * drain re-claims them and re-applies (idempotent writes). Sized for the
 * worst-case batch: loading 1000 rows and one bulk request take seconds.
 *
 * Known hazard, deliberately unsolved: a drain stalled past the lease that
 * loaded a document, then lands its /bulk AFTER a sibling drain re-claimed
 * the row and wrote a newer version, regresses that document in the index
 * until a content-CHANGING event or a rebuild — a same-content event is
 * skipped by the projection hash, so this does not self-heal on the next
 * event. Closing it needs a fencing token Manticore
 * cannot enforce on replace. The Postgres side IS fenced: every post-claim
 * UPDATE carries the drain's claim_token, so the stalled drain's late
 * ack/blame/release touches nothing (counted as lostLease) and the state
 * row is compare-and-set on applied_sequence.
 */
export const OUTBOX_DEFAULT_LEASE_SECONDS = 120;
/** Attempts before a row is dead-lettered (excluded from claims until requeued). */
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 5;
/** Upper bound on one listing of dead letters. */
const DEAD_LETTER_LIST_LIMIT = 100;

export interface DrainPostgresOutboxInput {
  /** Rows claimed per drain (default OUTBOX_DEFAULT_BATCH_SIZE). */
  batchSize?: number;
  database: BronRuntimeDatabase;
  engine: SearchEngine;
  /** Schema hash the running code was built for. */
  expectedSchemaHash?: string;
  /** Claim lease in seconds (default OUTBOX_DEFAULT_LEASE_SECONDS). */
  leaseSeconds?: number;
  /** Legacy alias of batchSize, kept for the worker task payload. */
  limit?: number;
  loader: BulkSearchDocumentLoader;
  /** Dead-letter threshold (default OUTBOX_DEFAULT_MAX_ATTEMPTS). */
  maxAttempts?: number;
  versionStore: SearchVersionStore;
}

export interface OutboxLag {
  /** Rows not yet processed and not dead-lettered: `outbox_lag_events`. */
  events: number;
  /** Age of the oldest such row in seconds (0 when none): `outbox_lag_seconds`. */
  seconds: number;
}

export interface DrainPostgresOutboxResult {
  /** Rows this drain claimed. */
  claimed: number;
  /** Rows that hit maxAttempts on this drain. */
  deadLettered: number;
  /** Rows acked (applied, unchanged or no-op). */
  drained: number;
  /** Rows blamed for an engine failure (retry_count + 1, incl. dead-lettered). */
  failed: number;
  /** Legacy scalar (Number(version.appliedSequence)) for JSON-safe callers. */
  indexVersion: number;
  lag: OutboxLag;
  processedIds: string[];
  /**
   * Post-claim updates that matched no row because another drain re-claimed
   * them after this drain's lease expired (fenced by claim_token).
   */
  lostLease: number;
  /** Rows released unblamed because an earlier mutation failed. */
  released: number;
  /** Mutations consumed as no-ops because an equal or newer sequence was already applied. */
  superseded: number;
  /** Aggregates whose projection hash was unchanged: no engine write. */
  unchanged: number;
  version: SearchVersion;
}

export interface DeadLetteredOutboxEvent {
  aggregateId: string;
  aggregateType: string;
  deadLetteredAt: Date;
  eventType: string;
  id: string;
  lastError: string | null;
  retryCount: number;
  sequenceNumber: bigint;
}

type ClaimedRow = Awaited<ReturnType<typeof claimOutboxRows>>[number];

const claimedRowSelection = {
  aggregateId: outboxEvent.aggregateId,
  aggregateType: outboxEvent.aggregateType,
  eventType: outboxEvent.eventType,
  id: outboxEvent.id,
  payload: outboxEvent.payload,
  sequenceNumber: outboxEvent.sequenceNumber,
};

/**
 * Claims up to `batchSize` rows for `leaseSeconds` under one fencing token
 * (RJC-389/RJC-392):
 *
 *   UPDATE curated.outbox_event SET claimed_until = now() + lease, claim_token = $token
 *   WHERE id IN (
 *     SELECT id FROM curated.outbox_event o
 *     WHERE processed_at IS NULL AND dead_lettered_at IS NULL
 *       AND (claimed_until IS NULL OR claimed_until < now())
 *       AND NOT EXISTS (SELECT 1 FROM curated.outbox_event s
 *                       WHERE s.aggregate_id = o.aggregate_id AND s.processed_at IS NULL
 *                         AND s.claimed_until > now() AND s.id <> o.id)
 *     ORDER BY sequence_number LIMIT $batchSize
 *     FOR UPDATE SKIP LOCKED)
 *   RETURNING ...
 *
 * Selection is per-row state, never a sequence boundary, so a row whose
 * inserting transaction commits late (lower sequence, later commit) is
 * simply claimed by a later drain: nothing depends on having seen every
 * lower sequence first. Two concurrent drains lock disjoint sets (SKIP
 * LOCKED); a row a dead drain left claimed becomes claimable again once
 * its lease expires.
 *
 * The NOT EXISTS keeps one aggregate inside one drain at a time: while a
 * drain holds a live claim on any of an aggregate's rows, no other drain
 * claims that aggregate's other rows, so two drains cannot apply the same
 * aggregate's events in the wrong order. The claim runs under a
 * transaction-scoped advisory lock so two claims can never scan the same
 * snapshot: without it, both would pass NOT EXISTS before either committed,
 * split a hot aggregate across drains, and a stale status could land after
 * the newer one — and stay, because the next same-content event is skipped
 * by the projection hash. The applied_sequence guard and the state
 * compare-and-set remain as the second layer for lease-expiry re-claims.
 */
const claimOutboxRows = async (
  database: BronRuntimeDatabase,
  batchSize: number,
  leaseSeconds: number,
  claimToken: string
) => {
  const sibling = aliasedTable(outboxEvent, "sibling");
  const claimable = database
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        isNull(outboxEvent.processedAt),
        isNull(outboxEvent.deadLetteredAt),
        or(
          isNull(outboxEvent.claimedUntil),
          lt(outboxEvent.claimedUntil, sql`now()`)
        ),
        notExists(
          database
            .select({ one: sql`1` })
            .from(sibling)
            .where(
              and(
                eq(sibling.aggregateId, outboxEvent.aggregateId),
                isNull(sibling.processedAt),
                gt(sibling.claimedUntil, sql`now()`),
                ne(sibling.id, outboxEvent.id)
              )
            )
        )
      )
    )
    .orderBy(asc(outboxEvent.sequenceNumber))
    .limit(batchSize)
    .for("update", { skipLocked: true });

  const rows = await database.transaction(async (tx) => {
    // Serialises claim statements: the next claimer's snapshot is taken after
    // this one commits, so its NOT EXISTS sees the live claim. Claims are
    // millisecond statements; SKIP LOCKED still covers lease-expired
    // re-claims. ponytail: global claim lock, per-aggregate if claim
    // contention shows.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('outbox_claim'))`
    );
    return tx
      .update(outboxEvent)
      .set({
        claimToken,
        claimedUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
      })
      .where(inArray(outboxEvent.id, claimable))
      .returning(claimedRowSelection);
  });

  // RETURNING carries no order; the projector coalesces by sequence.
  return rows.toSorted((left, right) =>
    left.sequenceNumber < right.sequenceNumber ? -1 : 1
  );
};

/** `WHERE id IN (...) AND claim_token = mine`: a drain that lost its lease updates nothing. */
const fenced = (ids: readonly string[], claimToken: string) =>
  and(
    inArray(outboxEvent.id, [...ids]),
    eq(outboxEvent.claimToken, claimToken)
  );

/** Clears the lease on rows this drain still holds; the exit path for any thrown error after claim. */
const releaseClaims = async (
  database: BronRuntimeDatabase,
  ids: readonly string[],
  claimToken: string
): Promise<number> => {
  if (ids.length === 0) {
    return 0;
  }
  const rows = await database
    .update(outboxEvent)
    .set({ claimToken: null, claimedUntil: null })
    .where(fenced(ids, claimToken))
    .returning({ id: outboxEvent.id });
  return rows.length;
};

/** `outbox_lag_events` / `outbox_lag_seconds` — the readiness/metrics layer (RJC-391) calls this. */
export const readOutboxLag = async (
  database: BronRuntimeDatabase
): Promise<OutboxLag> => {
  const [row] = await database
    .select({
      events: sql<number>`count(*)::int`,
      seconds: sql<number>`COALESCE(EXTRACT(EPOCH FROM now() - min(${outboxEvent.createdAt})), 0)::float8`,
    })
    .from(outboxEvent)
    .where(
      and(isNull(outboxEvent.processedAt), isNull(outboxEvent.deadLetteredAt))
    );
  return { events: row?.events ?? 0, seconds: row?.seconds ?? 0 };
};

/** Reconciliation entry point: rows parked after maxAttempts failures, oldest first. */
export const listDeadLetteredOutboxEvents = async (
  database: BronRuntimeDatabase,
  limit: number = DEAD_LETTER_LIST_LIMIT
): Promise<DeadLetteredOutboxEvent[]> => {
  const rows = await database
    .select({
      aggregateId: outboxEvent.aggregateId,
      aggregateType: outboxEvent.aggregateType,
      deadLetteredAt: outboxEvent.deadLetteredAt,
      eventType: outboxEvent.eventType,
      id: outboxEvent.id,
      lastError: outboxEvent.lastError,
      retryCount: outboxEvent.retryCount,
      sequenceNumber: outboxEvent.sequenceNumber,
    })
    .from(outboxEvent)
    .where(isNotNull(outboxEvent.deadLetteredAt))
    .orderBy(asc(outboxEvent.sequenceNumber))
    .limit(limit);
  return rows.flatMap((row) =>
    row.deadLetteredAt === null
      ? []
      : [{ ...row, deadLetteredAt: row.deadLetteredAt }]
  );
};

export interface OutboxFailureGroup {
  /** Rows currently parked (dead-lettered) in this group. */
  deadLettered: number;
  lastError: string;
  oldestCreatedAt: Date | null;
  /** Unprocessed rows carrying this last_error (retrying or dead-lettered). */
  rows: number;
}

/**
 * Unprocessed rows grouped by last_error, largest group first. Reading this:
 * many rows, one identical last_error, rising outbox_lag_seconds is the
 * batch-wide signature (table absent, misconfiguration) — the drain blames
 * one row per chunk per drain, so the group grows while the backlog stalls.
 * A single row with a unique error is a genuine per-document poison.
 */
export const summarizeOutboxFailures = async (
  database: BronRuntimeDatabase
): Promise<OutboxFailureGroup[]> => {
  const rows = await database
    .select({
      deadLettered: sql<number>`count(${outboxEvent.deadLetteredAt})::int`,
      lastError: outboxEvent.lastError,
      oldestCreatedAt: sql<Date | null>`min(${outboxEvent.createdAt})`,
      rows: sql<number>`count(*)::int`,
    })
    .from(outboxEvent)
    .where(
      and(isNull(outboxEvent.processedAt), isNotNull(outboxEvent.lastError))
    )
    .groupBy(outboxEvent.lastError)
    .orderBy(sql`count(*) DESC`);
  return rows.flatMap((row) =>
    row.lastError === null ? [] : [{ ...row, lastError: row.lastError }]
  );
};

/**
 * Puts dead letters back in the claim pool with a fresh attempt budget.
 * `ids` omitted requeues every dead letter. Returns the number requeued.
 */
export const requeueDeadLetteredOutboxEvents = async (
  database: BronRuntimeDatabase,
  ids?: readonly string[]
): Promise<number> => {
  if (ids !== undefined && ids.length === 0) {
    return 0;
  }
  const scope =
    ids === undefined
      ? isNotNull(outboxEvent.deadLetteredAt)
      : and(
          isNotNull(outboxEvent.deadLetteredAt),
          inArray(outboxEvent.id, [...ids])
        );
  const rows = await database
    .update(outboxEvent)
    .set({ claimedUntil: null, deadLetteredAt: null, retryCount: 0 })
    .where(scope)
    .returning({ id: outboxEvent.id });
  return rows.length;
};

interface BatchOutcome {
  ackIds: Set<string>;
  appliedDeletes: { aggregateId: string; sequenceNumber: bigint }[];
  appliedUpserts: { aggregateId: string; sequenceNumber: bigint }[];
  /** Outbox event ids per distinct error message. */
  blamed: Map<string, string[]>;
  releaseIds: string[];
}

/** Maps engine outcomes per mutation back onto the outbox rows behind them. */
const partitionOutcomes = (
  plan: OutboxBatchPlan,
  result: SearchIndexBatchResult
): BatchOutcome => {
  const failedError = new Map(
    result.failures.map((failure) => [failure.id, failure.error])
  );
  const unappliedIds = new Set(result.unapplied);
  const outcome: BatchOutcome = {
    ackIds: new Set(plan.noopEventIds),
    appliedDeletes: [],
    appliedUpserts: [],
    blamed: new Map(),
    releaseIds: [],
  };

  for (const mutation of plan.mutations) {
    const id = mutationId(mutation);
    const eventIds = plan.eventIdsByAggregate.get(id) ?? [];
    const error = failedError.get(id);
    if (error !== undefined) {
      const group = outcome.blamed.get(error) ?? [];
      group.push(...eventIds);
      outcome.blamed.set(error, group);
      continue;
    }
    if (unappliedIds.has(id)) {
      outcome.releaseIds.push(...eventIds);
      continue;
    }
    for (const eventId of eventIds) {
      outcome.ackIds.add(eventId);
    }
    if (mutation.kind === "delete") {
      outcome.appliedDeletes.push({
        aggregateId: id,
        sequenceNumber: mutation.sequenceNumber,
      });
    } else {
      outcome.appliedUpserts.push({
        aggregateId: id,
        sequenceNumber: mutation.sequenceNumber,
      });
    }
  }
  return outcome;
};

const persistProjectionState = async (
  database: BronRuntimeDatabase,
  plan: OutboxBatchPlan,
  generation: number,
  outcome: BatchOutcome
): Promise<void> => {
  if (outcome.appliedUpserts.length > 0) {
    await database
      .insert(searchProjectionState)
      .values(
        outcome.appliedUpserts.map((upsert) => ({
          aggregateId: upsert.aggregateId,
          appliedSequence: upsert.sequenceNumber,
          generation,
          projectionHash: plan.hashes.get(upsert.aggregateId) ?? "",
        }))
      )
      .onConflictDoUpdate({
        set: {
          appliedSequence: sql`excluded.applied_sequence`,
          generation: sql`excluded.generation`,
          projectionHash: sql`excluded.projection_hash`,
          updatedAt: sql`now()`,
        },
        // A stale drain can never move state backwards. Sequence numbers are
        // only comparable inside one generation: an old generation can have
        // a larger global outbox sequence but must never overwrite a newer
        // generation's state.
        setWhere: sql`${searchProjectionState.generation} < excluded.generation OR (${searchProjectionState.generation} = excluded.generation AND ${searchProjectionState.appliedSequence} < excluded.applied_sequence)`,
        target: searchProjectionState.aggregateId,
      });
  }
  if (outcome.appliedDeletes.length > 0) {
    await database
      .delete(searchProjectionState)
      .where(
        or(
          ...outcome.appliedDeletes.map((deleted) =>
            and(
              eq(searchProjectionState.aggregateId, deleted.aggregateId),
              or(
                lt(searchProjectionState.generation, generation),
                and(
                  eq(searchProjectionState.generation, generation),
                  lte(
                    searchProjectionState.appliedSequence,
                    deleted.sequenceNumber
                  )
                )
              )
            )
          )
        )
      );
  }
};

interface KnownProjectionState {
  hashes: Map<string, string>;
  sequences: Map<string, bigint>;
}

/**
 * Hashes are only comparable within one generation: a rebuild starts from
 * an empty index, so an older generation's hash must not suppress a write.
 * applied_sequence guards late mutations (see planOutboxBatch.knownSequences).
 * ponytail: also generation-scoped — a late delete straddling a rebuild is
 * the rebuild's reindex problem, not this guard's.
 */
const readKnownState = async (
  database: BronRuntimeDatabase,
  aggregateIds: readonly string[],
  generation: number
): Promise<KnownProjectionState> => {
  const known: KnownProjectionState = {
    hashes: new Map(),
    sequences: new Map(),
  };
  if (aggregateIds.length === 0) {
    return known;
  }
  const stateRows = await database
    .select({
      aggregateId: searchProjectionState.aggregateId,
      appliedSequence: searchProjectionState.appliedSequence,
      projectionHash: searchProjectionState.projectionHash,
    })
    .from(searchProjectionState)
    .where(
      and(
        inArray(searchProjectionState.aggregateId, [...aggregateIds]),
        eq(searchProjectionState.generation, generation)
      )
    );
  for (const state of stateRows) {
    known.hashes.set(state.aggregateId, state.projectionHash);
    known.sequences.set(state.aggregateId, state.appliedSequence);
  }
  return known;
};

const emptyResult = async (
  database: BronRuntimeDatabase,
  version: SearchVersion,
  extra: Partial<DrainPostgresOutboxResult> = {}
): Promise<DrainPostgresOutboxResult> => ({
  claimed: 0,
  deadLettered: 0,
  drained: 0,
  failed: 0,
  indexVersion: Number(version.appliedSequence),
  lag: await readOutboxLag(database),
  lostLease: 0,
  processedIds: [],
  released: 0,
  superseded: 0,
  unchanged: 0,
  version,
  ...extra,
});

interface ClaimedBatch {
  checkpoint: SearchVersionCheckpoint;
  claimToken: string;
  maxAttempts: number;
  rows: ClaimedRow[];
}

const applyClaimedRows = async (
  input: DrainPostgresOutboxInput,
  batch: ClaimedBatch
): Promise<DrainPostgresOutboxResult> => {
  const { checkpoint, claimToken, maxAttempts, rows } = batch;
  const events: OutboxEventRecord[] = rows.map((row) => ({
    aggregateId: row.aggregateId,
    aggregateType: row.aggregateType,
    eventType: row.eventType,
    id: row.id,
    // SAFETY: outbox payload JSON matches OutboxEventRecord at write time in PostgresCurateStore.
    payload: row.payload as OutboxEventRecord["payload"],
    sequenceNumber: row.sequenceNumber,
  }));

  const known = await readKnownState(
    input.database,
    coalesceOutboxEvents(events).aggregates.map(
      (aggregate) => aggregate.aggregateId
    ),
    checkpoint.generation
  );

  const plan = await planOutboxBatch({
    events,
    knownHashes: known.hashes,
    knownSequences: known.sequences,
    loadDocuments: (ids) => input.loader.loadManyByAggregateIds(ids),
  });

  const result = await input.engine.applyBatch({
    appliedSequence: plan.appliedSequence,
    mutations: plan.mutations,
  });
  const version: SearchVersion = {
    appliedSequence: result.appliedSequence,
    generation: result.generation,
  };

  const outcome = partitionOutcomes(plan, result);
  const { ackIds, blamed, releaseIds } = outcome;

  // Projection state lands after the index write and before the ack: a
  // crash in between re-claims the rows and re-derives "unchanged".
  await persistProjectionState(
    input.database,
    plan,
    // The batch was planned against this generation. If a rebuild races an
    // in-flight engine write, never mislabel old-generation state as the new
    // generation; the generation-aware CAS below then leaves newer state
    // intact. Authoritative rebuilds still require a quiesced projector.
    checkpoint.generation,
    outcome
  );

  let lostLease = 0;
  const processedIds: string[] = [];
  if (ackIds.size > 0) {
    const acked = await input.database
      .update(outboxEvent)
      .set({
        claimToken: null,
        claimedUntil: null,
        indexVersion: sql`${outboxEvent.sequenceNumber}`,
        lastError: null,
        processedAt: sql`now()`,
      })
      .where(fenced([...ackIds], claimToken))
      .returning({ id: outboxEvent.id });
    processedIds.push(...acked.map((row) => row.id));
    lostLease += ackIds.size - acked.length;
  }

  let failed = 0;
  let deadLettered = 0;
  /* oxlint-disable no-await-in-loop -- one UPDATE per distinct error message; usually a single one */
  for (const [error, eventIds] of blamed) {
    const updated = await input.database
      .update(outboxEvent)
      .set({
        claimToken: null,
        claimedUntil: null,
        deadLetteredAt: sql`CASE WHEN ${outboxEvent.retryCount} + 1 >= ${maxAttempts} THEN now() ELSE NULL END`,
        lastError: error,
        retryCount: sql`${outboxEvent.retryCount} + 1`,
      })
      .where(fenced(eventIds, claimToken))
      .returning({ deadLetteredAt: outboxEvent.deadLetteredAt });
    failed += updated.length;
    deadLettered += updated.filter((row) => row.deadLetteredAt !== null).length;
    lostLease += eventIds.length - updated.length;
  }
  /* oxlint-enable no-await-in-loop */

  const released = await releaseClaims(input.database, releaseIds, claimToken);
  lostLease += releaseIds.length - released;

  return {
    claimed: rows.length,
    deadLettered,
    drained: processedIds.length,
    failed,
    indexVersion: Number(version.appliedSequence),
    lag: await readOutboxLag(input.database),
    lostLease,
    processedIds,
    released,
    superseded: plan.supersededAggregateIds.length,
    unchanged: plan.unchangedAggregateIds.length,
    version,
  };
};

/**
 * Bulk outbox drain (RJC-389, absorbing RJC-392).
 *
 * claim rows (lease + SKIP LOCKED) → coalesce per aggregate → one
 * loadManyByAggregateIds → projection-hash compare → one engine.applyBatch
 * (one Manticore /bulk) → persist hashes → ack / blame / release rows.
 *
 * The checkpoint is a pure version watermark now: engine.applyBatch advances
 * it (GREATEST, monotone) to the highest sequence applied, and nothing reads
 * it to decide which rows to process. That is why the RJC-384 xmin gate is
 * gone: it existed only because selection was `sequence_number > checkpoint`,
 * which made a late-committing lower sequence permanently invisible. With
 * per-row claims a late commit is just an unprocessed row for the next drain.
 *
 * Watermark with gaps: the checkpoint may sit above an unprocessed row (a
 * late commit, a retrying failure, a dead letter). Selection does not care.
 * The one residual is version-keyed caching: re-applying such a row later
 * does not raise the version (its sequence is already below the watermark),
 * so a result cache keyed on SearchVersion can serve pre-retry results until
 * its TTL or the next advance. That is a cache-freshness bound, not a lost
 * write — the row is applied and acked either way.
 *
 * Crash mid-batch: claimed rows stay claimed until the lease expires, then
 * any drain re-claims them. Writes that already reached Manticore are
 * re-applied (replace/delete by id are idempotent); hashes already persisted
 * make the re-run report those aggregates as unchanged. Nothing is lost,
 * nothing is applied twice with a different outcome.
 *
 * Partial failure (see SearchIndexBatchResult): failed mutations blame their
 * rows (retry_count + 1, last_error, dead-lettered at maxAttempts) and
 * release the claim; unapplied mutations release their rows unblamed;
 * everything else is acked. `processed_at` remains the ack.
 *
 * The engine MUST be constructed with the same version store passed here.
 */
export const drainPostgresOutbox = async (
  input: DrainPostgresOutboxInput
): Promise<DrainPostgresOutboxResult> => {
  const checkpoint = await input.versionStore.read();
  const expectedSchemaHash = input.expectedSchemaHash ?? SEARCH_SCHEMA_HASH;
  if (checkpoint.schemaHash !== expectedSchemaHash) {
    // Surfaced loudly on purpose: a mismatched schema means the index was
    // built for another document mapping and needs a full rebuild (new
    // generation) — silently reindexing here would hide that.
    throw new SearchIndexSchemaMismatchError(
      checkpoint.schemaHash,
      expectedSchemaHash
    );
  }
  const currentVersion: SearchVersion = {
    appliedSequence: checkpoint.appliedSequence,
    generation: checkpoint.generation,
  };

  const batchSize = input.batchSize ?? input.limit ?? OUTBOX_DEFAULT_BATCH_SIZE;
  const leaseSeconds = input.leaseSeconds ?? OUTBOX_DEFAULT_LEASE_SECONDS;
  const maxAttempts = input.maxAttempts ?? OUTBOX_DEFAULT_MAX_ATTEMPTS;

  const claimToken = crypto.randomUUID();
  const rows = await claimOutboxRows(
    input.database,
    batchSize,
    leaseSeconds,
    claimToken
  );
  if (rows.length === 0) {
    return emptyResult(input.database, currentVersion);
  }

  try {
    return await applyClaimedRows(input, {
      checkpoint,
      claimToken,
      maxAttempts,
      rows,
    });
  } catch (error) {
    // Transport failure or any other throw after the claim: hand the batch
    // straight back (no retry increment — nobody was blamed) instead of
    // leaving it stuck until the lease expires. Fenced, so rows another
    // drain has since taken over are left alone.
    await releaseClaims(
      input.database,
      rows.map((row) => row.id),
      claimToken
    );
    throw error;
  }
};
