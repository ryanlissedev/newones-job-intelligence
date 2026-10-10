/* oxlint-disable max-classes-per-file -- the loader and engine doubles belong to this spec */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { emptySearchFacets, SEARCH_WINDOW_LIMIT } from "@ji/search";
import type {
  BulkSearchDocumentLoader,
  SearchDocument,
  SearchEngine,
  SearchIndexBatch,
  SearchIndexBatchResult,
  SearchVersion,
  SearchVersionStore,
} from "@ji/search";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  drainPostgresOutbox,
  listDeadLetteredOutboxEvents,
  readOutboxLag,
  requeueDeadLetteredOutboxEvents,
  summarizeOutboxFailures,
} from "./outbox-drain";
import * as schema from "./schema";
import { outboxEvent, searchProjectionState } from "./schema";
import { PostgresSearchVersionStore } from "./search-version-store";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
const LARGE_BATCH = 5000;

type Database = ReturnType<typeof drizzle<typeof schema>>;
type EngineSearchParams = Parameters<SearchEngine["search"]>[0];
type SearchEngineResult = Awaited<ReturnType<SearchEngine["search"]>>;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const sampleDocument = (id: string): SearchDocument => ({
  beschrijving: "Senior Azure platform engineer",
  bronId: "bron-1",
  contracttype: "detachering",
  eindklantNaam: null,
  id,
  laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 120,
  tariefMin: 80,
  titel: "Platform engineer Azure",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
});

class MapLoader implements BulkSearchDocumentLoader {
  private readonly documents = new Map<string, SearchDocument>();

  add(document: SearchDocument): void {
    this.documents.set(document.id, document);
  }

  loadByAggregateId(aggregateId: string): Promise<SearchDocument | null> {
    const document = this.documents.get(aggregateId);
    return Promise.resolve(document ? structuredClone(document) : null);
  }

  loadManyByAggregateIds(
    aggregateIds: readonly string[]
  ): Promise<Map<string, SearchDocument>> {
    const loaded = new Map<string, SearchDocument>();
    for (const aggregateId of aggregateIds) {
      const document = this.documents.get(aggregateId);
      if (document) {
        loaded.set(aggregateId, structuredClone(document));
      }
    }
    return Promise.resolve(loaded);
  }
}

/**
 * Engine double with scriptable per-mutation outcomes, mirroring the
 * Manticore engine's contract: failed ids are reported in `failures`,
 * `unapplied` ids are not written, the watermark advances to the batch
 * sequence only when everything applied (else to the highest applied
 * mutation). Counts how often each document id was written.
 */
class ScriptedEngine implements SearchEngine {
  readonly applied = new Map<string, number>();
  readonly applyStarted = Promise.withResolvers<null>();
  readonly documents = new Map<string, SearchDocument>();
  failWith = new Map<string, string>();
  /** When set, applyBatch waits here first — simulates a drain stalled mid-batch. */
  holdUntil: Promise<null> | null = null;
  /** When set, applyBatch throws this — simulates a Manticore transport failure. */
  throwWith: Error | null = null;
  unapplied = new Set<string>();
  private readonly versionStore: SearchVersionStore;

  constructor(versionStore: SearchVersionStore) {
    this.versionStore = versionStore;
  }

  async applyBatch(batch: SearchIndexBatch): Promise<SearchIndexBatchResult> {
    this.applyStarted.resolve(null);
    if (this.holdUntil) {
      await this.holdUntil;
    }
    if (this.throwWith) {
      throw this.throwWith;
    }
    const failures: { error: string; id: string }[] = [];
    const unapplied: string[] = [];
    let highestApplied: bigint | null = null;
    for (const mutation of batch.mutations) {
      const id =
        mutation.kind === "delete" ? mutation.id : mutation.document.id;
      const error = this.failWith.get(id);
      if (error !== undefined) {
        failures.push({ error, id });
        continue;
      }
      if (this.unapplied.has(id)) {
        unapplied.push(id);
        continue;
      }
      if (mutation.kind === "delete") {
        this.documents.delete(id);
      } else {
        this.documents.set(id, structuredClone(mutation.document));
      }
      this.applied.set(id, (this.applied.get(id) ?? 0) + 1);
      if (highestApplied === null || mutation.sequenceNumber > highestApplied) {
        highestApplied = mutation.sequenceNumber;
      }
    }
    let version: SearchVersion;
    if (failures.length === 0 && unapplied.length === 0) {
      version = await this.versionStore.advance(batch.appliedSequence);
    } else if (highestApplied === null) {
      version = await this.getAppliedVersion();
    } else {
      version = await this.versionStore.advance(highestApplied);
    }
    return { ...version, failures, unapplied };
  }

