import { timeCriticalPathPhase } from "@ji/performance";

import {
  partitionFromProjectionHash,
  projectionHash,
} from "./manticore/engine";
import { readOutboxStatus } from "./outbox-payload";
import { documentPartition } from "./partition";
import type {
  OutboxEventRecord,
  SearchDocument,
  SearchDocumentLoader,
  SearchEngine,
  SearchIndexBatchResult,
  SearchIndexMutation,
} from "./types";
import { ZERO_SEQUENCE } from "./version";

const CLOSE_EVENT_TYPES = new Set([
  "aanvraag.gesloten",
  "aanvraag.closed",
  "aanvraag.verwijderd",
]);

const DELETE_EVENT_TYPE = "aanvraag.verwijderd";
const SEARCH_AGGREGATE_TYPE = "aanvraag";

/** The event's status wins over the loaded row; close events imply closed. */
const applyEventStatus = (
  document: SearchDocument,
  event: OutboxEventRecord
): SearchDocument => {
  const payloadStatus = readOutboxStatus(event.payload);
  if (payloadStatus !== null) {
    return { ...document, status: payloadStatus };
  }
  if (CLOSE_EVENT_TYPES.has(event.eventType)) {
    return { ...document, status: "closed" };
  }
  return document;
};

interface ResolveOutboxMutationInput {
  event: OutboxEventRecord;
  loader: SearchDocumentLoader;
}

/**
 * Resolves a single outbox event into an idempotent index mutation, or null
 * when the event does not touch the search index (wrong aggregate type, or
 * the source document no longer loads). The batch path below coalesces
 * first and loads once per aggregate; this stays for single-event callers.
 */
export const resolveOutboxMutation = async (
  input: ResolveOutboxMutationInput
): Promise<SearchIndexMutation | null> => {
  const { event, loader } = input;

  if (event.aggregateType !== SEARCH_AGGREGATE_TYPE) {
    return null;
  }

  if (event.eventType === DELETE_EVENT_TYPE) {
    return {
      id: event.aggregateId,
      kind: "delete",
      sequenceNumber: event.sequenceNumber,
    };
  }

  const loaded = await loader.loadByAggregateId(event.aggregateId);
  if (!loaded) {
    return null;
  }

  return {
    document: applyEventStatus(loaded, event),
    kind: "upsert",
    sequenceNumber: event.sequenceNumber,
  };
};

export interface CoalescedOutboxAggregate {
  readonly aggregateId: string;
  /** Every event id folded into this aggregate, in sequence order. */
  readonly eventIds: readonly string[];
  /** Highest-sequence event: it decides delete vs upsert and the status. */
  readonly last: OutboxEventRecord;
  readonly maxSequence: bigint;
}

export interface CoalescedOutbox {
  readonly aggregates: readonly CoalescedOutboxAggregate[];
  /** Events for other aggregate types: consumed as no-ops. */
  readonly ignoredEventIds: readonly string[];
  /** Highest sequence across every event, including ignored ones. */
  readonly maxSequence: bigint;
}

/**
 * Folds a batch of outbox events into one intent per aggregate (RJC-389).
 * The last event by sequence wins: a delete after upserts cancels the
 * upserts (no load, one delete); several upserts collapse to one load and
 * one write; an upsert after a delete re-creates the document.
 */
export const coalesceOutboxEvents = (
  events: readonly OutboxEventRecord[]
): CoalescedOutbox => {
  const ordered = events.toSorted((left, right) =>
    left.sequenceNumber < right.sequenceNumber ? -1 : 1
  );
  const byAggregate = new Map<
    string,
    { eventIds: string[]; last: OutboxEventRecord }
  >();
  const ignoredEventIds: string[] = [];
  let maxSequence = ZERO_SEQUENCE;

  for (const event of ordered) {
    if (event.sequenceNumber > maxSequence) {
      maxSequence = event.sequenceNumber;
    }
    if (event.aggregateType !== SEARCH_AGGREGATE_TYPE) {
      ignoredEventIds.push(event.id);
      continue;
    }
    const existing = byAggregate.get(event.aggregateId);
    if (existing) {
      existing.eventIds.push(event.id);
      existing.last = event;
    } else {
      byAggregate.set(event.aggregateId, { eventIds: [event.id], last: event });
    }
  }

  return {
    aggregates: [...byAggregate.entries()].map(([aggregateId, group]) => ({
      aggregateId,
      eventIds: group.eventIds,
      last: group.last,
      maxSequence: group.last.sequenceNumber,
    })),
    ignoredEventIds,
    maxSequence,
  };
};

export interface OutboxBatchPlanInput {
  readonly events: readonly OutboxEventRecord[];
  /**
   * Projection hashes already applied under the current generation, by
   * aggregate id. An upsert whose hash matches is reported as unchanged and
   * skips the engine write entirely.
   */
  readonly knownHashes?: ReadonlyMap<string, string>;
  /**
   * Highest outbox sequence already applied per aggregate (the projection
   * state's applied_sequence). Any mutation — upsert or delete — whose
   * sequence is at or below it is a late commit against a since-updated
   * aggregate: current state wins, so it is consumed as a no-op
   * (superseded) instead of regressing or removing the newer document.
   */
  readonly knownSequences?: ReadonlyMap<string, bigint>;
  readonly loadDocuments: (
    aggregateIds: readonly string[]
  ) => Promise<ReadonlyMap<string, SearchDocument>>;
  /** Clock for the partition rule (RJC-383); one value for the whole plan. Defaults to now. */
  readonly now?: Date;
}

