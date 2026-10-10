import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import path from "node:path";

import { hashDocumentId, projectionHash } from "@ji/search";
import type { SearchPartition } from "@ji/search";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresSearchDocumentLoader } from "./aanvraag-stores";
import type { BronRuntimeDatabase } from "./bron-runtime";
import {
  PROJECTION_REPAIR_EVENT_TYPE,
  manticoreIdsForBoundedLookup,
  ProjectionRepairSchemaMismatchError,
  reconcileProjection,
} from "./projection-repair";
import type {
  SearchProjectionInventoryPort,
  SearchProjectionInventoryRecord,
} from "./projection-repair";
import * as schema from "./schema";
import {
  aanvraag,
  bron,
  outboxEvent,
  scrapeRun,
  searchProjectionCheckpoint,
  searchProjectionState,
} from "./schema";
import { PostgresSearchVersionStore } from "./search-version-store";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
const NOW = new Date("2026-09-01T06:00:00.000Z");
const collidingHash = (): number => 42;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

type TestDatabase = BronRuntimeDatabase;

const seededAggregateIds: string[] = [];
const seededBronIds: string[] = [];
const seededIndexNames: string[] = [];

type InventoryRows = Record<
  SearchPartition,
  readonly SearchProjectionInventoryRecord[]
>;

class FakeManticoreInventory implements SearchProjectionInventoryPort {
  readonly pageRequests: {
    afterManticoreId: number | null;
    limit: number;
    partition: SearchPartition;
  }[] = [];
  private readonly rows: Record<
    SearchPartition,
    SearchProjectionInventoryRecord[]
  >;
  private readonly beforeDelete?: (
    partition: SearchPartition,
    rows: readonly SearchProjectionInventoryRecord[]
  ) => void;

  constructor(
    rows: InventoryRows,
    beforeDelete?: (
      partition: SearchPartition,
      rows: readonly SearchProjectionInventoryRecord[]
    ) => void
  ) {
    this.rows = {
      active: [...rows.active].toSorted(
        (left, right) => left.manticoreId - right.manticoreId
      ),
      archive: [...rows.archive].toSorted(
        (left, right) => left.manticoreId - right.manticoreId
      ),
    };
    this.beforeDelete = beforeDelete;
  }

  count(partition: SearchPartition): Promise<number> {
    return Promise.resolve(this.rows[partition].length);
  }

  findByDocumentIds(
    partition: SearchPartition,
    documentIds: readonly string[],
    limit: number
  ): Promise<readonly SearchProjectionInventoryRecord[]> {
    const ids = new Set(manticoreIdsForBoundedLookup(documentIds));
    return Promise.resolve(
      this.rows[partition]
        .filter((row) => ids.has(row.manticoreId))
        .slice(0, limit)
    );
  }

  deleteObservedRows(
    partition: SearchPartition,
    rows: readonly SearchProjectionInventoryRecord[]
  ): Promise<number> {
    this.beforeDelete?.(partition, rows);
    const observations = new Set(
      rows.map(
        (row) =>
          `${row.manticoreId}\u0000${row.documentId}\u0000${row.projectionHash}`
      )
    );
    const before = this.rows[partition].length;
    this.rows[partition] = this.rows[partition].filter(
      (row) =>
        !observations.has(
          `${row.manticoreId}\u0000${row.documentId}\u0000${row.projectionHash}`
        )
    );
    return Promise.resolve(before - this.rows[partition].length);
  }

  replaceRows(
    partition: SearchPartition,
    rows: readonly SearchProjectionInventoryRecord[]
  ): void {
    this.rows[partition] = [...rows];
  }

  rowsFor(
    partition: SearchPartition
  ): readonly SearchProjectionInventoryRecord[] {
    return this.rows[partition];
  }

  listPage(
    partition: SearchPartition,
    afterManticoreId: number | null,
    limit: number
  ): Promise<readonly SearchProjectionInventoryRecord[]> {
    this.pageRequests.push({ afterManticoreId, limit, partition });
    return Promise.resolve(
      this.rows[partition]
        .filter(
          (row) =>
            afterManticoreId === null || row.manticoreId > afterManticoreId
        )
        .slice(0, limit)
    );
  }
}

