/* oxlint-disable max-classes-per-file -- distinct exported errors are operator-visible recovery contracts. */

import {
  documentPartition,
  hashDocumentId,
  projectionHash,
  SEARCH_INDEX_NAME,
  SEARCH_SCHEMA_HASH,
} from "@ji/search";
import type {
  BulkSearchDocumentLoader,
  SearchPartition,
  SearchVersionStore,
} from "@ji/search";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import type { BronRuntimeDatabase } from "./bron-runtime";
import { aanvraag, outboxEvent, searchProjectionState } from "./schema/curated";
import {
  lockSearchIndexCoordination,
  readSearchIndexCheckpoint,
} from "./search-index-coordination";

/** Synthetic upsert emitted after a proven search-projection divergence. */
export const PROJECTION_REPAIR_EVENT_TYPE = "aanvraag.projection_repair";

/** State, curated-row, and Manticore inventory operations are bounded by this default. */
export const PROJECTION_REPAIR_DEFAULT_PAGE_SIZE = 200;

/** Operator output retains a useful sample without retaining an unbounded corpus. */
export const PROJECTION_REPAIR_DEFAULT_SAMPLE_LIMIT = 20;

const DELETE_EVENT_TYPE = "aanvraag.verwijderd";
const INVENTORY_PARTITIONS: readonly SearchPartition[] = ["active", "archive"];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface PartitionCounts {
  active: number;
  archive: number;
}

const emptyPartitionCounts = (): PartitionCounts => ({ active: 0, archive: 0 });

/**
 * A concrete Manticore reader belongs in the operator tool, not @ji/db. The
 * port deliberately exposes only bounded inventory queries, which keeps the
 * reconciliation algorithm testable and prevents a full index from being
 * materialised in process memory.
 */
export interface SearchProjectionInventoryPort {
  count: (partition: SearchPartition) => Promise<number>;
  /**
   * Bounded lookup of the canonical physical ids derived from a source page.
   * Non-canonical duplicates are discovered by the numeric inventory scan.
   */
  findByDocumentIds: (
    partition: SearchPartition,
    documentIds: readonly string[],
    limit: number
  ) => Promise<readonly SearchProjectionInventoryRecord[]>;
  listPage: (
    partition: SearchPartition,
    afterManticoreId: number | null,
    limit: number
  ) => Promise<readonly SearchProjectionInventoryRecord[]>;
  /**
   * Compare-and-deletes physical RT rows that cannot be reached by the normal
   * document-id-derived projector delete. Implementations must match the full
   * observed fingerprint so a concurrent replacement at the same numeric id
   * survives. Required only for `apply` when a complete preflight found
   * malformed, duplicate, or non-canonical rows.
   */
  deleteObservedRows?: (
    partition: SearchPartition,
    rows: readonly SearchProjectionInventoryRecord[]
  ) => Promise<number>;
}

/** One physical Manticore row. manticoreId is the numeric RT id, not document_id. */
export interface SearchProjectionInventoryRecord {
  documentId: string;
  manticoreId: number;
  /** The v4 physical fingerprint of the canonical source projection. */
  projectionHash: string;
}

export class ProjectionRepairSchemaMismatchError extends Error {
  constructor(checkpointHash: string, expectedHash: string) {
    super(
      `Projection checkpoint carries schema hash ${
        checkpointHash
      } but the running code expects ${
        expectedHash
      }. The drain is halted on a schema migration; follow docs/runbooks/search-schema-migration.md instead of running this repair.`
    );
    this.name = "ProjectionRepairSchemaMismatchError";
  }
}

export class ProjectionRepairGenerationChangedError extends Error {
  constructor(expectedGeneration: number, actualGeneration: number) {
    super(
      `Projection generation changed from ${expectedGeneration} to ${
        actualGeneration
      } during reconciliation. No further repair page was applied; rerun against the current generation.`
    );
    this.name = "ProjectionRepairGenerationChangedError";
  }
}

export type ProjectionPhysicalCorruptionReason =
  | "invalid_document_id"
  | "invalid_manticore_id"
  | "noncanonical_manticore_id"
  | "same_partition_duplicate";

/**
 * A physical row that normal projector events cannot safely remove. The
 * sample retains the exact numeric Manticore id for an operator's scoped
 * cleanup, rather than pretending a UUID-derived delete reaches it.
 */
export interface ProjectionPhysicalCorruption {
  documentId: string;
  manticoreId: number;
  partition: SearchPartition;
  reasons: readonly ProjectionPhysicalCorruptionReason[];
}

/** A capped source-vs-physical fingerprint discrepancy. */
export interface ManticoreProjectionHashDrift {
  actualProjectionHashes: readonly string[];
  aggregateId: string;
  expectedProjectionHash: string;
  partitions: readonly SearchPartition[];
}

/**
 * Raised when inventory pagination/lookup cannot prove a complete snapshot,
 * or when an apply would rely on a physical row a normal event cannot clean.
 */
export class ProjectionRepairInventorySafetyError extends Error {
  readonly physicalCorruption: readonly ProjectionPhysicalCorruption[];

  constructor(
    message: string,
    physicalCorruption: readonly ProjectionPhysicalCorruption[] = []
  ) {
    super(message);
    this.name = "ProjectionRepairInventorySafetyError";
    this.physicalCorruption = physicalCorruption;
  }
}

/** Specific subtype for early/short/over-sized/count-changing scans. */
export class ProjectionRepairInventoryCompletenessError extends ProjectionRepairInventorySafetyError {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionRepairInventoryCompletenessError";
  }
}

