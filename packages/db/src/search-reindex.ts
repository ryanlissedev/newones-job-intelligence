/* oxlint-disable max-classes-per-file -- distinct exported errors are operator-visible recovery contracts. */

import { createHash } from "node:crypto";

import {
  SEARCH_INDEX_NAME,
  SEARCH_SCHEMA_HASH,
  ZERO_SEQUENCE,
} from "@ji/search";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import {
  aanvraag,
  outboxEvent,
  searchProjectionCheckpoint,
} from "./schema/curated";
import {
  lockSearchIndexCoordination,
  readSearchIndexCheckpoint,
} from "./search-index-coordination";

/** A generic aanvraag upsert intent; the projector reloads the current row. */
export const SEARCH_REINDEX_EVENT_TYPE = "aanvraag.search_reindex";

/** Keeps curated-row reads and durable outbox inserts bounded. */
export const SEARCH_REINDEX_DEFAULT_PAGE_SIZE = 200;

/**
 * The final schema hash is deliberately not published while a rebuild's
 * replay events are being enqueued. The projector rejects this marker, so it
 * cannot consume a partial generation after a process crash.
 */
export const SEARCH_REINDEX_PENDING_PREFIX = "search-reindex-pending:v1:";

const EMPTY_HIGH_WATER = "empty";
const FIRST_GENERATION = 1;

export class SearchReindexPendingGenerationError extends Error {
  constructor(pendingSchemaHash: string, expectedSchemaHash: string) {
    super(
      `A search reindex for schema hash ${pendingSchemaHash} is already pending, but this command expects ${expectedSchemaHash}. ` +
        "Resume or finish that generation before starting another one."
    );
    this.name = "SearchReindexPendingGenerationError";
  }
}

export class SearchReindexGenerationChangedError extends Error {
  constructor(indexName: string, generation: number) {
    super(
      `Search reindex generation ${generation} for index ${indexName} changed while it was being scanned. ` +
        "No further replay events were enqueued; inspect the checkpoint and rerun."
    );
    this.name = "SearchReindexGenerationChangedError";
  }
}

export class SearchReindexDeadLetterError extends Error {
  constructor(generation: number, deadLettered: number) {
    super(
      `Search reindex generation ${generation} has ${deadLettered} dead-lettered replay event(s). ` +
        "Requeue or resolve them before publishing the generation."
    );
    this.name = "SearchReindexDeadLetterError";
  }
}

interface PendingGeneration {
  highWaterId: string | null;
  schemaHash: string;
}

interface Checkpoint {
  appliedSequence: bigint;
  generation: number;
  schemaHash: string;
}

type ReindexAction = "already-current" | "started" | "resumed";

interface ReindexGeneration {
  action: ReindexAction;
  generation: number;
  highWaterId: string | null;
  pendingMarker: string | null;
  previous: Checkpoint | null;
}

export interface SearchReindexProgress {
  readonly enqueued: number;
  readonly generation: number;
  readonly highWaterId: string | null;
  readonly page: number;
  readonly scanned: number;
}

export interface RunSearchReindexInput {
  /** False reports the selected generation and corpus without writing. */
  apply: boolean;
  database: BronRuntimeDatabase;
  /** Starts a new replay even when the current schema hash already matches. */
  force?: boolean;
  /** Defaults to the logical @ji/search index name. */
  indexName?: string;
  /** Called after a pending generation is durably created, before page one. */
  onGenerationStarted?: (progress: {
    readonly generation: number;
    readonly highWaterId: string | null;
  }) => Promise<void> | void;
  /** Called after each committed page; a thrown error intentionally leaves the marker pending. */
  onPage?: (progress: SearchReindexProgress) => Promise<void> | void;
  /** Schema hash the running projector expects (defaults to SEARCH_SCHEMA_HASH). */
  expectedSchemaHash?: string;
  /** Current curated rows selected per keyset page. */
  pageSize?: number;
}