  deleteDocument(id: string): Promise<void> {
    this.documents.delete(id);
    return Promise.resolve();
  }

  async getAppliedVersion(): Promise<SearchVersion> {
    const checkpoint = await this.versionStore.read();
    return {
      appliedSequence: checkpoint.appliedSequence,
      generation: checkpoint.generation,
    };
  }

  async search(params: EngineSearchParams): Promise<SearchEngineResult> {
    const version = await this.getAppliedVersion();
    return {
      facets: emptySearchFacets(),
      hits: [...this.documents.keys()].map((id) => ({ id, weight: 1 })),
      incomplete: false,
      indexVersion: Number(version.appliedSequence),
      scope: params.scope ?? "active",
      total: this.documents.size,
      windowLimit: SEARCH_WINDOW_LIMIT,
    };
  }

  upsertDocument(document: SearchDocument): Promise<void> {
    this.documents.set(document.id, structuredClone(document));
    return Promise.resolve();
  }
}

describe("bulk outbox drain with row claims (RJC-389)", () => {
  let postgresAvailable = false;
  let sqlClient: ReturnType<typeof postgres> | undefined;
  let db: Database | undefined;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    sqlClient = postgres(testDatabaseUrl, { max: 2 });
    db = drizzle(sqlClient, { schema });
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  const requireDb = (): Database => {
    if (!db) {
      throw new Error("database unavailable");
    }
    return db;
  };

  const insertEvents = (
    aggregateIds: readonly string[],
    eventType = "aanvraag.nieuw"
  ): Promise<{ id: string; sequenceNumber: bigint }[]> =>
    requireDb()
      .insert(outboxEvent)
      .values(
        aggregateIds.map((aggregateId) => ({
          aggregateId,
          aggregateType: "aanvraag",
          eventType,
          payload: {},
        }))
      )
      .returning({
        id: outboxEvent.id,
        sequenceNumber: outboxEvent.sequenceNumber,
      });

  const rowById = async (id: string) => {
    const [row] = await requireDb()
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.id, id));
    if (!row) {
      throw new Error(`outbox row ${id} missing`);
    }
    return row;
  };

  const rowFieldById = async <
    Key extends keyof typeof outboxEvent.$inferSelect,
  >(
    id: string,
    key: Key
  ) => {
    const row = await rowById(id);
    return row[key];
  };

  const newStore = (indexName = `drain-${crypto.randomUUID()}`) =>
    new PostgresSearchVersionStore(requireDb(), { indexName });

  const drain = (
    engine: SearchEngine,
    store: PostgresSearchVersionStore,
    loader: MapLoader,
    options: { database?: Database; maxAttempts?: number } = {}
  ) =>
    drainPostgresOutbox({
      batchSize: LARGE_BATCH,
      database: options.database ?? requireDb(),
      engine,
      loader,
      maxAttempts: options.maxAttempts,
      versionStore: store,
    });

  it("claims with SKIP LOCKED: a row locked by another connection is left alone and applied later, exactly once", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const lockedDoc = sampleDocument(crypto.randomUUID());
    const freeDoc = sampleDocument(crypto.randomUUID());
    loader.add(lockedDoc);
    loader.add(freeDoc);
    const store = newStore();
    const engine = new ScriptedEngine(store);
    const [lockedRow] = await insertEvents([lockedDoc.id]);
    const [freeRow] = await insertEvents([freeDoc.id]);
    if (!(lockedRow && freeRow)) {
      throw new Error("insert failed");
    }

    // Connection A holds a row lock — what a concurrent drain's claim holds
    // for the duration of its UPDATE ... FOR UPDATE SKIP LOCKED statement.
    const clientA = postgres(testDatabaseUrl, { max: 1 });
    const release = Promise.withResolvers<null>();
    const locked = Promise.withResolvers<null>();
    const transactionA = clientA.begin(async (tx) => {
      await tx`SELECT id FROM curated.outbox_event WHERE id = ${lockedRow.id} FOR UPDATE`;
      locked.resolve(null);
      await release.promise;
    });
    try {
      await locked.promise;
      const first = await drain(engine, store, loader);
      expect(first.processedIds).toContain(freeRow.id);
      expect(first.processedIds).not.toContain(lockedRow.id);
      expect(await rowFieldById(lockedRow.id, "claimedUntil")).toBeNull();
      expect(first.version.appliedSequence).toBe(freeRow.sequenceNumber);
    } finally {
      release.resolve(null);
      await transactionA;
      await clientA.end({ timeout: 5 });
    }

    const second = await drain(engine, store, loader);
    expect(second.processedIds).toContain(lockedRow.id);
    expect(engine.applied.get(lockedDoc.id)).toBe(1);
    expect(engine.applied.get(freeDoc.id)).toBe(1);
    // Monotone: the lower sequence applied later did not move it back.
    expect(second.version.appliedSequence).toBe(freeRow.sequenceNumber);
    expect(await rowFieldById(lockedRow.id, "processedAt")).not.toBeNull();
  });

  it("two concurrent drains on separate connections claim disjoint rows and apply each once", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const docs = Array.from({ length: 8 }, () =>
      sampleDocument(crypto.randomUUID())
    );
    for (const doc of docs) {
      loader.add(doc);
    }
    const indexName = `drain-${crypto.randomUUID()}`;
    const storeA = newStore(indexName);
    const engine = new ScriptedEngine(storeA);
    const rows = await insertEvents(docs.map((doc) => doc.id));
    let maxSequence = 0n;
    for (const row of rows) {
      if (row.sequenceNumber > maxSequence) {
        maxSequence = row.sequenceNumber;
      }
    }

    const clientB = postgres(testDatabaseUrl, { max: 1 });
    const dbB = drizzle(clientB, { schema });
    const storeB = new PostgresSearchVersionStore(dbB, { indexName });
    try {
      const processed = new Set<string>();
      let duplicates = 0;
      for (let round = 0; round < 10; round += 1) {
        // Two drains racing on two connections, batch of 3 each, sharing
        // the engine: SKIP LOCKED must hand each row to exactly one of them.
        // oxlint-disable-next-line no-await-in-loop -- rounds run until every owned row is acked
        const [resultA, resultB] = await Promise.all([
          drainPostgresOutbox({
            batchSize: 3,
            database: requireDb(),
            engine,
            loader,
            versionStore: storeA,
          }),
          drainPostgresOutbox({
            batchSize: 3,
            database: dbB,
            engine,
            loader,
            versionStore: storeB,
          }),
        ]);
        for (const id of [...resultA.processedIds, ...resultB.processedIds]) {
          if (processed.has(id)) {
            duplicates += 1;
          }
          processed.add(id);
        }
        if (rows.every((row) => processed.has(row.id))) {
          break;
        }
      }
      expect(duplicates).toBe(0);
      expect(rows.every((row) => processed.has(row.id))).toBe(true);
      for (const doc of docs) {
        expect(engine.applied.get(doc.id)).toBe(1);
      }
      const checkpoint = await storeA.read();
      expect(checkpoint.appliedSequence >= maxSequence).toBe(true);
    } finally {
      await clientB.end({ timeout: 5 });
    }
  });

  it("acks applied rows, blames failed rows, releases unapplied rows; watermark = highest applied", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const [docA, docB, docC] = [
      sampleDocument(crypto.randomUUID()),
      sampleDocument(crypto.randomUUID()),
      sampleDocument(crypto.randomUUID()),
    ];
    for (const doc of [docA, docB, docC]) {
      loader.add(doc);
    }
    const store = newStore();
    const engine = new ScriptedEngine(store);
    engine.failWith.set(docB.id, "unknown column: 'boom'");
    engine.unapplied.add(docC.id);
    const [rowA, rowB, rowC] = await insertEvents([docA.id, docB.id, docC.id]);
    if (!(rowA && rowB && rowC)) {
      throw new Error("insert failed");
    }

    const result = await drain(engine, store, loader);

    expect(result.processedIds).toContain(rowA.id);
    expect(result.failed).toBe(1);
    expect(result.released).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(result.version.appliedSequence).toBe(rowA.sequenceNumber);

    const applied = await rowById(rowA.id);
    expect(applied.processedAt).not.toBeNull();
    expect(applied.indexVersion).toBe(Number(rowA.sequenceNumber));
    expect(applied.claimedUntil).toBeNull();

    const failed = await rowById(rowB.id);
    expect(failed.processedAt).toBeNull();
    expect(failed.retryCount).toBe(1);
    expect(failed.lastError).toBe("unknown column: 'boom'");
    expect(failed.claimedUntil).toBeNull();
    expect(failed.deadLetteredAt).toBeNull();

    const released = await rowById(rowC.id);
    expect(released.processedAt).toBeNull();
    expect(released.retryCount).toBe(0);
    expect(released.lastError).toBeNull();
    expect(released.claimedUntil).toBeNull();

    // Next drain, engine healthy: both retry and apply; watermark reaches C.
    engine.failWith.clear();
    engine.unapplied.clear();
    const retry = await drain(engine, store, loader);
    expect(retry.processedIds).toEqual(
      expect.arrayContaining([rowB.id, rowC.id])
    );
    expect(retry.version.appliedSequence).toBe(rowC.sequenceNumber);
    expect(await rowFieldById(rowB.id, "lastError")).toBeNull();
    expect(engine.applied.get(docA.id)).toBe(1);
  });

  it("dead-letters a row after maxAttempts, stops claiming it, and requeue puts it back", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const store = newStore();
    const engine = new ScriptedEngine(store);
    engine.failWith.set(doc.id, "poison");
    const [row] = await insertEvents([doc.id]);
    if (!row) {
      throw new Error("insert failed");
    }

    const first = await drain(engine, store, loader, { maxAttempts: 2 });
    expect(first.deadLettered).toBe(0);
    expect(await rowFieldById(row.id, "retryCount")).toBe(1);

    const second = await drain(engine, store, loader, { maxAttempts: 2 });
    expect(second.failed).toBe(1);
    expect(second.deadLettered).toBe(1);
    const parked = await rowById(row.id);
    expect(parked.retryCount).toBe(2);
    expect(parked.deadLetteredAt).not.toBeNull();
    expect(parked.lastError).toBe("poison");

    // Excluded from claims: a third drain neither touches nor blames it.
    const third = await drain(engine, store, loader, { maxAttempts: 2 });
    expect(third.processedIds).not.toContain(row.id);
    expect(third.failed).toBe(0);
    expect(await rowFieldById(row.id, "retryCount")).toBe(2);

    const listed = await listDeadLetteredOutboxEvents(requireDb(), 1000);
    expect(listed.find((entry) => entry.id === row.id)).toMatchObject({
      aggregateId: doc.id,
      lastError: "poison",
      retryCount: 2,
    });

    // The reconciliation view groups by last_error: one row, one error here;
    // many rows under one identical error is the batch-wide signature.
    const groups = await summarizeOutboxFailures(requireDb());
    const poisonGroup = groups.find((group) => group.lastError === "poison");
    expect(poisonGroup?.rows).toBeGreaterThanOrEqual(1);
    expect(poisonGroup?.deadLettered).toBeGreaterThanOrEqual(1);

    expect(await requeueDeadLetteredOutboxEvents(requireDb(), [row.id])).toBe(
      1
    );
    const requeued = await rowById(row.id);
    expect(requeued.deadLetteredAt).toBeNull();
    expect(requeued.retryCount).toBe(0);

    engine.failWith.clear();
    const recovered = await drain(engine, store, loader, { maxAttempts: 2 });
    expect(recovered.processedIds).toContain(row.id);
    expect(engine.applied.get(doc.id)).toBe(1);
    expect(await rowFieldById(row.id, "processedAt")).not.toBeNull();
  });

  it("skips the Manticore write when the projection hash is unchanged, but not across generations", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const store = newStore();
    const engine = new ScriptedEngine(store);

    await insertEvents([doc.id]);
    const first = await drain(engine, store, loader);
    expect(first.unchanged).toBe(0);
    expect(engine.applied.get(doc.id)).toBe(1);

    // A second event for the same, unchanged projection: acked, no write.
    const [again] = await insertEvents([doc.id], "aanvraag.gewijzigd");
    const second = await drain(engine, store, loader);
    expect(second.unchanged).toBe(1);
    expect(second.processedIds).toContain(again?.id ?? "");
    expect(engine.applied.get(doc.id)).toBe(1);
    expect(await rowFieldById(again?.id ?? "", "processedAt")).not.toBeNull();

    // A search-relevant change reindexes.
    loader.add({ ...doc, titel: "Platform engineer AWS" });
    await insertEvents([doc.id], "aanvraag.gewijzigd");
    const third = await drain(engine, store, loader);
    expect(third.unchanged).toBe(0);
    expect(engine.applied.get(doc.id)).toBe(2);

    // A new generation starts from an empty index: the same hash must not
    // suppress the write.
    const current = await store.read();
    await store.startNewGeneration(current.schemaHash);
    await insertEvents([doc.id], "aanvraag.gewijzigd");
    const fourth = await drain(engine, store, loader);
    expect(fourth.unchanged).toBe(0);
    expect(engine.applied.get(doc.id)).toBe(3);
  });

  it("does not let an old-generation upsert overwrite newer projection state", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const store = newStore();
    const engine = new ScriptedEngine(store);
    const release = Promise.withResolvers<null>();
    engine.holdUntil = release.promise;
    await insertEvents([doc.id]);

    const staleDrain = drain(engine, store, loader);
    try {
      await engine.applyStarted.promise;
      const before = await store.read();
      const rebuilt = await store.startNewGeneration(before.schemaHash);
      await requireDb().insert(searchProjectionState).values({
        aggregateId: doc.id,
        appliedSequence: 0n,
        generation: rebuilt.generation,
        projectionHash: "new-generation-state",
      });
    } finally {
      release.resolve(null);
    }
    await staleDrain;

    const [state] = await requireDb()
      .select()
      .from(searchProjectionState)
      .where(eq(searchProjectionState.aggregateId, doc.id));
    expect(state).toMatchObject({
      aggregateId: doc.id,
      appliedSequence: 0n,
      generation: 2,
      projectionHash: "new-generation-state",
    });
  });

  it("does not let an old-generation delete remove newer projection state", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const store = newStore();
    const engine = new ScriptedEngine(store);
    const release = Promise.withResolvers<null>();
    engine.holdUntil = release.promise;
    await insertEvents([doc.id], "aanvraag.verwijderd");

    const staleDrain = drain(engine, store, loader);
    try {
      await engine.applyStarted.promise;
      const before = await store.read();
      const rebuilt = await store.startNewGeneration(before.schemaHash);
      await requireDb().insert(searchProjectionState).values({
        aggregateId: doc.id,
        appliedSequence: 0n,
        generation: rebuilt.generation,
        projectionHash: "new-generation-state",
      });
    } finally {
      release.resolve(null);
    }
    await staleDrain;

    const [state] = await requireDb()
      .select()
      .from(searchProjectionState)
      .where(eq(searchProjectionState.aggregateId, doc.id));
    expect(state).toMatchObject({
      aggregateId: doc.id,
      appliedSequence: 0n,
      generation: 2,
      projectionHash: "new-generation-state",
    });
  });

  it("does not let a late-committing delete remove a document re-created after it", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const store = newStore();
    const engine = new ScriptedEngine(store);

    // Connection A inserts the delete (lower sequence) and holds it open.
    const clientA = postgres(testDatabaseUrl, { max: 1 });
    const release = Promise.withResolvers<null>();
    const inserted = Promise.withResolvers<string>();
    const transactionA = clientA.begin(async (tx) => {
      const [row] = await tx<[{ id: string }]>`
        INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload)
        VALUES (${doc.id}, 'aanvraag', 'aanvraag.verwijderd', '{}')
        RETURNING id
      `;
      inserted.resolve(row?.id ?? "");
      await release.promise;
    });
    let deleteRowId = "";
    try {
      deleteRowId = await inserted.promise;
      // The re-create commits first (higher sequence) and is applied.
      await insertEvents([doc.id]);
      const first = await drain(engine, store, loader);
      expect(first.processedIds).not.toContain(deleteRowId);
      expect(engine.documents.has(doc.id)).toBe(true);
    } finally {
      release.resolve(null);
      await transactionA;
      await clientA.end({ timeout: 5 });
    }

    // The late delete is now claimable: acked as a no-op, document kept.
    const second = await drain(engine, store, loader);
    expect(second.processedIds).toContain(deleteRowId);
    expect(second.superseded).toBe(1);
    expect(engine.documents.has(doc.id)).toBe(true);
    expect(await rowFieldById(deleteRowId, "processedAt")).not.toBeNull();

    // A delete that really is newest still deletes.
    await insertEvents([doc.id], "aanvraag.verwijderd");
    const third = await drain(engine, store, loader);
    expect(third.superseded).toBe(0);
    expect(engine.documents.has(doc.id)).toBe(false);
  });

  it("keeps one aggregate inside one drain: a sibling row is not claimed while another drain holds the aggregate", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const held = sampleDocument(crypto.randomUUID());
    const other = sampleDocument(crypto.randomUUID());
    loader.add(held);
    loader.add(other);
    const indexName = `drain-${crypto.randomUUID()}`;
    const storeA = newStore(indexName);
    const engineA = new ScriptedEngine(storeA);
    const gate = Promise.withResolvers<null>();
    engineA.holdUntil = gate.promise;
    const [first] = await insertEvents([held.id]);

    // Drain A claims seq10 and stalls inside the engine.
    const drainA = drain(engineA, storeA, loader);
    await Bun.sleep(200);
    // seq11 for the same aggregate arrives, plus an unrelated aggregate.
    const [second] = await insertEvents([held.id], "aanvraag.gewijzigd");
    const [unrelated] = await insertEvents([other.id]);

    const clientB = postgres(testDatabaseUrl, { max: 1 });
    const dbB = drizzle(clientB, { schema });
    try {
      const storeB = new PostgresSearchVersionStore(dbB, { indexName });
      const engineB = new ScriptedEngine(storeB);
      const resultB = await drainPostgresOutbox({
        batchSize: LARGE_BATCH,
        database: dbB,
        engine: engineB,
        loader,
        versionStore: storeB,
      });
      expect(resultB.processedIds).toContain(unrelated?.id ?? "");
      expect(resultB.processedIds).not.toContain(second?.id ?? "");
      expect(await rowFieldById(second?.id ?? "", "claimedUntil")).toBeNull();

      gate.resolve(null);
      const resultA = await drainA;
      expect(resultA.processedIds).toContain(first?.id ?? "");
      expect(resultA.lostLease).toBe(0);

      // Aggregate free again: seq11 is claimable.
      const after = await drainPostgresOutbox({
        batchSize: LARGE_BATCH,
        database: dbB,
        engine: engineB,
        loader,
        versionStore: storeB,
      });
      expect(after.processedIds).toContain(second?.id ?? "");
    } finally {
      gate.resolve(null);
      await clientB.end({ timeout: 5 });
    }
  });

  it("serialises claims: parallel batchSize-1 claims on one aggregate never hold different rows at once", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const indexName = `drain-${crypto.randomUUID()}`;
    const rows = [
      ...(await insertEvents([doc.id])),
      ...(await insertEvents([doc.id], "aanvraag.gewijzigd")),
      ...(await insertEvents([doc.id], "aanvraag.gewijzigd")),
    ];
    // Other specs' strays would fill a batch of 1; park them first.
    const sweeper = newStore(indexName);
    await drain(new ScriptedEngine(sweeper), sweeper, loader);

    const clientB = postgres(testDatabaseUrl, { max: 1 });
    const dbB = drizzle(clientB, { schema });
    const storeA = newStore(indexName);
    const storeB = new PostgresSearchVersionStore(dbB, { indexName });
    const engineA = new ScriptedEngine(storeA);
    const engineB = new ScriptedEngine(storeB);
    const gate = Promise.withResolvers<null>();
    engineA.holdUntil = gate.promise;
    engineB.holdUntil = gate.promise;
    // Re-open the three rows (the sweep acked them) so both drains race for them.
    await requireDb()
      .update(outboxEvent)
      .set({ claimToken: null, claimedUntil: null, processedAt: null })
      .where(
        inArray(
          outboxEvent.id,
          rows.map((row) => row.id)
        )
      );
    try {
      const claimA = drainPostgresOutbox({
        batchSize: 1,
        database: requireDb(),
        engine: engineA,
        loader,
        versionStore: storeA,
      });
      const claimB = drainPostgresOutbox({
        batchSize: 1,
        database: dbB,
        engine: engineB,
        loader,
        versionStore: storeB,
      });
      await Bun.sleep(300);
      const held = await requireDb()
        .select({ claimToken: outboxEvent.claimToken })
        .from(outboxEvent)
        .where(
          and(
            eq(outboxEvent.aggregateId, doc.id),
            isNotNull(outboxEvent.claimToken)
          )
        );
      const tokens = new Set(held.map((row) => row.claimToken));
      expect(held.length).toBe(1);
      expect(tokens.size).toBe(1);
      gate.resolve(null);
      await Promise.all([claimA, claimB]);
    } finally {
      gate.resolve(null);
      await clientB.end({ timeout: 5 });
    }
  });

  it("fences late updates with claim_token: a drain whose lease expired cannot blame or ack rows another drain took over", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const indexName = `drain-${crypto.randomUUID()}`;
    const storeA = newStore(indexName);
    const engineA = new ScriptedEngine(storeA);
    const gate = Promise.withResolvers<null>();
    engineA.holdUntil = gate.promise;
    engineA.failWith.set(doc.id, "late blame");
    const [row] = await insertEvents([doc.id]);
    if (!row) {
      throw new Error("insert failed");
    }

    const drainA = drain(engineA, storeA, loader);
    await Bun.sleep(200);
    expect(await rowFieldById(row.id, "claimedUntil")).not.toBeNull();
    // A's lease expires (artificially) while it is still stalled.
    await requireDb()
      .update(outboxEvent)
      .set({ claimedUntil: sql`now() - interval '1 second'` })
      .where(eq(outboxEvent.id, row.id));

    const clientB = postgres(testDatabaseUrl, { max: 1 });
    const dbB = drizzle(clientB, { schema });
    try {
      const storeB = new PostgresSearchVersionStore(dbB, { indexName });
      const engineB = new ScriptedEngine(storeB);
      const resultB = await drainPostgresOutbox({
        batchSize: LARGE_BATCH,
        database: dbB,
        engine: engineB,
        loader,
        versionStore: storeB,
      });
      expect(resultB.processedIds).toContain(row.id);

      gate.resolve(null);
      const resultA = await drainA;
      // A's blame matched nothing: the row stays processed and unblamed.
      expect(resultA.failed).toBe(0);
      expect(resultA.lostLease).toBe(1);
      const after = await rowById(row.id);
      expect(after.processedAt).not.toBeNull();
      expect(after.retryCount).toBe(0);
      expect(after.lastError).toBeNull();
      expect(after.deadLetteredAt).toBeNull();
    } finally {
      gate.resolve(null);
      await clientB.end({ timeout: 5 });
    }
  });

  it("releases the whole batch when the engine throws: rows are immediately re-claimable and unblamed", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const store = newStore();
    const engine = new ScriptedEngine(store);
    engine.throwWith = new Error("Manticore unreachable");
    const [row] = await insertEvents([doc.id]);
    if (!row) {
      throw new Error("insert failed");
    }

    await expect(drain(engine, store, loader)).rejects.toThrow(
      "Manticore unreachable"
    );
    const released = await rowById(row.id);
    expect(released.claimedUntil).toBeNull();
    expect(released.claimToken).toBeNull();
    expect(released.retryCount).toBe(0);
    expect(released.processedAt).toBeNull();

    engine.throwWith = null;
    const recovered = await drain(engine, store, loader);
    expect(recovered.processedIds).toContain(row.id);
  });

  it("supersedes a late-committing upsert against an aggregate already applied at a higher sequence", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const store = newStore();
    const engine = new ScriptedEngine(store);

    // Connection A inserts an upsert (lower sequence) and holds it open.
    const clientA = postgres(testDatabaseUrl, { max: 1 });
    const release = Promise.withResolvers<null>();
    const inserted = Promise.withResolvers<string>();
    const transactionA = clientA.begin(async (tx) => {
      const [held] = await tx<[{ id: string }]>`
        INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload)
        VALUES (${doc.id}, 'aanvraag', 'aanvraag.gewijzigd', '{"status":"closed"}')
        RETURNING id
      `;
      inserted.resolve(held?.id ?? "");
      await release.promise;
    });
    let lateId = "";
    try {
      lateId = await inserted.promise;
      await insertEvents([doc.id]);
      await drain(engine, store, loader);
      expect(engine.documents.get(doc.id)?.status).toBe("active");
    } finally {
      release.resolve(null);
      await transactionA;
      await clientA.end({ timeout: 5 });
    }

    const late = await drain(engine, store, loader);
    expect(late.processedIds).toContain(lateId);
    expect(late.superseded).toBe(1);
    // The stale status never reached the engine.
    expect(engine.documents.get(doc.id)?.status).toBe("active");
    expect(engine.applied.get(doc.id)).toBe(1);
  });

  it("reports outbox lag in events and seconds", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const loader = new MapLoader();
    const doc = sampleDocument(crypto.randomUUID());
    loader.add(doc);
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    const [row] = await requireDb()
      .insert(outboxEvent)
      .values({
        aggregateId: doc.id,
        aggregateType: "aanvraag",
        createdAt: oneHourAgo,
        eventType: "aanvraag.nieuw",
        payload: {},
      })
      .returning({ id: outboxEvent.id });

    const before = await readOutboxLag(requireDb());
    expect(before.events).toBeGreaterThanOrEqual(1);
    // `seconds` is EXTRACT(EPOCH FROM now() - createdAt) computed by Postgres,
    // while `oneHourAgo` was stamped from this process's Date.now(); any
    // sub-millisecond clock skew between the two clocks can put the value
    // fractionally under 3600 (observed: 3599.999937). Tolerate a small skew
    // instead of asserting exact wall-clock alignment across two clocks.
    expect(before.seconds).toBeGreaterThanOrEqual(3599.9);

    const store = newStore();
    const result = await drain(new ScriptedEngine(store), store, loader);
    expect(result.processedIds).toContain(row?.id ?? "");
    expect(result.lag.events).toBeGreaterThanOrEqual(0);
    // The hour-old row is acked; whatever is left was inserted by concurrent
    // specs moments ago.
    expect(result.lag.seconds).toBeLessThan(3600);
  });
});