/** Specific subtype used when apply refuses corrupt physical rows. */
export class ProjectionRepairPhysicalCorruptionError extends ProjectionRepairInventorySafetyError {
  constructor(physicalCorruption: readonly ProjectionPhysicalCorruption[]) {
    super(
      `Manticore physical corruption blocks repair: ${physicalCorruption
        .map((row) =>
          [
            row.partition,
            String(row.manticoreId),
            row.documentId,
            `(${row.reasons.join(", ")})`,
          ].join("/")
        )
        .join(
          "; "
        )}. Perform a scoped physical cleanup, then rerun reconciliation.`,
      physicalCorruption
    );
    this.name = "ProjectionRepairPhysicalCorruptionError";
  }
}

/**
 * Resolves the only physical ids a bounded document lookup may return.
 * Duplicate numeric ids are ambiguous (including a hash collision) and must
 * fail closed before querying or interpreting Manticore rows.
 */
export const manticoreIdsForBoundedLookup = (
  documentIds: readonly string[],
  seen: Map<number, string> = new Map<number, string>(),
  hash: (documentId: string) => number = hashDocumentId
): number[] => {
  const manticoreIds: number[] = [];
  for (const documentId of documentIds) {
    const manticoreId = hash(documentId);
    const existing = seen.get(manticoreId);
    if (existing !== undefined) {
      throw new ProjectionRepairInventorySafetyError(
        `Manticore bounded lookup request has duplicate numeric id ${manticoreId} for ${existing} and ${documentId}`
      );
    }
    seen.set(manticoreId, documentId);
    manticoreIds.push(manticoreId);
  }
  return manticoreIds;
};

export type ProjectionDivergenceReason =
  | "duplicate_manticore_document"
  | "manticore_projection_hash_mismatch"
  | "missing_manticore_document"
  | "missing_projection_state"
  | "projection_hash_mismatch"
  | "wrong_manticore_partition";

export interface ProjectionDivergence {
  aggregateId: string;
  /** Partitions in which Manticore currently reports the document. */
  actualPartitions: readonly SearchPartition[];
  /** Hash of the aanvraag row as the projector would index it at this run's fixed now. */
  currentHash: string;
  expectedPartition: SearchPartition;
  /** Null means no current-generation state exists. */
  projectedHash: string | null;
  reasons: readonly ProjectionDivergenceReason[];
}

export interface ReconcileProjectionInput {
  /** False reports; true emits bounded durable repair/delete events. */
  apply: boolean;
  database: BronRuntimeDatabase;
  /** Schema hash the running code was built for (default SEARCH_SCHEMA_HASH). */
  expectedSchemaHash?: string;
  /** Actual Manticore inventory scanned alongside curated.aanvraag. */
  inventory: SearchProjectionInventoryPort;
  /** Logical checkpoint namespace (default @ji/search index name). */
  indexName?: string;
  loader: BulkSearchDocumentLoader;
  /** Partition boundaries in projectionHash depend on time; injectable for specs. */
  now?: Date;
  /** Bounded curated/Manticore page size. */
  pageSize?: number;
  /** Deterministic test seam for cross-page numeric-id collision handling. */
  lookupManticoreId?: (documentId: string) => number;
  /** Capped samples retained in the result. Exact totals are tracked separately. */
  sampleLimit?: number;
  /**
   * Retained for checkpoint initialization compatibility. Every actual
   * reconciliation fence is read directly from the named checkpoint row.
   */
  versionStore: SearchVersionStore;
}

export interface ReconcileProjectionResult {
  /** Repair or orphan-delete events inserted (0 on a dry run). */
  applied: number;
  /** Current curated aanvragen checked. */
  checked: number;
  /** Capped sample of distinct divergent current aanvragen. */
  divergent: ProjectionDivergence[];
  /** Exact number of divergent current aanvragen. */
  divergentCount: number;
  /** Expected physical documents from Postgres-loaded source documents. */
  expectedPartitionCounts: PartitionCounts | null;
  /** Current fenced projection generation. */
  generation: number;
  /**
   * Initial Manticore counts, retained under the old public property name.
   * See inventoryFinalCounts and inventoryScannedCounts for completeness.
   */
  inventoryCounts: PartitionCounts | null;
  /** Count read again after each numeric-id partition scan. */
  inventoryFinalCounts: PartitionCounts | null;
  /** Exact physical numeric-id rows scanned in each partition. */
  inventoryScannedCounts: PartitionCounts | null;
  /** Capped physical Manticore rows whose document_id is not a UUID. */
  invalidDocumentId: string[];
  invalidDocumentIdCount: number;
  /** Capped physical rows that normal projector events cannot safely clean. */
  physicalCorruption: ProjectionPhysicalCorruption[];
  physicalCorruptionCount: number;
  /** Exact physical rows deleted through the inventory operator port. */
  physicalCleanupCount: number;
  /** Capped physical projection_hash drift samples. */
  staleManticoreHash: ManticoreProjectionHashDrift[];
  staleManticoreHashCount: number;
  /** Physical Manticore rows inspected through numeric-id keyset pages. */
  manticoreChecked: number;
  /** Capped current aanvraag ids whose source document no longer loads. */
  missingDocument: string[];
  missingDocumentCount: number;
  /** Exact current aanvragen with no current-generation projection state. */
  missingProjectionStateCount: number;
  /** Capped valid UUIDs present in Manticore but absent from curated.aanvraag. */
  orphanManticore: string[];
  orphanManticoreCount: number;
  /** Current aanvraag repair candidates already covered by an open outbox event. */
  skippedPending: number;
}

interface RepairCandidate {
  actualPartitions: SearchPartition[];
  aggregateId: string;
  currentHash: string;
  expectedPartition: SearchPartition;
  invalidateState: boolean;
  projectedHash: string | null;
  reasons: Set<ProjectionDivergenceReason>;
}

