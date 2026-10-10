import type { RunCompleteness, RunIncompleteReason } from "@ji/connectors";
import type {
  AanvraagId,
  AanvraagLifecycle,
  BronId,
  LifecycleReden,
  ScrapeRunId,
} from "@ji/domain";
import {
  DEFAULT_MISSED_POLLS_BEFORE_STALE,
  resolveLifecycleStatus,
} from "@ji/domain";

import type { CurateStore, StoredAanvraag } from "../identity/curate";
import {
  AANVRAAG_STATUS_GEWIJZIGD_EVENT,
  buildSnapshot,
} from "../identity/curate";

/** Outbox event type for a status change that carries no new content. */
export { AANVRAAG_STATUS_GEWIJZIGD_EVENT } from "../identity/curate";

export interface MarkSeenInput {
  bronId: BronId;
  bronReferenties: readonly string[];
  /** Records at or above this count before the reset are reported back as reappeared. */
  reappearedAtOrAbove: number;
  scrapeRunId: ScrapeRunId;
  seenAt: Date;
}

export interface IncrementMissedInput {
  bronId: BronId;
  exceptBronReferenties: readonly string[];
  /** Replay guard: a row already bumped by this run is not bumped again. */
  scrapeRunId: ScrapeRunId;
  /** Rows up to and including this count are bumped; counting stops at threshold + 1. */
  staleAtOrAbove: number;
}

/**
 * Per-source-record miss counters on `staging.source_record` (RJC-397).
 * `missed_polls` saturates at threshold + 1: a row at the threshold is bumped
 * one more time so an interrupted stale write is retried exactly once; past
 * that, `last_seen_at` carries the age and rewriting the row buys nothing.
 */
export interface MissedPollsStore {
  /** Resets counters for observed records; returns the ones that had been stale. */
  markSeen: (
    input: MarkSeenInput
  ) => Promise<{ reappeared: string[]; reset: number }>;
  /** +1 for every record of the bron not observed; returns the ones that just reached the threshold. */
  incrementMissed: (
    input: IncrementMissedInput
  ) => Promise<{ atThreshold: string[]; incremented: number }>;
}

export interface LifecycleReconcilePorts {
  curateStore: CurateStore;
  missedPolls: MissedPollsStore;
  missedPollsBeforeStale?: number;
  /** Serializes this bron and binds both stores to one rollback boundary. */
  withTransaction: <T>(
    bronId: BronId,
    fn: (ports: LifecycleReconcileTransactionPorts) => Promise<T>
  ) => Promise<T>;
}

export interface LifecycleReconcileTransactionPorts {
  curateStore: CurateStore;
  missedPolls: MissedPollsStore;
}

export interface ReconcileMissedPollsInput {
  bronId: BronId;
  completeness: RunCompleteness;
  observedAt: Date;
  observedBronReferenties: readonly string[];
  scrapeRunId: ScrapeRunId;
}

export interface ReconcileMissedPollsResult {
  /** Source records whose counter went up (0 when the run was incomplete). */
  incremented: number;
  /** Aanvragen that went stale -> active because the listing shows them again. */
  reopened: AanvraagId[];
  /** Observed source records whose counter was reset. */
  reset: number;
  /** Null when misses were counted; otherwise why this run did not count. */
  skippedIncrementReason: RunIncompleteReason | null;
  /** Aanvragen that crossed the threshold and went stale this run. */
  staled: AanvraagId[];
}

const writeStatusTransition = async (
  ports: LifecycleReconcileTransactionPorts,
  input: ReconcileMissedPollsInput,
  existing: StoredAanvraag,
  status: AanvraagLifecycle,
  reden: LifecycleReden,
  missedPolls: number
): Promise<void> => {
  const versie = existing.versie + 1;
  // One transaction (RJC-399): the SCD2 status write and its outbox event
  // commit together, so a crash can never leave the DB stale while the
  // search index keeps active — the projection hash would skip a later
  // same-content event, so that split does not self-heal.
  await ports.curateStore.closeOpenVersie(
    existing.aanvraagId,
    input.observedAt
  );
  const updated = await ports.curateStore.updateAanvraag(existing.aanvraagId, {
    status,
    versie,
  });
  await ports.curateStore.insertVersie({
    aanvraagId: updated.aanvraagId,
    contentHash: updated.contentHash,
    geldigTot: null,
    geldigVan: input.observedAt,
    rawPayloadRef: updated.rawPayloadRef,
    scrapeRunId: input.scrapeRunId,
    snapshot: buildSnapshot(updated),
    versie,
  });
  await ports.curateStore.insertOutboxEvent({
    aggregateId: updated.aanvraagId,
    aggregateType: "aanvraag",
    eventType: AANVRAAG_STATUS_GEWIJZIGD_EVENT,
    payload: {
      missed_polls: missedPolls,
      reden,
      scrape_run_id: input.scrapeRunId,
      status,
    },
  });
};

