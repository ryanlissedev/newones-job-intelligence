import { documentPartition, SEARCH_INDEX_NAME } from "@ji/search";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { PostgresSearchDocumentLoader } from "./aanvraag-stores";
import type { BronRuntimeDatabase } from "./bron-runtime";
import { outboxEvent } from "./schema/curated";
import { readSearchIndexCheckpoint } from "./search-index-coordination";
import { SEARCH_REINDEX_EVENT_TYPE } from "./search-reindex";

export const SEARCH_EXPIRY_SWEEP_DEFAULT_BATCH_SIZE = 200;
export const SEARCH_EXPIRY_SWEEP_DEFAULT_MAX_PER_RUN = 2000;
export const SEARCH_EXPIRY_SWEEP_SAMPLE_LIMIT = 20;

/** Distinct from the projector singleton and the reindex coordination lock. */
export const SEARCH_EXPIRY_SWEEP_LOCK_KEY = 1_324_861_907;

export type SearchExpirySweepMode = "dry-run" | "apply";

export interface SearchExpirySweepInput {
  database: BronRuntimeDatabase;
  batchSize?: number;
  indexName?: string;
  maxPerRun?: number;
  mode: SearchExpirySweepMode;
  now?: Date;
}

export interface SearchExpirySweepResult {
  batches: number;
  capped: boolean;
  candidates: number;
  enqueued: number;
  mode: SearchExpirySweepMode;
  sampleIds: string[];
  skipped?: "lock_held";
  skippedPending: number;
}

interface ExpiryCandidate {
  id: string;
}

const validateInteger = (
  value: number,
  name: string,
  maximum: number
): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
};

const emptyResult = (
  mode: SearchExpirySweepMode,
  skipped?: "lock_held"
): SearchExpirySweepResult => {
  const result: SearchExpirySweepResult = {
    batches: 0,
    candidates: 0,
    capped: false,
    enqueued: 0,
    mode,
    sampleIds: [],
    skippedPending: 0,
  };
  if (skipped) {
    result.skipped = skipped;
  }
  return result;
};

const hasSweepLock = async (
  database: BronRuntimeDatabase
): Promise<boolean> => {
  const rows = await database.execute(
    sql`SELECT pg_try_advisory_xact_lock(${SEARCH_EXPIRY_SWEEP_LOCK_KEY}) AS acquired`
  );
  // SAFETY: pg_try_advisory_xact_lock always returns exactly one scalar row.
  const row = rows[0] as { acquired: boolean | string } | undefined;
  return row?.acquired === true || row?.acquired === "t";
};

const selectCandidates = async (
  database: BronRuntimeDatabase,
  generation: number,
  afterId: string | null,
  deadline: Date,
  limit: number,
  lockRows: boolean
): Promise<ExpiryCandidate[]> => {
  const afterCondition =
    afterId === null ? sql`` : sql`AND aanvraag.id > ${afterId}`;
  const rows = await database.execute<{ id: string }>(sql`
    SELECT aanvraag.id
    FROM curated.aanvraag
    INNER JOIN curated.search_projection_state
      ON search_projection_state.aggregate_id = aanvraag.id
      AND search_projection_state.generation = ${generation}
    WHERE aanvraag.superseded_by IS NULL
      AND search_projection_state.projection_hash LIKE 'active:%'
      AND (
        aanvraag.sluitingsdatum < ${deadline.toISOString()}
        OR (
          aanvraag.sluitingsdatum IS NULL
          AND EXISTS (
            SELECT 1
            FROM curated.aanvraag_enrichment
            WHERE aanvraag_enrichment.aanvraag_id = aanvraag.id
              AND aanvraag_enrichment.field = 'sluitingsdatum'
          )
        )
      )
      ${afterCondition}
    ORDER BY aanvraag.id ASC
    LIMIT ${limit}
    ${lockRows ? sql`FOR UPDATE OF aanvraag SKIP LOCKED` : sql``}
  `);
  return rows;
};

/**
 * Queues ordinary search reindex intents for live rows whose effective
 * deadline passed. The source row is only locked and read: the projector owns
 * the archive move. SQL admits curated deadlines and overlay-only deadlines;
 * the transactional search-document loader then applies the overlay and the
 * partition rule rejects future effective deadlines. There is no index on
 * `sluitingsdatum`, so each interval performs one bounded scan of roughly
 * 280k rows; revisit with a partial index in a separate migration PR if the
 * logged `durationMs` is high.
 */