interface RepairApplyResult {
  applied: number;
  skippedPending: number;
}

interface ScanResult {
  applied: number;
  checked: number;
  divergent: ProjectionDivergence[];
  divergentCount: number;
  expectedPartitionCounts: PartitionCounts | null;
  inventoryCounts: PartitionCounts | null;
  inventoryFinalCounts: PartitionCounts | null;
  inventoryScannedCounts: PartitionCounts | null;
  invalidDocumentId: string[];
  invalidDocumentIdCount: number;
  manticoreChecked: number;
  missingDocument: string[];
  missingDocumentCount: number;
  missingProjectionStateCount: number;
  orphanManticore: string[];
  orphanManticoreCount: number;
  physicalCorruption: ProjectionPhysicalCorruption[];
  physicalCorruptionCount: number;
  physicalCleanupCount: number;
  staleManticoreHash: ManticoreProjectionHashDrift[];
  staleManticoreHashCount: number;
  skippedPending: number;
}

interface ScanActions {
  applyOrphanCleanup: (
    orphanIds: readonly string[]
  ) => Promise<RepairApplyResult>;
  applyRepair: (
    candidates: readonly RepairCandidate[]
  ) => Promise<RepairApplyResult>;
  cleanupPhysical: (
    partition: SearchPartition,
    rows: readonly SearchProjectionInventoryRecord[]
  ) => Promise<number>;
}

interface MutablePhysicalCorruption {
  documentId: string;
  manticoreId: number;
  partition: SearchPartition;
  reasons: Set<ProjectionPhysicalCorruptionReason>;
}

const validatePositiveInteger = (
  value: number,
  name: string,
  maximum: number
): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
};

const addSample = <Value>(
  sample: Value[],
  value: Value,
  limit: number
): void => {
  if (sample.length < limit) {
    sample.push(value);
  }
};

const toCounts = (counts: PartitionCounts): PartitionCounts => ({
  active: counts.active,
  archive: counts.archive,
});

const isCanonicalUuid = (value: string): boolean => UUID_PATTERN.test(value);

const physicalRowKey = (
  partition: SearchPartition,
  row: SearchProjectionInventoryRecord
): string => [partition, String(row.manticoreId), row.documentId].join(":");

const physicalRowCanUseNormalDelete = (
  row: SearchProjectionInventoryRecord
): boolean =>
  isCanonicalUuid(row.documentId) &&
  Number.isSafeInteger(row.manticoreId) &&
  row.manticoreId >= 0 &&
  row.manticoreId === hashDocumentId(row.documentId);

class PhysicalObservationTracker {
  private readonly corruptions = new Map<string, MutablePhysicalCorruption>();
  private readonly invalidDocumentIds = new Set<string>();
  private invalidDocumentIdRows = 0;
  private readonly seenInvalidDocumentRows = new Set<string>();

  observe(
    partition: SearchPartition,
    row: SearchProjectionInventoryRecord
  ): void {
    const key = physicalRowKey(partition, row);
    if (!isCanonicalUuid(row.documentId)) {
      if (!this.seenInvalidDocumentRows.has(key)) {
        this.seenInvalidDocumentRows.add(key);
        this.invalidDocumentIdRows += 1;
        this.invalidDocumentIds.add(row.documentId);
      }
      this.record(partition, row, "invalid_document_id");
      return;
    }
    if (!Number.isSafeInteger(row.manticoreId) || row.manticoreId < 0) {
      this.record(partition, row, "invalid_manticore_id");
      return;
    }
    if (row.manticoreId !== hashDocumentId(row.documentId)) {
      this.record(partition, row, "noncanonical_manticore_id");
    }
  }

  recordDuplicate(
    partition: SearchPartition,
    rows: readonly SearchProjectionInventoryRecord[]
  ): void {
    for (const row of rows) {
      if (!physicalRowCanUseNormalDelete(row)) {
        this.record(partition, row, "same_partition_duplicate");
      }
    }
  }

  invalidDocumentIdCount(): number {
    return this.invalidDocumentIdRows;
  }

  invalidDocumentIdSamples(limit: number): string[] {
    return [...this.invalidDocumentIds].slice(0, limit);
  }

  corruptionCount(): number {
    return this.corruptions.size;
  }

  corruptionSamples(limit: number): ProjectionPhysicalCorruption[] {
    return [...this.corruptions.values()].slice(0, limit).map((row) => ({
      documentId: row.documentId,
      manticoreId: row.manticoreId,
      partition: row.partition,
      reasons: [...row.reasons].toSorted(),
    }));
  }

  private record(
    partition: SearchPartition,
    row: SearchProjectionInventoryRecord,
    reason: ProjectionPhysicalCorruptionReason
  ): void {
    const key = physicalRowKey(partition, row);
    const existing = this.corruptions.get(key);
    if (existing) {
      existing.reasons.add(reason);
      return;
    }
    this.corruptions.set(key, {
      documentId: row.documentId,
      manticoreId: row.manticoreId,
      partition,
      reasons: new Set([reason]),
    });
  }
}

const groupRowsByDocumentId = (
  rows: readonly SearchProjectionInventoryRecord[]
): Map<string, SearchProjectionInventoryRecord[]> => {
  const grouped = new Map<string, SearchProjectionInventoryRecord[]>();
  for (const row of rows) {
    const existing = grouped.get(row.documentId);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.documentId, [row]);
    }
  }
  return grouped;
};