export interface OutboxBatchPlan {
  /** Watermark if every mutation applies (covers no-op events too). */
  readonly appliedSequence: bigint;
  /** Outbox event ids behind each mutation id, for acking and blaming. */
  readonly eventIdsByAggregate: ReadonlyMap<string, readonly string[]>;
  /** Projection hash per upsert, to persist once the write is applied. */
  readonly hashes: ReadonlyMap<string, string>;
  readonly mutations: readonly SearchIndexMutation[];
  /** Event ids that produced no mutation (ignored type, missing document, unchanged hash). */
  readonly noopEventIds: readonly string[];
  /** Mutations skipped because an equal or newer sequence was already applied. */
  readonly supersededAggregateIds: readonly string[];
  /** Aggregates whose loaded projection matched the known hash. */
  readonly unchangedAggregateIds: readonly string[];
}

/**
 * Coalesce → load once per aggregate → hash-compare → mutations. Pure apart
 * from `loadDocuments`, so the coalescing and skip rules are testable
 * without Postgres or Manticore.
 *
 * RJC-383: every mutation carries its partition. The known hash's prefix
 * (partitionFromProjectionHash) is the partition the document was last
 * written to under this generation, so a changed partition yields an upsert
 * with `previousPartition` ≠ `partition` — a move — and a delete targets the
 * one table that holds the document. No known hash means unknown: the
 * engine then also clears the other table.
 */
export const planOutboxBatch = async (
  input: OutboxBatchPlanInput
): Promise<OutboxBatchPlan> => {
  const coalesced = coalesceOutboxEvents(input.events);
  const knownHashes = input.knownHashes ?? new Map<string, string>();
  const now = input.now ?? new Date();
  const knownPartition = (aggregateId: string) => {
    const known = knownHashes.get(aggregateId);
    return known === undefined ? undefined : partitionFromProjectionHash(known);
  };
  const noopEventIds: string[] = [...coalesced.ignoredEventIds];
  const eventIdsByAggregate = new Map<string, readonly string[]>();
  const mutations: SearchIndexMutation[] = [];
  const hashes = new Map<string, string>();
  const unchangedAggregateIds: string[] = [];
  const supersededAggregateIds: string[] = [];

  const toLoad = coalesced.aggregates.filter((aggregate) => {
    const applied = input.knownSequences?.get(aggregate.aggregateId);
    return (
      aggregate.last.eventType !== DELETE_EVENT_TYPE &&
      (applied === undefined || applied < aggregate.maxSequence)
    );
  });
  const documents =
    toLoad.length === 0
      ? new Map<string, SearchDocument>()
      : await input.loadDocuments(toLoad.map((item) => item.aggregateId));

  for (const aggregate of coalesced.aggregates) {
    eventIdsByAggregate.set(aggregate.aggregateId, aggregate.eventIds);
    const applied = input.knownSequences?.get(aggregate.aggregateId);
    if (applied !== undefined && applied >= aggregate.maxSequence) {
      supersededAggregateIds.push(aggregate.aggregateId);
      noopEventIds.push(...aggregate.eventIds);
      continue;
    }
    if (aggregate.last.eventType === DELETE_EVENT_TYPE) {
      mutations.push({
        id: aggregate.aggregateId,
        kind: "delete",
        partition: knownPartition(aggregate.aggregateId),
        sequenceNumber: aggregate.maxSequence,
      });
      continue;
    }
    const loaded = documents.get(aggregate.aggregateId);
    if (!loaded) {
      noopEventIds.push(...aggregate.eventIds);
      continue;
    }
    const document = applyEventStatus(loaded, aggregate.last);
    const hash = projectionHash(document, now);
    if (knownHashes.get(aggregate.aggregateId) === hash) {
      unchangedAggregateIds.push(aggregate.aggregateId);
      noopEventIds.push(...aggregate.eventIds);
      continue;
    }
    hashes.set(aggregate.aggregateId, hash);
    mutations.push({
      document,
      kind: "upsert",
      partition: documentPartition(document, now),
      previousPartition: knownPartition(aggregate.aggregateId),
      projectionHash: hash,
      sequenceNumber: aggregate.maxSequence,
    });
  }

  return {
    appliedSequence: coalesced.maxSequence,
    eventIdsByAggregate,
    hashes,
    mutations,
    noopEventIds,
    supersededAggregateIds,
    unchangedAggregateIds,
  };
};

export interface DrainOutboxInput {
  engine: SearchEngine;
  events: OutboxEventRecord[];
  knownHashes?: ReadonlyMap<string, string>;
  loader: SearchDocumentLoader;
}

/**
 * In-process drain over an already-selected event list (tests, e2e, the
 * in-memory pipeline). Coalesces per aggregate, then applies one batch.
 * Index writes land before the checkpoint advance (inside engine.applyBatch),
 * so a crash in between re-applies the batch; upserts and deletes by
 * document id make that safe. The Postgres drain (@ji/db) does the same
 * over row claims and a bulk loader.
 */
export const drainOutboxEvents = (
  input: DrainOutboxInput
): Promise<SearchIndexBatchResult> =>
  timeCriticalPathPhase("ingest-index-projection", async () => {
    if (input.events.length === 0) {
      const version = await input.engine.getAppliedVersion();
      return { ...version, failures: [], unapplied: [] };
    }

    const plan = await planOutboxBatch({
      events: input.events,
      knownHashes: input.knownHashes,
      loadDocuments: async (aggregateIds) => {
        const loaded = await Promise.all(
          aggregateIds.map((aggregateId) =>
            input.loader.loadByAggregateId(aggregateId)
          )
        );
        const documents = new Map<string, SearchDocument>();
        for (const document of loaded) {
          if (document) {
            documents.set(document.id, document);
          }
        }
        return documents;
      },
    });

    return input.engine.applyBatch({
      appliedSequence: plan.appliedSequence,
      mutations: plan.mutations,
    });
  });