export const runSearchExpirySweep = (
  input: SearchExpirySweepInput
): Promise<SearchExpirySweepResult> => {
  const batchSize = validateInteger(
    input.batchSize ?? SEARCH_EXPIRY_SWEEP_DEFAULT_BATCH_SIZE,
    "search expiry sweep batchSize",
    1000
  );
  const maxPerRun = validateInteger(
    input.maxPerRun ?? SEARCH_EXPIRY_SWEEP_DEFAULT_MAX_PER_RUN,
    "search expiry sweep maxPerRun",
    10_000
  );
  const indexName = input.indexName ?? SEARCH_INDEX_NAME;
  const now = input.now ?? new Date();
  const result = emptyResult(input.mode);

  return (async () => {
    // This is deliberately an unlocked, non-FOR-UPDATE read. The projector's
    // version store owns the coordination lock and must never be stalled here.
    const checkpoint = await readSearchIndexCheckpoint(
      input.database,
      indexName
    );
    if (!checkpoint) {
      throw new Error(
        `Search projection checkpoint missing for index ${indexName}`
      );
    }

    let cursor: string | null = null;
    /* oxlint-disable no-await-in-loop -- batches are deliberately sequential so each has short, atomic locks. */
    for (;;) {
      // Pending aggregates are still reported as candidates, but they do not
      // consume the apply budget: a later run must be able to walk past the
      // first run's pending rows and enqueue the remainder.
      const countedCandidates =
        input.mode === "apply"
          ? result.candidates - result.skippedPending
          : result.candidates;
      const remaining = maxPerRun - countedCandidates;
      if (remaining <= 0) {
        break;
      }
      const pageSize = batchSize;
      // oxlint-disable-next-line eslint/no-loop-func -- each callback closes over the current sequential keyset page.
      const batch = await input.database.transaction(async (transaction) => {
        if (input.mode === "dry-run") {
          await transaction.execute(sql`SET TRANSACTION READ ONLY`);
        }
        if (!(await hasSweepLock(transaction))) {
          return { skipped: true as const };
        }

        const rows = await selectCandidates(
          transaction,
          checkpoint.generation,
          cursor,
          now,
          pageSize + 1,
          input.mode === "apply"
        );
        const page = rows.slice(0, pageSize);
        if (page.length === 0) {
          return {
            capped: false,
            cursor: null,
            enqueued: 0,
            ids: [],
            skippedPending: 0,
          };
        }

        const documents = await new PostgresSearchDocumentLoader(
          transaction
        ).loadManyByAggregateIds(page.map((candidate) => candidate.id));
        const candidates = page.filter((candidate) => {
          const document = documents.get(candidate.id);
          return (
            document !== undefined &&
            documentPartition(document, now) === "archive"
          );
        });

        const pendingRows =
          candidates.length === 0
            ? []
            : await transaction
                .select({ aggregateId: outboxEvent.aggregateId })
                .from(outboxEvent)
                .where(
                  and(
                    eq(outboxEvent.aggregateType, "aanvraag"),
                    inArray(
                      outboxEvent.aggregateId,
                      candidates.map((candidate) => candidate.id)
                    ),
                    isNull(outboxEvent.processedAt),
                    isNull(outboxEvent.deadLetteredAt)
                  )
                );
        const pending = new Set(pendingRows.map((row) => row.aggregateId));
        const selected: ExpiryCandidate[] = [];
        let nonPending = 0;
        for (const candidate of candidates) {
          selected.push(candidate);
          if (!pending.has(candidate.id)) {
            nonPending += 1;
          }
          const budgetUsed =
            input.mode === "apply" ? nonPending : selected.length;
          if (budgetUsed >= remaining) {
            break;
          }
        }
        const reachedBudget =
          (input.mode === "apply" ? nonPending : selected.length) >= remaining;
        const hasUnselectedCandidates = selected.length < candidates.length;
        let enqueued = 0;
        if (input.mode === "apply") {
          const toEnqueue = selected.filter(
            (candidate) => !pending.has(candidate.id)
          );
          if (toEnqueue.length > 0) {
            const inserted = await transaction
              .insert(outboxEvent)
              .values(
                toEnqueue.map((candidate) => ({
                  aggregateId: candidate.id,
                  aggregateType: "aanvraag",
                  eventType: SEARCH_REINDEX_EVENT_TYPE,
                  payload: { reden: "sluitingsdatum_verstreken" },
                }))
              )
              .returning({ id: outboxEvent.id });
            enqueued = inserted.length;
          }
        }
        const ids = selected.map((row) => row.id);
        return {
          capped:
            reachedBudget &&
            (hasUnselectedCandidates || rows.length > page.length),
          cursor:
            hasUnselectedCandidates && ids.length > 0
              ? (ids.at(-1) ?? null)
              : (page.at(-1)?.id ?? null),
          enqueued,
          ids,
          skippedPending: selected.filter((row) => pending.has(row.id)).length,
        };
      });

      if ("skipped" in batch) {
        result.skipped = "lock_held";
        break;
      }
      if (batch.cursor === null) {
        break;
      }
      result.batches += 1;
      result.candidates += batch.ids.length;
      result.enqueued += batch.enqueued;
      result.skippedPending += batch.skippedPending;
      for (const id of batch.ids) {
        if (result.sampleIds.length < SEARCH_EXPIRY_SWEEP_SAMPLE_LIMIT) {
          result.sampleIds.push(id);
        }
      }
      const { cursor: nextCursor } = batch;
      cursor = nextCursor;
      if (batch.capped) {
        result.capped = true;
        break;
      }
      if (batch.ids.length === 0 && batch.cursor === null) {
        break;
      }
    }
    /* oxlint-enable no-await-in-loop */
    return result;
  })();
};