export interface RunSearchReindexResult {
  /** Whether this invocation only described the work. */
  dryRun: boolean;
  /** Existing same-event rows observed via conflict-ignore during this invocation. */
  existing: number;
  /** New durable replay events inserted in this invocation. */
  enqueued: number;
  /** The target replay generation. */
  generation: number;
  /** UUID boundary captured before the new generation was marked pending. */
  highWaterId: string | null;
  /** The final schema hash became visible to the projector. */
  finalized: boolean;
  /** Same-generation replay events currently dead-lettered. */
  blockedDeadLetter: number;
  /** Current rows selected through bounded keyset pagination. */
  scanned: number;
  /** Events that the full replay requires (the same as scanned). */
  planned: number;
  /** How the target generation was selected. */
  action: ReindexAction | "would-start" | "would-resume";
}

const validatePageSize = (pageSize: number): number => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error(
      "search reindex pageSize must be an integer from 1 through 1000"
    );
  }
  return pageSize;
};

const pendingMarker = (
  schemaHash: string,
  highWaterId: string | null
): string =>
  `${SEARCH_REINDEX_PENDING_PREFIX}${encodeURIComponent(schemaHash)}:${highWaterId ?? EMPTY_HIGH_WATER}`;

const parsePendingMarker = (value: string): PendingGeneration | null => {
  if (!value.startsWith(SEARCH_REINDEX_PENDING_PREFIX)) {
    return null;
  }
  const encoded = value.slice(SEARCH_REINDEX_PENDING_PREFIX.length);
  const separator = encoded.lastIndexOf(":");
  if (separator < 1) {
    throw new Error("Search reindex checkpoint has an invalid pending marker");
  }
  const encodedHash = encoded.slice(0, separator);
  const highWater = encoded.slice(separator + 1);
  try {
    return {
      highWaterId: highWater === EMPTY_HIGH_WATER ? null : highWater,
      schemaHash: decodeURIComponent(encodedHash),
    };
  } catch {
    throw new Error("Search reindex checkpoint has an invalid pending marker");
  }
};

/**
 * A SHA-256-derived UUID with the RFC 4122 v5/version and variant bits. The
 * event primary key is the idempotency key: process restarts and concurrent
 * operators cannot create a second replay event for the same target pair.
 */