const assertCheckpoint = (
  checkpoint: {
    generation: number;
    schemaHash: string;
  },
  expectedSchemaHash: string,
  generation?: number
): number => {
  if (checkpoint.schemaHash !== expectedSchemaHash) {
    throw new ProjectionRepairSchemaMismatchError(
      checkpoint.schemaHash,
      expectedSchemaHash
    );
  }
  if (generation !== undefined && checkpoint.generation !== generation) {
    throw new ProjectionRepairGenerationChangedError(
      generation,
      checkpoint.generation
    );
  }
  return checkpoint.generation;
};

/**
 * versionStore remains the compatibility initializer, but all fences read
 * exactly the named database checkpoint. This prevents a store configured
 * for another logical index from falsely approving an apply transaction.
 */
const readFencedCheckpoint = async (
  input: ReconcileProjectionInput,
  indexName: string,
  expectedSchemaHash: string,
  generation?: number,
  database: BronRuntimeDatabase = input.database,
  forUpdate = false
): Promise<number> => {
  let checkpoint = await readSearchIndexCheckpoint(
    database,
    indexName,
    forUpdate
  );
  if (checkpoint === null && !forUpdate) {
    await input.versionStore.read();
    checkpoint = await readSearchIndexCheckpoint(database, indexName);
  }
  if (checkpoint === null) {
    throw new Error(
      `Search projection checkpoint missing for index ${indexName}`
    );
  }
  return assertCheckpoint(checkpoint, expectedSchemaHash, generation);
};

const pendingAggregateIds = async (
  database: BronRuntimeDatabase,
  aggregateIds: readonly string[],
  eventType?: string
): Promise<Set<string>> => {
  if (aggregateIds.length === 0) {
    return new Set();
  }
  const rows = await database
    .select({ aggregateId: outboxEvent.aggregateId })
    .from(outboxEvent)
    .where(
      and(
        inArray(outboxEvent.aggregateId, [...aggregateIds]),
        isNull(outboxEvent.processedAt),
        isNull(outboxEvent.deadLetteredAt),
        eventType === undefined
          ? undefined
          : eq(outboxEvent.eventType, eventType)
      )
    );
  return new Set(rows.map((row) => row.aggregateId));
};

const toDivergence = (candidate: RepairCandidate): ProjectionDivergence => ({
  actualPartitions: candidate.actualPartitions,
  aggregateId: candidate.aggregateId,
  currentHash: candidate.currentHash,
  expectedPartition: candidate.expectedPartition,
  projectedHash: candidate.projectedHash,
  reasons: [...candidate.reasons].toSorted(),
});

const addRepairReason = (
  candidates: Map<string, RepairCandidate>,
  input: {
    actualPartitions: readonly SearchPartition[];
    aggregateId: string;
    currentHash: string;
    expectedPartition: SearchPartition;
    invalidateState: boolean;
    projectedHash: string | null;
    reason: ProjectionDivergenceReason;
  }
): void => {
  const current = candidates.get(input.aggregateId);
  if (current) {
    current.invalidateState ||= input.invalidateState;
    current.reasons.add(input.reason);
    return;
  }
  candidates.set(input.aggregateId, {
    actualPartitions: [...input.actualPartitions],
    aggregateId: input.aggregateId,
    currentHash: input.currentHash,
    expectedPartition: input.expectedPartition,
    invalidateState: input.invalidateState,
    projectedHash: input.projectedHash,
    reasons: new Set([input.reason]),
  });
};

/**
 * State invalidation shares the transaction with the repair event. Without
 * it, a matching Postgres state hash can make the projector skip an event
 * even though the physical row is missing, stale, or misplaced.
 */
const applyRepairCandidates = async (
  database: BronRuntimeDatabase,
  candidates: readonly RepairCandidate[],
  generation: number
): Promise<RepairApplyResult> => {
  if (candidates.length === 0) {
    return { applied: 0, skippedPending: 0 };
  }
  const aggregateIds = candidates.map((candidate) => candidate.aggregateId);
  const pending = await pendingAggregateIds(database, aggregateIds);
  const invalidateIds = candidates
    .filter((candidate) => candidate.invalidateState)
    .map((candidate) => candidate.aggregateId);
  if (invalidateIds.length > 0) {
    await database
      .delete(searchProjectionState)
      .where(
        and(
          eq(searchProjectionState.generation, generation),
          inArray(searchProjectionState.aggregateId, invalidateIds)
        )
      );
  }
  const repairable = candidates.filter(
    (candidate) => !pending.has(candidate.aggregateId)
  );
  if (repairable.length === 0) {
    return { applied: 0, skippedPending: pending.size };
  }
  const inserted = await database
    .insert(outboxEvent)
    .values(
      repairable.map((candidate) => ({
        aggregateId: candidate.aggregateId,
        aggregateType: "aanvraag",
        eventType: PROJECTION_REPAIR_EVENT_TYPE,
        payload: {
          actual_partitions: candidate.actualPartitions,
          current_hash: candidate.currentHash,
          expected_partition: candidate.expectedPartition,
          projected_hash: candidate.projectedHash,
          reasons: [...candidate.reasons].toSorted(),
          reden: "projection_repair",
        },
      }))
    )
    .returning({ id: outboxEvent.id });
  return { applied: inserted.length, skippedPending: pending.size };
};