const lowUuid = (version: "4" | "7" = "4"): string =>
  `00000000-0000-${version}000-8000-${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const seedAanvraag = async (
  db: TestDatabase,
  id: string = crypto.randomUUID(),
  location?: { land: string; tekst: string | null }
): Promise<string> => {
  const bronId = crypto.randomUUID();
  seededBronIds.push(bronId);
  const runId = crypto.randomUUID();
  await db.insert(bron).values({
    actief: true,
    categorie: "msp_broker",
    crawlDelayMs: 0,
    id: bronId,
    ingestieType: "html",
    interval: "*/15 * * * *",
    naam: `Hero ${bronId}`,
    rateLimitPerMinute: 600,
    retentionDays: 30,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  });
  await db.insert(scrapeRun).values({ bronId, id: runId });
  const [row] = await db
    .insert(aanvraag)
    .values({
      beschrijving: "beschrijving",
      bronId,
      bronReferentie: "A",
      contentHash: "hash-1",
      eersteGezienOp: NOW,
      extractieMethode: "html_parser",
      id,
      laatstGezienOp: NOW,
      locatieLand: location?.land ?? "NL",
      locatieTekst: location?.tekst ?? null,
      opdrachtgeverNaam: null,
      publicatiedatum: null,
      rawPayloadRef: "raw/hero/A.html",
      scrapeRunId: runId,
      status: "active",
      tariefEenheid: null,
      titel: "titel",
      versie: 1,
      werkvorm: null,
    })
    .returning({ id: aanvraag.id });
  if (!row) {
    throw new Error("Failed to seed aanvraag");
  }
  seededAggregateIds.push(row.id);
  return row.id;
};

/**
 * Own checkpoint and a practically unique generation per test:
 * search_projection_state rows are scoped by generation only, so a shared
 * small number would pull other specs' lingering rows into the scan.
 */
const isolatedVersionStore = async (db: TestDatabase) => {
  const indexName = `repair-spec-${crypto.randomUUID()}`;
  seededIndexNames.push(indexName);
  const store = new PostgresSearchVersionStore(db, { indexName });
  await store.read();
  const generation = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  await db
    .update(schema.searchProjectionCheckpoint)
    .set({ generation })
    .where(eq(schema.searchProjectionCheckpoint.indexName, indexName));
  return { generation, indexName, store };
};

describe("reconcileProjection (RJC-399 repair tool)", () => {
  let available = false;
  let migratorClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let database: TestDatabase | undefined;
  let isolatedDatabase: TestDatabase | undefined;
  let releaseIsolation: (() => void) | undefined;
  let isolation: Promise<void> | undefined;

  beforeAll(async () => {
    available = await isPostgresAvailable();
    if (!available) {
      if (databaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    migratorClient = postgres(migratorUrl, { max: 1 });
    await migrate(drizzle(migratorClient, { schema }), { migrationsFolder });
    client = postgres(applicationUrl, { max: 1 });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await migratorClient?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    if (!database) {
      return;
    }
    const ready = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    releaseIsolation = () => release.resolve(null);
    isolation = (async () => {
      try {
        await database.transaction(
          async (transaction) => {
            await transaction.delete(outboxEvent);
            await transaction.delete(searchProjectionState);
            await transaction.delete(aanvraag);
            await transaction.delete(searchProjectionCheckpoint);
            isolatedDatabase = transaction;
            ready.resolve(null);
            await release.promise;
            throw new Error("rollback isolated projection-repair spec corpus");
          },
          { isolationLevel: "repeatable read" }
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "rollback isolated projection-repair spec corpus"
        ) {
          throw error;
        }
      }
    })();
    await ready.promise;
  });

  afterEach(async () => {
    releaseIsolation?.();
    await isolation;
    isolatedDatabase = undefined;
    releaseIsolation = undefined;
    isolation = undefined;
    seededAggregateIds.length = 0;
    seededBronIds.length = 0;
    seededIndexNames.length = 0;
  });

  const requireDatabase = (): TestDatabase => {
    if (!isolatedDatabase) {
      throw new Error("isolated database unavailable");
    }
    return isolatedDatabase;
  };

  it("preserves unknown, Dutch and non-Dutch locations in single and bulk projector loads", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const unknownId = await seedAanvraag(db, crypto.randomUUID(), {
      land: "NL",
      tekst: null,
    });
    const dutchId = await seedAanvraag(db, crypto.randomUUID(), {
      land: "NL",
      tekst: "Amsterdam",
    });
    const belgianId = await seedAanvraag(db, crypto.randomUUID(), {
      land: "BE",
      tekst: "Brussel",
    });
    const loader = new PostgresSearchDocumentLoader(db);

    const singleDocuments = await Promise.all(
      [unknownId, dutchId, belgianId].map((id) => loader.loadByAggregateId(id))
    );
    expect(singleDocuments.map((document) => document?.locatie)).toEqual([
      null,
      "Amsterdam",
      "Brussel",
    ]);
    expect(singleDocuments.map((document) => document?.locatieLand)).toEqual([
      null,
      "NL",
      "BE",
    ]);

    const bulkDocuments = await loader.loadManyByAggregateIds([
      unknownId,
      dutchId,
      belgianId,
    ]);
    expect(bulkDocuments.get(unknownId)).toMatchObject({
      locatie: null,
      locatieLand: null,
    });
    expect(bulkDocuments.get(dutchId)).toMatchObject({
      locatie: "Amsterdam",
      locatieLand: "NL",
    });
    expect(bulkDocuments.get(belgianId)).toMatchObject({
      locatie: "Brussel",
      locatieLand: "BE",
    });
  });

  it("fails closed before a bounded lookup can use duplicate numeric ids", () => {
    const firstDocumentId = crypto.randomUUID();
    const secondDocumentId = crypto.randomUUID();
    const scanIds = new Map<number, string>();
    expect(
      manticoreIdsForBoundedLookup([firstDocumentId], scanIds, collidingHash)
    ).toEqual([42]);
    expect(() =>
      manticoreIdsForBoundedLookup([secondDocumentId], scanIds, collidingHash)
    ).toThrow(
      `duplicate numeric id 42 for ${firstDocumentId} and ${secondDocumentId}`
    );
  });

  it("models production numeric-id lookup and preserves a replacement during compare-delete", async () => {
    const requestedDocumentId = crypto.randomUUID();
    const canonicalRow: SearchProjectionInventoryRecord = {
      documentId: requestedDocumentId,
      manticoreId: hashDocumentId(requestedDocumentId),
      projectionHash: "canonical-hash",
    };
    const corruptOccupant: SearchProjectionInventoryRecord = {
      ...canonicalRow,
      documentId: "wrong-document-id-at-canonical-numeric-id",
      projectionHash: "corrupt-hash",
    };
    const inventory = new FakeManticoreInventory(
      { active: [corruptOccupant], archive: [] },
      () => inventory.replaceRows("active", [canonicalRow])
    );

    const lookupRows = await inventory.findByDocumentIds(
      "active",
      [requestedDocumentId],
      2
    );
    expect(lookupRows).toEqual([corruptOccupant]);
    expect(await inventory.deleteObservedRows("active", lookupRows)).toBe(0);
    expect(inventory.rowsFor("active")).toEqual([canonicalRow]);
  });

  it("finds a hand-crafted divergence, repairs it once, and is idempotent", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const aggregateId = await seedAanvraag(db);
    const loader = new PostgresSearchDocumentLoader(db);
    const { generation, indexName, store } = await isolatedVersionStore(db);

    // The projector applied the row as it was, then the status changed
    // without an outbox event — the pre-RJC-399 crash window.
    const document = await loader.loadByAggregateId(aggregateId);
    if (!document) {
      throw new Error("Expected seeded document to load");
    }
    const appliedHash = projectionHash(document, NOW);
    await db.insert(searchProjectionState).values({
      aggregateId,
      appliedSequence: 1n,
      generation,
      projectionHash: appliedHash,
    });
    await db
      .update(aanvraag)
      .set({ status: "stale" })
      .where(eq(aanvraag.id, aggregateId));
    const inventory = new FakeManticoreInventory({
      active: [
        {
          documentId: aggregateId,
          manticoreId: hashDocumentId(aggregateId),
          projectionHash: appliedHash,
        },
      ],
      archive: [],
    });

    const base = {
      database: db,
      indexName,
      inventory,
      loader,
      now: NOW,
      versionStore: store,
    };

    const dryRun = await reconcileProjection({ apply: false, ...base });
    expect(dryRun.generation).toBe(generation);
    expect(dryRun.checked).toBe(1);
    expect(dryRun.applied).toBe(0);
    expect(dryRun.divergent.map((entry) => entry.aggregateId)).toEqual([
      aggregateId,
    ]);
    const eventsAfterDryRun = await db
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, aggregateId));
    expect(eventsAfterDryRun).toHaveLength(0);

    const applied = await reconcileProjection({ apply: true, ...base });
    expect(applied).toMatchObject({ applied: 1, skippedPending: 0 });
    const repairEvents = await db
      .select({
        eventType: outboxEvent.eventType,
        payload: outboxEvent.payload,
      })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.aggregateId, aggregateId),
          eq(outboxEvent.eventType, PROJECTION_REPAIR_EVENT_TYPE)
        )
      );
    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0]?.payload).toMatchObject({
      reden: "projection_repair",
    });

    // Second apply: the pending repair event covers the aggregate.
    const again = await reconcileProjection({ apply: true, ...base });
    expect(again).toMatchObject({ applied: 0, skippedPending: 1 });
    expect(
      await db
        .select({ id: outboxEvent.id })
        .from(outboxEvent)
        .where(
          and(
            eq(outboxEvent.aggregateId, aggregateId),
            eq(outboxEvent.eventType, PROJECTION_REPAIR_EVENT_TYPE)
          )
        )
    ).toHaveLength(1);
  });

  it("reconciles real-engine inventory drift with bounded, durable repairs", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const [
      healthyId,
      missingEngineId,
      wrongPartitionId,
      duplicateId,
      missingStateId,
    ] = await Promise.all([
      seedAanvraag(db, lowUuid()),
      seedAanvraag(db, lowUuid()),
      seedAanvraag(db, lowUuid()),
      seedAanvraag(db, lowUuid()),
      seedAanvraag(db, lowUuid()),
    ]);
    if (
      !healthyId ||
      !missingEngineId ||
      !wrongPartitionId ||
      !duplicateId ||
      !missingStateId
    ) {
      throw new Error("Expected five seeded aanvragen");
    }
    const loader = new PostgresSearchDocumentLoader(db);
    const { generation, indexName, store } = await isolatedVersionStore(db);
    const persistCurrentState = async (aggregateId: string): Promise<void> => {
      const document = await loader.loadByAggregateId(aggregateId);
      if (!document) {
        throw new Error(`Expected seeded document ${aggregateId}`);
      }
      await db.insert(searchProjectionState).values({
        aggregateId,
        appliedSequence: 1n,
        generation,
        projectionHash: projectionHash(document, NOW),
      });
    };
    await Promise.all(
      [healthyId, missingEngineId, wrongPartitionId, duplicateId].map(
        persistCurrentState
      )
    );

    // UUIDv7 is a valid PostgreSQL UUID even though the app currently emits
    // UUIDv4. Its orphan must receive a delete just like a v4 orphan.
    const orphanId = lowUuid("7");
    const invalidDocumentId = "broken-manticore-document-id";
    const physicalRow = async (
      documentId: string
    ): Promise<SearchProjectionInventoryRecord> => {
      const document = await loader.loadByAggregateId(documentId);
      if (!document) {
        throw new Error(`Expected seeded document ${documentId}`);
      }
      return {
        documentId,
        manticoreId: hashDocumentId(documentId),
        projectionHash: projectionHash(document, NOW),
      };
    };
    const healthyRow = await physicalRow(healthyId);
    const wrongPartitionRow = await physicalRow(wrongPartitionId);
    const duplicateRow = await physicalRow(duplicateId);
    const missingStateRow = await physicalRow(missingStateId);
    const nonCanonicalDuplicate = {
      ...healthyRow,
      manticoreId: healthyRow.manticoreId + 1,
    };
    const inventory = new FakeManticoreInventory({
      active: [
        healthyRow,
        nonCanonicalDuplicate,
        duplicateRow,
        { ...missingStateRow, projectionHash: "stale-physical-hash" },
        {
          documentId: orphanId,
          manticoreId: hashDocumentId(orphanId),
          projectionHash: "orphan",
        },
        {
          documentId: invalidDocumentId,
          manticoreId: 600,
          projectionHash: "invalid",
        },
      ],
      archive: [wrongPartitionRow, duplicateRow],
    });
    const base = {
      database: db,
      indexName,
      inventory,
      loader,
      now: NOW,
      pageSize: 2,
      versionStore: store,
    };

    await expect(
      reconcileProjection({ apply: false, ...base, pageSize: 1001 })
    ).rejects.toThrow("projection repair pageSize");
    await expect(
      reconcileProjection({ apply: false, ...base, sampleLimit: 0 })
    ).rejects.toThrow("projection repair sampleLimit");

    const report = await reconcileProjection({
      apply: false,
      ...base,
      sampleLimit: 20,
    });
    expect(report.checked).toBe(5);
    expect(report.inventoryCounts).toEqual({ active: 6, archive: 2 });
    expect(report.inventoryScannedCounts).toEqual({ active: 6, archive: 2 });
    expect(report.inventoryFinalCounts).toEqual({ active: 6, archive: 2 });
    expect(report.manticoreChecked).toBe(8);
    expect(report.orphanManticore).toContain(orphanId);
    expect(report.orphanManticoreCount).toBe(1);
    expect(report.invalidDocumentId).toContain(invalidDocumentId);
    expect(report.invalidDocumentIdCount).toBe(1);
    expect(report.physicalCorruptionCount).toBe(2);
    expect(report.physicalCorruption).not.toContainEqual(
      expect.objectContaining({
        documentId: healthyId,
        manticoreId: healthyRow.manticoreId,
      })
    );
    expect(report.staleManticoreHashCount).toBe(1);
    expect(report.missingProjectionStateCount).toBe(1);

    const reasonsFor = (aggregateId: string) =>
      report.divergent.find((entry) => entry.aggregateId === aggregateId)
        ?.reasons;
    expect(reasonsFor(missingEngineId)).toEqual(["missing_manticore_document"]);
    expect(reasonsFor(wrongPartitionId)).toEqual(["wrong_manticore_partition"]);
    expect(reasonsFor(duplicateId)).toEqual(["duplicate_manticore_document"]);
    expect(reasonsFor(missingStateId)).toEqual([
      "manticore_projection_hash_mismatch",
      "missing_projection_state",
    ]);

    const capped = await reconcileProjection({
      apply: false,
      ...base,
      sampleLimit: 2,
    });
    expect(capped.divergent).toHaveLength(2);
    expect(capped.divergentCount).toBe(4);
    expect(inventory.pageRequests.every((request) => request.limit === 2)).toBe(
      true
    );

    const applied = await reconcileProjection({
      apply: true,
      ...base,
      sampleLimit: 2,
    });
    expect(applied.applied).toBe(5);
    expect(applied.physicalCleanupCount).toBe(2);
    const eventRows = await db
      .select({
        aggregateId: outboxEvent.aggregateId,
        eventType: outboxEvent.eventType,
      })
      .from(outboxEvent)
      .where(
        inArray(outboxEvent.aggregateId, [
          missingEngineId,
          wrongPartitionId,
          duplicateId,
          missingStateId,
          orphanId,
        ])
      );
    const repairedIds = eventRows
      .filter((row) => row.eventType === PROJECTION_REPAIR_EVENT_TYPE)
      .map((row) => row.aggregateId)
      .toSorted();
    expect(repairedIds).toEqual(
      [
        missingEngineId,
        wrongPartitionId,
        duplicateId,
        missingStateId,
      ].toSorted()
    );
    expect(
      eventRows.filter(
        (row) =>
          row.aggregateId === orphanId &&
          row.eventType === "aanvraag.verwijderd"
      )
    ).toHaveLength(1);
    const remainingState = await db
      .select({ aggregateId: searchProjectionState.aggregateId })
      .from(searchProjectionState)
      .where(
        inArray(searchProjectionState.aggregateId, [
          healthyId,
          missingEngineId,
          wrongPartitionId,
          duplicateId,
        ])
      );
    expect(remainingState).toEqual([{ aggregateId: healthyId }]);

    const repeated = await reconcileProjection({
      apply: true,
      ...base,
      sampleLimit: 2,
    });
    expect(repeated.applied).toBe(0);
    expect(repeated.skippedPending).toBe(5);
  });

  it("rejects an inventory page whose numeric-id cursor is not ordered", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const { indexName, store } = await isolatedVersionStore(requireDatabase());
    const malformedInventory: SearchProjectionInventoryPort = {
      count: () => Promise.resolve(2),
      findByDocumentIds: () => Promise.resolve([]),
      listPage: (partition) =>
        Promise.resolve(
          partition === "active"
            ? [
                {
                  documentId: "bad-first",
                  manticoreId: 2,
                  projectionHash: "bad-first",
                },
                {
                  documentId: "bad-second",
                  manticoreId: 1,
                  projectionHash: "bad-second",
                },
              ]
            : []
        ),
    };
    await expect(
      reconcileProjection({
        apply: false,
        database: requireDatabase(),
        indexName,
        inventory: malformedInventory,
        loader: new PostgresSearchDocumentLoader(requireDatabase()),
        pageSize: 2,
        versionStore: store,
      })
    ).rejects.toThrow("strictly ascending numeric ids");
  });

  it("refuses to run when the checkpoint schema hash differs from the code's", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const { indexName, store } = await isolatedVersionStore(db);
    await expect(
      reconcileProjection({
        apply: false,
        database: db,
        expectedSchemaHash: "some-newer-schema-hash",
        indexName,
        inventory: new FakeManticoreInventory({ active: [], archive: [] }),
        loader: new PostgresSearchDocumentLoader(db),
        versionStore: store,
      })
    ).rejects.toThrow(ProjectionRepairSchemaMismatchError);
  });

  it("fails closed on a numeric-id collision across one-row source pages", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    await Promise.all([
      seedAanvraag(db, lowUuid()),
      seedAanvraag(db, lowUuid()),
    ]);
    const { indexName, store } = await isolatedVersionStore(db);
    const inventory = new FakeManticoreInventory({ active: [], archive: [] });

    await expect(
      reconcileProjection({
        apply: false,
        database: db,
        indexName,
        inventory,
        loader: new PostgresSearchDocumentLoader(db),
        lookupManticoreId: () => 42,
        pageSize: 1,
        versionStore: store,
      })
    ).rejects.toThrow("duplicate numeric id 42");
  });

  it("does not delete a canonical row that replaces an observed corrupt row before cleanup", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const aggregateId = await seedAanvraag(db, lowUuid());
    const loader = new PostgresSearchDocumentLoader(db);
    const { generation, indexName, store } = await isolatedVersionStore(db);
    const document = await loader.loadByAggregateId(aggregateId);
    if (!document) {
      throw new Error("Expected seeded document to load");
    }
    const canonicalRow: SearchProjectionInventoryRecord = {
      documentId: aggregateId,
      manticoreId: hashDocumentId(aggregateId),
      projectionHash: projectionHash(document, NOW),
    };
    await db.insert(searchProjectionState).values({
      aggregateId,
      appliedSequence: 1n,
      generation,
      projectionHash: canonicalRow.projectionHash,
    });
    const observedCorruptRow: SearchProjectionInventoryRecord = {
      ...canonicalRow,
      documentId: "corrupt-before-concurrent-repair",
    };
    let replaced = false;
    const inventory = new FakeManticoreInventory(
      { active: [observedCorruptRow], archive: [] },
      (partition) => {
        if (!replaced && partition === "active") {
          replaced = true;
          inventory.replaceRows("active", [canonicalRow]);
        }
      }
    );

    const result = await reconcileProjection({
      apply: true,
      database: db,
      indexName,
      inventory,
      loader,
      now: NOW,
      versionStore: store,
    });

    expect(replaced).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.divergent).toEqual([
      expect.objectContaining({
        aggregateId,
        reasons: ["missing_manticore_document"],
      }),
    ]);
    expect(result.physicalCorruptionCount).toBe(1);
    expect(result.physicalCleanupCount).toBe(0);
    expect(result.inventoryFinalCounts).toEqual({ active: 1, archive: 0 });
    expect(inventory.rowsFor("active")).toEqual([canonicalRow]);
  });
});