const reconcileInTransaction = async (
  ports: LifecycleReconcileTransactionPorts,
  input: ReconcileMissedPollsInput,
  threshold: number,
  observed: string[]
): Promise<ReconcileMissedPollsResult> => {
  const seen = await ports.missedPolls.markSeen({
    bronId: input.bronId,
    bronReferenties: observed,
    reappearedAtOrAbove: threshold,
    scrapeRunId: input.scrapeRunId,
    seenAt: input.observedAt,
  });
  const reopened: AanvraagId[] = [];
  for (const bronReferentie of seen.reappeared) {
    // oxlint-disable-next-line no-await-in-loop -- serialized SCD2 transitions share the outer transaction
    const existing = await ports.curateStore.findAanvraagByIdentity(
      input.bronId,
      bronReferentie
    );
    if (existing?.status !== "stale") {
      continue;
    }
    const next = resolveLifecycleStatus({
      bronSaysClosed: false,
      current: existing.status,
      missedPolls: 0,
      missedPollsBeforeStale: threshold,
      seenOpen: true,
      sluitingsdatumPassed: false,
    });
    // oxlint-disable-next-line no-await-in-loop -- serialized SCD2 transitions share the outer transaction
    await writeStatusTransition(
      ports,
      input,
      existing,
      next,
      "listing_teruggekeerd",
      0
    );
    reopened.push(existing.aanvraagId);
  }

  if (!input.completeness.complete) {
    return {
      incremented: 0,
      reopened,
      reset: seen.reset,
      skippedIncrementReason: input.completeness.reason,
      staled: [],
    };
  }

  const missed = await ports.missedPolls.incrementMissed({
    bronId: input.bronId,
    exceptBronReferenties: observed,
    scrapeRunId: input.scrapeRunId,
    staleAtOrAbove: threshold,
  });
  const staled: AanvraagId[] = [];
  for (const bronReferentie of missed.atThreshold) {
    // oxlint-disable-next-line no-await-in-loop -- serialized SCD2 transitions share the outer transaction
    const existing = await ports.curateStore.findAanvraagByIdentity(
      input.bronId,
      bronReferentie
    );
    if (!existing) {
      continue;
    }
    const next = resolveLifecycleStatus({
      bronSaysClosed: false,
      current: existing.status,
      missedPolls: threshold,
      missedPollsBeforeStale: threshold,
      seenOpen: false,
      sluitingsdatumPassed: false,
    });
    if (next === existing.status) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- serialized SCD2 transitions share the outer transaction
    await writeStatusTransition(
      ports,
      input,
      existing,
      next,
      "listing_verdwenen",
      threshold
    );
    staled.push(existing.aanvraagId);
  }

  return {
    incremented: missed.incremented,
    reopened,
    reset: seen.reset,
    skippedIncrementReason: null,
    staled,
  };
};

/**
 * Run-boundary step after a listing run of one bron (RJC-397): every source
 * record the listing showed gets `missed_polls = 0`; when the run was
 * complete, every record it did not show gets `+1`. Records that reach the
 * threshold go `stale` and records that reappear while `stale` go `active`,
 * both written through the same SCD2 + outbox path a content change uses,
 * so RJC-389's projector re-indexes the status.
 *
 * Only `stale` reopens. A `closed` record is closed by the source or its
 * closing date (RJC-377); observation resets its counter but never its
 * status -- see the docblock on `resolveLifecycleStatus`.
 */