const applyOrphanCleanup = async (
  database: BronRuntimeDatabase,
  orphanIds: readonly string[],
  generation: number
): Promise<RepairApplyResult> => {
  const uniqueIds = [...new Set(orphanIds)];
  if (uniqueIds.length === 0) {
    return { applied: 0, skippedPending: 0 };
  }
  // A newly written curated row wins over a stale Manticore read.
  const currentRows = await database
    .select({ id: aanvraag.id })
    .from(aanvraag)
    .where(inArray(aanvraag.id, uniqueIds));
  const currentIds = new Set(currentRows.map((row) => row.id));
  const stillOrphaned = uniqueIds.filter((id) => !currentIds.has(id));
  if (stillOrphaned.length === 0) {
    return { applied: 0, skippedPending: 0 };
  }
  const pending = await pendingAggregateIds(
    database,
    stillOrphaned,
    DELETE_EVENT_TYPE
  );
  await database
    .delete(searchProjectionState)
    .where(
      and(
        eq(searchProjectionState.generation, generation),
        inArray(searchProjectionState.aggregateId, stillOrphaned)
      )
    );
  const repairable = stillOrphaned.filter((id) => !pending.has(id));
  if (repairable.length === 0) {
    return { applied: 0, skippedPending: pending.size };
  }
  const inserted = await database
    .insert(outboxEvent)
    .values(
      repairable.map((aggregateId) => ({
        aggregateId,
        aggregateType: "aanvraag",
        eventType: DELETE_EVENT_TYPE,
        payload: { reden: "projection_repair_orphan_manticore_document" },
      }))
    )
    .returning({ id: outboxEvent.id });
  return { applied: inserted.length, skippedPending: pending.size };
};

const selectAanvraagPage = (
  database: BronRuntimeDatabase,
  cursor: string | null,
  pageSize: number
) =>
  database
    .select({ id: aanvraag.id })
    .from(aanvraag)
    .where(cursor === null ? undefined : gt(aanvraag.id, cursor))
    .orderBy(asc(aanvraag.id))
    .limit(pageSize);

const assertInventoryPage = (
  rows: readonly SearchProjectionInventoryRecord[],
  pageSize: number,
  partition: SearchPartition,
  cursor: number | null
): void => {
  if (rows.length > pageSize) {
    throw new ProjectionRepairInventoryCompletenessError(
      `Manticore ${partition} inventory returned ${rows.length} rows for a ${
        pageSize
      }-row page`
    );
  }
  let previousManticoreId = cursor;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.manticoreId) || row.manticoreId < 0) {
      throw new ProjectionRepairInventorySafetyError(
        `Manticore ${partition} inventory returned invalid numeric id ${
          row.manticoreId
        }`,
        [
          {
            documentId: row.documentId,
            manticoreId: row.manticoreId,
            partition,
            reasons: ["invalid_manticore_id"],
          },
        ]
      );
    }
    if (
      previousManticoreId !== null &&
      row.manticoreId <= previousManticoreId
    ) {
      throw new ProjectionRepairInventorySafetyError(
        `Manticore ${
          partition
        } inventory did not return strictly ascending numeric ids`
      );
    }
    previousManticoreId = row.manticoreId;
  }
};

const assertBoundedLookup = (
  rows: readonly SearchProjectionInventoryRecord[],
  partition: SearchPartition,
  documentIds: readonly string[],
  limit: number
): void => {
  if (rows.length > limit) {
    throw new ProjectionRepairInventorySafetyError(
      `Manticore ${partition} lookup exceeded its ${limit}-row bound`
    );
  }
  if (rows.length > documentIds.length) {
    throw new ProjectionRepairInventorySafetyError(
      `Manticore ${
        partition
      } canonical lookup returned more than one row per requested document`
    );
  }
  const requested = new Set(manticoreIdsForBoundedLookup(documentIds));
  const returned = new Set<number>();
  for (const row of rows) {
    if (!requested.has(row.manticoreId)) {
      throw new ProjectionRepairInventorySafetyError(
        `Manticore ${
          partition
        } lookup returned numeric id outside its requested bounded page`
      );
    }
    if (returned.has(row.manticoreId)) {
      throw new ProjectionRepairInventorySafetyError(
        `Manticore ${partition} lookup returned duplicate numeric id ${row.manticoreId}`
      );
    }
    returned.add(row.manticoreId);
  }
};

const assertLookupIncludesRows = (
  lookupRows: readonly SearchProjectionInventoryRecord[],
  pageRows: readonly SearchProjectionInventoryRecord[],
  partition: SearchPartition
): void => {
  const lookupKeys = new Set(
    lookupRows.map((row) => physicalRowKey(partition, row))
  );
  for (const row of pageRows) {
    if (!lookupKeys.has(physicalRowKey(partition, row))) {
      throw new ProjectionRepairInventorySafetyError(
        `Manticore ${
          partition
        } bounded lookup omitted a physical row from its numeric-id scan`
      );
    }
  }
};

const observePhysicalRows = (
  tracker: PhysicalObservationTracker,
  partition: SearchPartition,
  rows: readonly SearchProjectionInventoryRecord[]
): Map<string, SearchProjectionInventoryRecord[]> => {
  const grouped = groupRowsByDocumentId(rows);
  for (const row of rows) {
    tracker.observe(partition, row);
  }
  for (const groupedRows of grouped.values()) {
    if (groupedRows.length > 1) {
      tracker.recordDuplicate(partition, groupedRows);
    }
  }
  return grouped;
};

const allPhysicalRows = (
  activeRows: readonly SearchProjectionInventoryRecord[],
  archiveRows: readonly SearchProjectionInventoryRecord[]
): {
  partition: SearchPartition;
  row: SearchProjectionInventoryRecord;
}[] => [
  ...activeRows.map((row) => ({ partition: "active" as const, row })),
  ...archiveRows.map((row) => ({ partition: "archive" as const, row })),
];