export const searchReindexEventId = (
  indexName: string,
  generation: number,
  aggregateId: string
): string => {
  const bytes = createHash("sha256")
    .update(
      `catapulze-search-reindex:v1:${indexName}:${generation}:${aggregateId}`
    )
    .digest();
  // Buffer's checked reads/writes keep this sound under projects that enable
  // `noUncheckedIndexedAccess` while compiling @ji/db from source.
  const versionByte = bytes.readUInt8(6);
  const variantByte = bytes.readUInt8(8);
  bytes.writeUInt8((versionByte % 16) + 0x50, 6);
  bytes.writeUInt8((variantByte % 64) + 0x80, 8);
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const readCheckpoint = (
  database: BronRuntimeDatabase,
  indexName: string,
  lock = false
): Promise<Checkpoint | null> =>
  readSearchIndexCheckpoint(database, indexName, lock);

const readHighWaterId = async (
  database: BronRuntimeDatabase
): Promise<string | null> => {
  const [row] = await database
    .select({ id: aanvraag.id })
    .from(aanvraag)
    .orderBy(desc(aanvraag.id))
    .limit(1);
  return row?.id ?? null;
};

const assertPendingGeneration = (
  checkpoint: Checkpoint | null,
  indexName: string,
  generation: number,
  marker: string
): void => {
  if (
    !checkpoint ||
    checkpoint.generation !== generation ||
    checkpoint.schemaHash !== marker
  ) {
    throw new SearchReindexGenerationChangedError(indexName, generation);
  }
};

const inspectGeneration = async (
  database: BronRuntimeDatabase,
  indexName: string,
  expectedSchemaHash: string,
  force: boolean
): Promise<ReindexGeneration> => {
  const previous = await readCheckpoint(database, indexName);
  if (previous === null) {
    return {
      action: "started",
      generation: FIRST_GENERATION,
      highWaterId: await readHighWaterId(database),
      pendingMarker: null,
      previous,
    };
  }

  const pending = parsePendingMarker(previous.schemaHash);
  if (pending) {
    if (pending.schemaHash !== expectedSchemaHash) {
      throw new SearchReindexPendingGenerationError(
        pending.schemaHash,
        expectedSchemaHash
      );
    }
    return {
      action: "resumed",
      generation: previous.generation,
      highWaterId: pending.highWaterId,
      pendingMarker: previous.schemaHash,
      previous,
    };
  }

  if (previous.schemaHash === expectedSchemaHash && !force) {
    return {
      action: "already-current",
      generation: previous.generation,
      highWaterId: null,
      pendingMarker: null,
      previous,
    };
  }

  return {
    action: "started",
    generation: previous.generation + 1,
    highWaterId: await readHighWaterId(database),
    pendingMarker: null,
    previous,
  };
};

/** Creates or resumes a pending generation under the reindex advisory lock. */
const beginGeneration = (
  database: BronRuntimeDatabase,
  indexName: string,
  expectedSchemaHash: string,
  force: boolean
): Promise<ReindexGeneration> =>
  database.transaction(async (transaction) => {
    await lockSearchIndexCoordination(transaction, indexName);
    let checkpoint = await readCheckpoint(transaction, indexName, true);

    if (checkpoint === null) {
      const highWaterId = await readHighWaterId(transaction);
      const marker = pendingMarker(expectedSchemaHash, highWaterId);
      const inserted = await transaction
        .insert(searchProjectionCheckpoint)
        .values({
          appliedSequence: ZERO_SEQUENCE,
          generation: FIRST_GENERATION,
          indexName,
          schemaHash: marker,
        })
        .onConflictDoNothing()
        .returning({ generation: searchProjectionCheckpoint.generation });
      if (inserted.length > 0) {
        return {
          action: "started",
          generation: FIRST_GENERATION,
          highWaterId,
          pendingMarker: marker,
          previous: null,
        };
      }
      checkpoint = await readCheckpoint(transaction, indexName, true);
    }

    if (checkpoint === null) {
      throw new Error(
        `Search projection checkpoint missing for index ${indexName}`
      );
    }

    const pending = parsePendingMarker(checkpoint.schemaHash);
    if (pending) {
      if (pending.schemaHash !== expectedSchemaHash) {
        throw new SearchReindexPendingGenerationError(
          pending.schemaHash,
          expectedSchemaHash
        );
      }
      return {
        action: "resumed",
        generation: checkpoint.generation,
        highWaterId: pending.highWaterId,
        pendingMarker: checkpoint.schemaHash,
        previous: checkpoint,
      };
    }

    if (checkpoint.schemaHash === expectedSchemaHash && !force) {
      return {
        action: "already-current",
        generation: checkpoint.generation,
        highWaterId: null,
        pendingMarker: null,
        previous: checkpoint,
      };
    }

    const highWaterId = await readHighWaterId(transaction);
    const marker = pendingMarker(expectedSchemaHash, highWaterId);
    const [started] = await transaction
      .update(searchProjectionCheckpoint)
      .set({
        appliedSequence: ZERO_SEQUENCE,
        generation: checkpoint.generation + 1,
        schemaHash: marker,
        updatedAt: new Date(),
      })
      .where(eq(searchProjectionCheckpoint.indexName, indexName))
      .returning({ generation: searchProjectionCheckpoint.generation });
    if (!started) {
      throw new SearchReindexGenerationChangedError(
        indexName,
        checkpoint.generation
      );
    }
    return {
      action: "started",
      generation: started.generation,
      highWaterId,
      pendingMarker: marker,
      previous: checkpoint,
    };
  });

const pageWhere = (cursor: string | null, highWaterId: string | null) => {
  const clauses = [];
  if (cursor !== null) {
    clauses.push(gt(aanvraag.id, cursor));
  }
  if (highWaterId !== null) {
    clauses.push(lte(aanvraag.id, highWaterId));
  }
  return clauses.length === 0 ? undefined : and(...clauses);
};

const selectPage = async (
  database: BronRuntimeDatabase,
  cursor: string | null,
  highWaterId: string | null,
  pageSize: number
): Promise<string[]> => {
  const rows = await database
    .select({ id: aanvraag.id })
    .from(aanvraag)
    .where(pageWhere(cursor, highWaterId))
    .orderBy(asc(aanvraag.id))
    .limit(pageSize);
  return rows.map((row) => row.id);
};

interface AppliedPage {
  enqueued: number;
  ids: string[];
}

const enqueuePage = (
  database: BronRuntimeDatabase,
  indexName: string,
  generation: number,
  marker: string,
  highWaterId: string | null,
  cursor: string | null,
  pageSize: number
): Promise<AppliedPage> =>
  database.transaction(async (transaction) => {
    await lockSearchIndexCoordination(transaction, indexName);
    assertPendingGeneration(
      await readCheckpoint(transaction, indexName, true),
      indexName,
      generation,
      marker
    );
    const ids = await selectPage(transaction, cursor, highWaterId, pageSize);
    if (ids.length === 0) {
      return { enqueued: 0, ids };
    }
    const inserted = await transaction
      .insert(outboxEvent)
      .values(
        ids.map((aggregateId) => ({
          aggregateId,
          aggregateType: "aanvraag",
          eventType: SEARCH_REINDEX_EVENT_TYPE,
          id: searchReindexEventId(indexName, generation, aggregateId),
          payload: {
            reden: "search_generation_reindex",
            search_generation: generation,
            search_index_name: indexName,
          },
        }))
      )
      .onConflictDoNothing({ target: outboxEvent.id })
      .returning({ id: outboxEvent.id });
    return { enqueued: inserted.length, ids };
  });

const countDeadLetteredReplayEvents = async (
  database: BronRuntimeDatabase,
  indexName: string,
  generation: number
): Promise<number> => {
  const [row] = await database.execute<{ count: number }>(sql`
    SELECT COUNT(*)::integer AS count
    FROM curated.outbox_event
    WHERE event_type = ${SEARCH_REINDEX_EVENT_TYPE}
      AND dead_lettered_at IS NOT NULL
      AND payload @> ${JSON.stringify({
        search_generation: generation,
        search_index_name: indexName,
      })}::jsonb
  `);
  return row?.count ?? 0;
};

const finalizeGeneration = (
  database: BronRuntimeDatabase,
  indexName: string,
  generation: number,
  marker: string,
  expectedSchemaHash: string
): Promise<number> =>
  database.transaction(async (transaction) => {
    await lockSearchIndexCoordination(transaction, indexName);
    assertPendingGeneration(
      await readCheckpoint(transaction, indexName, true),
      indexName,
      generation,
      marker
    );
    const deadLettered = await countDeadLetteredReplayEvents(
      transaction,
      indexName,
      generation
    );
    if (deadLettered > 0) {
      return deadLettered;
    }
    const finalized = await transaction
      .update(searchProjectionCheckpoint)
      .set({ schemaHash: expectedSchemaHash, updatedAt: new Date() })
      .where(
        and(
          eq(searchProjectionCheckpoint.indexName, indexName),
          eq(searchProjectionCheckpoint.generation, generation),
          eq(searchProjectionCheckpoint.schemaHash, marker)
        )
      )
      .returning({ generation: searchProjectionCheckpoint.generation });
    if (finalized.length !== 1) {
      throw new SearchReindexGenerationChangedError(indexName, generation);
    }
    return 0;
  });

/**
 * Starts a durable full replay for the current aanvraag corpus.
 *
 * The checkpoint is first moved to a generation-specific pending marker. The
 * projector refuses that marker, so only a complete, durable event set can
 * release the target SEARCH_SCHEMA_HASH. Existing projection-state rows and
 * historical processed events are intentionally ignored: neither proves that
 * Manticore still has a document in this new generation.
 *
 * The snapshot boundary is the greatest UUID at the start. UUIDs inserted
 * after that boundary already own normal outbox events; a newly inserted UUID
 * that sorts before the cursor is safe for the same reason. Operators should
 * stop the singleton projector before an authoritative rebuild, then restart
 * it after this function finalizes the checkpoint.
 */
export const runSearchReindex = async (
  input: RunSearchReindexInput
): Promise<RunSearchReindexResult> => {
  const pageSize = validatePageSize(
    input.pageSize ?? SEARCH_REINDEX_DEFAULT_PAGE_SIZE
  );
  const expectedSchemaHash = input.expectedSchemaHash ?? SEARCH_SCHEMA_HASH;
  const indexName = input.indexName ?? SEARCH_INDEX_NAME;
  const force = input.force === true;

  const generation = input.apply
    ? await beginGeneration(
        input.database,
        indexName,
        expectedSchemaHash,
        force
      )
    : await inspectGeneration(
        input.database,
        indexName,
        expectedSchemaHash,
        force
      );

  if (generation.action === "already-current") {
    return {
      action: "already-current",
      blockedDeadLetter: 0,
      dryRun: !input.apply,
      enqueued: 0,
      existing: 0,
      finalized: true,
      generation: generation.generation,
      highWaterId: null,
      planned: 0,
      scanned: 0,
    };
  }

  const marker =
    generation.pendingMarker ??
    pendingMarker(expectedSchemaHash, generation.highWaterId);
  if (input.apply && generation.action === "started") {
    await input.onGenerationStarted?.({
      generation: generation.generation,
      highWaterId: generation.highWaterId,
    });
  }

  let cursor: string | null = null;
  let enqueued = 0;
  let existing = 0;
  let planned = 0;
  let scanned = 0;
  let page = 0;

  /* oxlint-disable no-await-in-loop -- durable keyset pages are deliberately sequential */
  for (;;) {
    const next: AppliedPage = input.apply
      ? await enqueuePage(
          input.database,
          indexName,
          generation.generation,
          marker,
          generation.highWaterId,
          cursor,
          pageSize
        )
      : {
          enqueued: 0,
          ids: await selectPage(
            input.database,
            cursor,
            generation.highWaterId,
            pageSize
          ),
        };
    if (next.ids.length === 0) {
      break;
    }
    page += 1;
    cursor = next.ids.at(-1) ?? null;
    scanned += next.ids.length;
    planned += next.ids.length;
    enqueued += next.enqueued;
    existing += input.apply ? next.ids.length - next.enqueued : 0;
    await input.onPage?.({
      enqueued,
      generation: generation.generation,
      highWaterId: generation.highWaterId,
      page,
      scanned,
    });
  }
  /* oxlint-enable no-await-in-loop */

  if (!input.apply) {
    const blockedDeadLetter =
      generation.action === "resumed"
        ? await countDeadLetteredReplayEvents(
            input.database,
            indexName,
            generation.generation
          )
        : 0;
    return {
      action: generation.action === "resumed" ? "would-resume" : "would-start",
      blockedDeadLetter,
      dryRun: true,
      enqueued: 0,
      existing: 0,
      finalized: false,
      generation: generation.generation,
      highWaterId: generation.highWaterId,
      planned,
      scanned,
    };
  }

  const blockedDeadLetter = await finalizeGeneration(
    input.database,
    indexName,
    generation.generation,
    marker,
    expectedSchemaHash
  );
  return {
    action: generation.action,
    blockedDeadLetter,
    dryRun: false,
    enqueued,
    existing,
    finalized: blockedDeadLetter === 0,
    generation: generation.generation,
    highWaterId: generation.highWaterId,
    planned,
    scanned,
  };
};