export const reconcileMissedPolls = (
  ports: LifecycleReconcilePorts,
  input: ReconcileMissedPollsInput
): Promise<ReconcileMissedPollsResult> => {
  const threshold =
    ports.missedPollsBeforeStale ?? DEFAULT_MISSED_POLLS_BEFORE_STALE;
  const observed = [...new Set(input.observedBronReferenties)].toSorted();
  return ports.withTransaction(input.bronId, (transactionPorts) =>
    reconcileInTransaction(transactionPorts, input, threshold, observed)
  );
};

interface InMemoryMissedPollsRow {
  bronReferentie: string;
  lastMissedScrapeRunId: ScrapeRunId | null;
  lastSeenAt: Date | null;
  lastSeenScrapeRunId: ScrapeRunId | null;
  missedPolls: number;
}

/** Test double mirroring the Postgres store's saturating semantics. */
export class InMemoryMissedPollsStore implements MissedPollsStore {
  readonly rows = new Map<string, InMemoryMissedPollsRow>();

  private static key(bronId: BronId, bronReferentie: string): string {
    return `${bronId}\0${bronReferentie}`;
  }

  /** Mirrors the source_record row the observation recorder creates on first sight. */
  ensure(bronId: BronId, bronReferentie: string): void {
    const key = InMemoryMissedPollsStore.key(bronId, bronReferentie);
    if (!this.rows.has(key)) {
      this.rows.set(key, {
        bronReferentie,
        lastMissedScrapeRunId: null,
        lastSeenAt: null,
        lastSeenScrapeRunId: null,
        missedPolls: 0,
      });
    }
  }

  read(bronId: BronId, bronReferentie: string): InMemoryMissedPollsRow | null {
    return (
      this.rows.get(InMemoryMissedPollsStore.key(bronId, bronReferentie)) ??
      null
    );
  }

  markSeen(
    input: MarkSeenInput
  ): Promise<{ reappeared: string[]; reset: number }> {
    const reappeared: string[] = [];
    let reset = 0;
    for (const bronReferentie of input.bronReferenties) {
      this.ensure(input.bronId, bronReferentie);
      const row = this.read(input.bronId, bronReferentie);
      if (!row) {
        continue;
      }
      if (row.missedPolls >= input.reappearedAtOrAbove) {
        reappeared.push(bronReferentie);
      }
      row.lastSeenAt = input.seenAt;
      row.lastSeenScrapeRunId = input.scrapeRunId;
      row.missedPolls = 0;
      reset += 1;
    }
    return Promise.resolve({ reappeared, reset });
  }

  incrementMissed(
    input: IncrementMissedInput
  ): Promise<{ atThreshold: string[]; incremented: number }> {
    const except = new Set(input.exceptBronReferenties);
    const atThreshold: string[] = [];
    let incremented = 0;
    for (const [key, row] of this.rows) {
      if (
        !key.startsWith(`${input.bronId}\0`) ||
        except.has(row.bronReferentie) ||
        row.missedPolls > input.staleAtOrAbove ||
        row.lastMissedScrapeRunId === input.scrapeRunId
      ) {
        continue;
      }
      row.missedPolls += 1;
      row.lastMissedScrapeRunId = input.scrapeRunId;
      incremented += 1;
      if (row.missedPolls >= input.staleAtOrAbove) {
        atThreshold.push(row.bronReferentie);
      }
    }
    return Promise.resolve({ atThreshold, incremented });
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const backup = structuredClone([...this.rows.entries()]);
    try {
      return await fn();
    } catch (error) {
      this.rows.clear();
      for (const [key, row] of backup) {
        this.rows.set(key, row);
      }
      throw error;
    }
  }
}

/** In-memory lifecycle ports with the same joint rollback boundary as Postgres. */
export const createInMemoryLifecyclePorts = (
  curateStore: CurateStore,
  missedPolls: InMemoryMissedPollsStore,
  options: { missedPollsBeforeStale?: number } = {}
): LifecycleReconcilePorts => ({
  curateStore,
  missedPolls,
  missedPollsBeforeStale: options.missedPollsBeforeStale,
  withTransaction: (_bronId, fn) =>
    missedPolls.withTransaction(() =>
      curateStore.withTransaction((transactionCurateStore) =>
        fn({
          curateStore: transactionCurateStore,
          missedPolls,
        })
      )
    ),
});