const toScanResult = (input: {
  applied: number;
  checked: number;
  divergent: ProjectionDivergence[];
  divergentCount: number;
  expectedPartitionCounts: PartitionCounts | null;
  inventoryCounts: PartitionCounts | null;
  inventoryFinalCounts: PartitionCounts | null;
  inventoryScannedCounts: PartitionCounts | null;
  missingDocument: string[];
  missingDocumentCount: number;
  missingProjectionStateCount: number;
  orphanManticore: Set<string>;
  physical: PhysicalObservationTracker;
  physicalCleanupCount: number;
  sampleLimit: number;
  staleManticoreHash: Map<string, ManticoreProjectionHashDrift>;
  skippedPending: number;
}): ScanResult => {
  const physicalCorruption = input.physical.corruptionSamples(
    input.sampleLimit
  );
  return {
    applied: input.applied,
    checked: input.checked,
    divergent: input.divergent,
    divergentCount: input.divergentCount,
    expectedPartitionCounts: input.expectedPartitionCounts,
    invalidDocumentId: input.physical.invalidDocumentIdSamples(
      input.sampleLimit
    ),
    invalidDocumentIdCount: input.physical.invalidDocumentIdCount(),
    inventoryCounts: input.inventoryCounts,
    inventoryFinalCounts: input.inventoryFinalCounts,
    inventoryScannedCounts: input.inventoryScannedCounts,
    manticoreChecked:
      input.inventoryScannedCounts?.active === undefined
        ? 0
        : input.inventoryScannedCounts.active +
          input.inventoryScannedCounts.archive,
    missingDocument: input.missingDocument,
    missingDocumentCount: input.missingDocumentCount,
    missingProjectionStateCount: input.missingProjectionStateCount,
    orphanManticore: [...input.orphanManticore].slice(0, input.sampleLimit),
    orphanManticoreCount: input.orphanManticore.size,
    physicalCleanupCount: input.physicalCleanupCount,
    physicalCorruption,
    physicalCorruptionCount: input.physical.corruptionCount(),
    skippedPending: input.skippedPending,
    staleManticoreHash: [...input.staleManticoreHash.values()].slice(
      0,
      input.sampleLimit
    ),
    staleManticoreHashCount: input.staleManticoreHash.size,
  };
};

interface ScanOptions {
  actions?: ScanActions;
  database: BronRuntimeDatabase;
  expectedSchemaHash: string;
  fence: () => Promise<void>;
  generation: number;
  input: ReconcileProjectionInput;
  now: Date;
  pageSize: number;
  sampleLimit: number;
}

const addCandidatesToReport = (
  candidates: readonly RepairCandidate[],
  divergent: ProjectionDivergence[],
  sampleLimit: number
): number => {
  for (const candidate of candidates) {
    addSample(divergent, toDivergence(candidate), sampleLimit);
  }
  return candidates.length;
};

const addApplyResult = (
  total: RepairApplyResult,
  next: RepairApplyResult
): void => {
  total.applied += next.applied;
  total.skippedPending += next.skippedPending;
};

const stateByAggregateId = async (
  database: BronRuntimeDatabase,
  generation: number,
  aggregateIds: readonly string[]
): Promise<Map<string, string>> => {
  if (aggregateIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .select({
      aggregateId: searchProjectionState.aggregateId,
      projectionHash: searchProjectionState.projectionHash,
    })
    .from(searchProjectionState)
    .where(
      and(
        eq(searchProjectionState.generation, generation),
        inArray(searchProjectionState.aggregateId, [...aggregateIds])
      )
    );
  return new Map(rows.map((row) => [row.aggregateId, row.projectionHash]));
};

const staleHashKey = (
  aggregateId: string,
  expectedProjectionHash: string
): string => `${aggregateId}:${expectedProjectionHash}`;

// oxlint-disable-next-line complexity -- the two-way reconciliation keeps one explicit accounting state machine.
const scanInventoryProjection = async (
  options: ScanOptions
): Promise<ScanResult> => {
  const { inventory } = options.input;
  const inventoryCounts = emptyPartitionCounts();
  const [activeCount, archiveCount] = await Promise.all([
    inventory.count("active"),
    inventory.count("archive"),
  ]);
  inventoryCounts.active = activeCount;
  inventoryCounts.archive = archiveCount;

  const divergent: ProjectionDivergence[] = [];
  const expectedPartitionCounts = emptyPartitionCounts();
  const missingDocument: string[] = [];
  const orphanManticore = new Set<string>();
  const physical = new PhysicalObservationTracker();
  const staleManticoreHash = new Map<string, ManticoreProjectionHashDrift>();
  const totals: RepairApplyResult = { applied: 0, skippedPending: 0 };
  let physicalCleanupCount = 0;
  let checked = 0;
  let divergentCount = 0;
  let missingDocumentCount = 0;
  let missingProjectionStateCount = 0;
  let cursor: string | null = null;
  const seenLookupManticoreIds = new Map<number, string>();

  /* oxlint-disable no-await-in-loop -- ordered bounded source pages are the consistency boundary */
  for (;;) {
    const sourceRows = await selectAanvraagPage(
      options.database,
      cursor,
      options.pageSize
    );
    if (sourceRows.length === 0) {
      break;
    }
    cursor = sourceRows.at(-1)?.id ?? null;
    const aggregateIds = sourceRows.map((row) => row.id);
    manticoreIdsForBoundedLookup(
      aggregateIds,
      seenLookupManticoreIds,
      options.input.lookupManticoreId
    );
    checked += aggregateIds.length;
    const [documents, states, activeRows, archiveRows] = await Promise.all([
      options.input.loader.loadManyByAggregateIds(aggregateIds),
      stateByAggregateId(options.database, options.generation, aggregateIds),
      inventory.findByDocumentIds(
        "active",
        aggregateIds,
        aggregateIds.length + 1
      ),
      inventory.findByDocumentIds(
        "archive",
        aggregateIds,
        aggregateIds.length + 1
      ),
    ]);
    assertBoundedLookup(
      activeRows,
      "active",
      aggregateIds,
      aggregateIds.length + 1
    );
    assertBoundedLookup(
      archiveRows,
      "archive",
      aggregateIds,
      aggregateIds.length + 1
    );
    const activeById = observePhysicalRows(physical, "active", activeRows);
    const archiveById = observePhysicalRows(physical, "archive", archiveRows);
    const candidates = new Map<string, RepairCandidate>();

    for (const aggregateId of aggregateIds) {
      const document = documents.get(aggregateId);
      if (!document) {
        missingDocumentCount += 1;
        addSample(missingDocument, aggregateId, options.sampleLimit);
        continue;
      }
      const currentHash = projectionHash(document, options.now);
      const expectedPartition = documentPartition(document, options.now);
      expectedPartitionCounts[expectedPartition] += 1;
      const projectedHash = states.get(aggregateId) ?? null;
      const active = activeById.get(aggregateId) ?? [];
      const archive = archiveById.get(aggregateId) ?? [];
      const actualPartitions: SearchPartition[] = [];
      if (active.length > 0) {
        actualPartitions.push("active");
      }
      if (archive.length > 0) {
        actualPartitions.push("archive");
      }
      const physicalRows = allPhysicalRows(active, archive);
      const actualHashes = [
        ...new Set(physicalRows.map(({ row }) => row.projectionHash)),
      ].toSorted();

      if (projectedHash === null) {
        missingProjectionStateCount += 1;
        addRepairReason(candidates, {
          actualPartitions,
          aggregateId,
          currentHash,
          expectedPartition,
          invalidateState: false,
          projectedHash,
          reason: "missing_projection_state",
        });
      } else if (projectedHash !== currentHash) {
        addRepairReason(candidates, {
          actualPartitions,
          aggregateId,
          currentHash,
          expectedPartition,
          invalidateState: false,
          projectedHash,
          reason: "projection_hash_mismatch",
        });
      }
      if (physicalRows.length === 0) {
        addRepairReason(candidates, {
          actualPartitions,
          aggregateId,
          currentHash,
          expectedPartition,
          invalidateState: true,
          projectedHash,
          reason: "missing_manticore_document",
        });
      } else if (physicalRows.length > 1) {
        addRepairReason(candidates, {
          actualPartitions,
          aggregateId,
          currentHash,
          expectedPartition,
          invalidateState: true,
          projectedHash,
          reason: "duplicate_manticore_document",
        });
      }
      if (
        actualPartitions.length === 1 &&
        actualPartitions[0] !== expectedPartition
      ) {
        addRepairReason(candidates, {
          actualPartitions,
          aggregateId,
          currentHash,
          expectedPartition,
          invalidateState: true,
          projectedHash,
          reason: "wrong_manticore_partition",
        });
      }
      if (physicalRows.some(({ row }) => row.projectionHash !== currentHash)) {
        const key = staleHashKey(aggregateId, currentHash);
        staleManticoreHash.set(key, {
          actualProjectionHashes: actualHashes,
          aggregateId,
          expectedProjectionHash: currentHash,
          partitions: actualPartitions,
        });
        addRepairReason(candidates, {
          actualPartitions,
          aggregateId,
          currentHash,
          expectedPartition,
          invalidateState: true,
          projectedHash,
          reason: "manticore_projection_hash_mismatch",
        });
      }
    }

    const pageCandidates = [...candidates.values()];
    divergentCount += addCandidatesToReport(
      pageCandidates,
      divergent,
      options.sampleLimit
    );
    if (options.actions) {
      addApplyResult(totals, await options.actions.applyRepair(pageCandidates));
    }
    await options.fence();
  }
  /* oxlint-enable no-await-in-loop */

  const inventoryScannedCounts = emptyPartitionCounts();
  const inventoryFinalCounts = emptyPartitionCounts();
  /* oxlint-disable no-await-in-loop -- numeric-id keyset pages must remain ordered */
  for (const partition of INVENTORY_PARTITIONS) {
    let manticoreCursor: number | null = null;
    let partitionCleanupCount = 0;
    for (;;) {
      const rows = await inventory.listPage(
        partition,
        manticoreCursor,
        options.pageSize
      );
      if (rows.length === 0) {
        break;
      }
      assertInventoryPage(rows, options.pageSize, partition, manticoreCursor);
      manticoreCursor = rows.at(-1)?.manticoreId ?? null;
      inventoryScannedCounts[partition] += rows.length;
      observePhysicalRows(physical, partition, rows);

      const canonicalRows = rows.filter(physicalRowCanUseNormalDelete);
      const lookupIds = [
        ...new Set(
          rows
            .filter((row) => isCanonicalUuid(row.documentId))
            .map((row) => row.documentId)
        ),
      ];
      const lookupRows = await inventory.findByDocumentIds(
        partition,
        lookupIds,
        rows.length + 1
      );
      assertBoundedLookup(lookupRows, partition, lookupIds, rows.length + 1);
      assertLookupIncludesRows(lookupRows, canonicalRows, partition);
      const canonicalDocumentIds = new Set(
        lookupRows.map((row) => row.documentId)
      );
      for (const row of rows) {
        if (
          !physicalRowCanUseNormalDelete(row) &&
          canonicalDocumentIds.has(row.documentId)
        ) {
          physical.recordDuplicate(partition, [row]);
        }
      }

      const validIds = [...new Set(canonicalRows.map((row) => row.documentId))];
      if (validIds.length > 0) {
        const currentRows = await options.database
          .select({ id: aanvraag.id })
          .from(aanvraag)
          .where(inArray(aanvraag.id, validIds));
        const currentIds = new Set(currentRows.map((row) => row.id));
        for (const id of validIds) {
          if (!currentIds.has(id)) {
            orphanManticore.add(id);
          }
        }
      }
      if (options.actions) {
        const corruptRows = rows.filter(
          (row) => !physicalRowCanUseNormalDelete(row)
        );
        const cleaned = await options.actions.cleanupPhysical(
          partition,
          corruptRows
        );
        partitionCleanupCount += cleaned;
        physicalCleanupCount += cleaned;
        addApplyResult(
          totals,
          await options.actions.applyOrphanCleanup(
            validIds.filter((id) => orphanManticore.has(id))
          )
        );
      }
      await options.fence();
    }
    inventoryFinalCounts[partition] = await inventory.count(partition);
    const expectedFinalCount =
      inventoryCounts[partition] - partitionCleanupCount;
    if (
      inventoryScannedCounts[partition] !== inventoryCounts[partition] ||
      inventoryFinalCounts[partition] !== expectedFinalCount
    ) {
      throw new ProjectionRepairInventoryCompletenessError(
        `Manticore ${
          partition
        } inventory changed or scanned incompletely: initial=${
          inventoryCounts[partition]
        }, scanned=${inventoryScannedCounts[partition]}, final=${
          inventoryFinalCounts[partition]
        }`
      );
    }
    await options.fence();
  }
  /* oxlint-enable no-await-in-loop */

  return toScanResult({
    applied: totals.applied,
    checked,
    divergent,
    divergentCount,
    expectedPartitionCounts: toCounts(expectedPartitionCounts),
    inventoryCounts: toCounts(inventoryCounts),
    inventoryFinalCounts: toCounts(inventoryFinalCounts),
    inventoryScannedCounts: toCounts(inventoryScannedCounts),
    missingDocument,
    missingDocumentCount,
    missingProjectionStateCount,
    orphanManticore,
    physical,
    physicalCleanupCount,
    sampleLimit: options.sampleLimit,
    skippedPending: totals.skippedPending,
    staleManticoreHash,
  });
};

const createApplyActions = (
  input: ReconcileProjectionInput,
  indexName: string,
  expectedSchemaHash: string,
  generation: number
): ScanActions => {
  const withinFence = <Value>(
    action: (database: BronRuntimeDatabase) => Promise<Value>
  ): Promise<Value> =>
    input.database.transaction(async (transaction) => {
      await lockSearchIndexCoordination(transaction, indexName);
      await readFencedCheckpoint(
        input,
        indexName,
        expectedSchemaHash,
        generation,
        transaction,
        true
      );
      return action(transaction);
    });

  return {
    applyOrphanCleanup: (orphanIds) =>
      withinFence((database) =>
        applyOrphanCleanup(database, orphanIds, generation)
      ),
    applyRepair: (candidates) =>
      withinFence((database) =>
        applyRepairCandidates(database, candidates, generation)
      ),
    cleanupPhysical: (partition, rows) => {
      if (rows.length === 0) {
        return Promise.resolve(0);
      }
      const { inventory } = input;
      if (!inventory.deleteObservedRows) {
        throw new ProjectionRepairPhysicalCorruptionError(
          rows.map((row) => ({
            documentId: row.documentId,
            manticoreId: row.manticoreId,
            partition,
            reasons: isCanonicalUuid(row.documentId)
              ? ["noncanonical_manticore_id"]
              : ["invalid_document_id"],
          }))
        );
      }
      const cleanup = inventory.deleteObservedRows.bind(inventory);
      return withinFence(() => cleanup(partition, rows));
    },
  };
};

export const reconcileProjection = async (
  input: ReconcileProjectionInput
): Promise<ReconcileProjectionResult> => {
  const pageSize = validatePositiveInteger(
    input.pageSize ?? PROJECTION_REPAIR_DEFAULT_PAGE_SIZE,
    "projection repair pageSize",
    1000
  );
  const sampleLimit = validatePositiveInteger(
    input.sampleLimit ?? PROJECTION_REPAIR_DEFAULT_SAMPLE_LIMIT,
    "projection repair sampleLimit",
    1000
  );
  const expectedSchemaHash = input.expectedSchemaHash ?? SEARCH_SCHEMA_HASH;
  const indexName = input.indexName ?? SEARCH_INDEX_NAME;
  const generation = await readFencedCheckpoint(
    input,
    indexName,
    expectedSchemaHash
  );
  const now = input.now ?? new Date();
  const fence = (): Promise<number> =>
    readFencedCheckpoint(input, indexName, expectedSchemaHash, generation);
  const options: ScanOptions = {
    database: input.database,
    expectedSchemaHash,
    fence: async () => {
      await fence();
    },
    generation,
    input,
    now,
    pageSize,
    sampleLimit,
  };

  // Apply always follows a complete report-only preflight. This prevents an
  // incomplete/count-changing physical scan from partially queuing repairs.
  const preflight = await scanInventoryProjection(options);
  if (!input.apply) {
    return { ...preflight, generation };
  }
  if (
    preflight.physicalCorruptionCount > 0 &&
    !input.inventory.deleteObservedRows
  ) {
    throw new ProjectionRepairPhysicalCorruptionError(
      preflight.physicalCorruption
    );
  }
  const applied = await scanInventoryProjection({
    ...options,
    actions: createApplyActions(
      input,
      indexName,
      expectedSchemaHash,
      generation
    ),
  });
  return { ...applied, generation };
};
