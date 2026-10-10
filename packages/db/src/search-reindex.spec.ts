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

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { BronRuntimeDatabase } from "./bron-runtime";
import * as schema from "./schema";
import {
  aanvraag,
  bron,
  outboxEvent,
  scrapeRun,
  searchProjectionCheckpoint,
  searchProjectionState,
} from "./schema";
import {
  runSearchReindex,
  SEARCH_REINDEX_EVENT_TYPE,
  searchReindexEventId,
} from "./search-reindex";
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
const NOW = new Date("2026-09-02T08:00:00.000Z");

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

type Database = BronRuntimeDatabase;

const seededAggregateIds: string[] = [];
const seededBronIds: string[] = [];
const seededIndexNames: string[] = [];

const newStore = (db: Database) => {
  const indexName = `reindex-spec-${crypto.randomUUID()}`;
  seededIndexNames.push(indexName);
  return {
    indexName,
    store: new PostgresSearchVersionStore(db, { indexName }),
  };
};

const seedAanvragen = async (
  database: Database,
  count: number
): Promise<string[]> => {
  const bronId = crypto.randomUUID();
  seededBronIds.push(bronId);
  const runId = crypto.randomUUID();
  await database.insert(bron).values({
    actief: true,
    categorie: "msp_broker",
    crawlDelayMs: 0,
    id: bronId,
    ingestieType: "html",
    interval: "*/15 * * * *",
    naam: `Reindex source ${bronId}`,
    rateLimitPerMinute: 600,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  });
  await database.insert(scrapeRun).values({ bronId, id: runId });
  const rows = await database
    .insert(aanvraag)
    .values(
      Array.from({ length: count }, (_, index) => ({
        beschrijving: `Reindex description ${index}`,
        bronId,
        bronReferentie: `reindex-${crypto.randomUUID()}`,
        contentHash: `reindex-hash-${index}`,
        eersteGezienOp: NOW,
        extractieMethode: "html_parser",
        laatstGezienOp: NOW,
        rawPayloadRef: `raw/reindex/${index}.html`,
        scrapeRunId: runId,
        status: "active",
        titel: `Reindex ${index}`,
        versie: 1,
      }))
    )
    .returning({ id: aanvraag.id });
  const aggregateIds = rows.map((row) => row.id);
  seededAggregateIds.push(...aggregateIds);
  return aggregateIds;
};

describe("runSearchReindex", () => {
  let available = false;
  let migratorClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let database: Database | undefined;
  let isolatedDatabase: Database | undefined;
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
            throw new Error("rollback isolated search-reindex spec corpus");
          },
          { isolationLevel: "repeatable read" }
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "rollback isolated search-reindex spec corpus"
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

  const requireDatabase = (): Database => {
    if (!isolatedDatabase) {
      throw new Error("isolated database unavailable");
    }
    return isolatedDatabase;
  };

  it("replays every current aanvraag despite processed history and current projection state", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const [aggregateId] = await seedAanvragen(db, 1);
    if (!aggregateId) {
      throw new Error("seeded aanvraag missing");
    }
    const { indexName, store } = newStore(db);
    const checkpoint = await store.read();
    await db.insert(searchProjectionState).values({
      aggregateId,
      appliedSequence: 99n,
      generation: checkpoint.generation,
      projectionHash: "active:already-projected",
    });
    const [historical] = await db
      .insert(outboxEvent)
      .values({
        aggregateId,
        aggregateType: "aanvraag",
        eventType: "aanvraag.gewijzigd",
        payload: {},
      })
      .returning({ id: outboxEvent.id });
    if (!historical) {
      throw new Error("historical event missing");
    }
    await db
      .update(outboxEvent)
      .set({ processedAt: sql`now()` })
      .where(eq(outboxEvent.id, historical.id));

    const result = await runSearchReindex({
      apply: true,
      database: db,
      force: true,
      indexName,
    });
    expect(result).toMatchObject({ enqueued: 1, finalized: true, scanned: 1 });
    const expectedEventId = searchReindexEventId(
      indexName,
      result.generation,
      aggregateId
    );
    const rows = await db
      .select({ id: outboxEvent.id, payload: outboxEvent.payload })
      .from(outboxEvent)
      .where(eq(outboxEvent.id, expectedEventId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      search_generation: result.generation,
    });
  });

  it("resumes safely after a crash immediately after the marker and after a committed page", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const aggregateIds = await seedAanvragen(db, 3);
    const { indexName, store } = newStore(db);
    await store.read();

    await expect(
      runSearchReindex({
        apply: true,
        database: db,
        force: true,
        indexName,
        onGenerationStarted: () => {
          throw new Error("simulate post-marker crash");
        },
        pageSize: 1,
      })
    ).rejects.toThrow("simulate post-marker crash");
    const afterMarker = await store.read();
    expect(afterMarker.schemaHash).toStartWith("search-reindex-pending:v1:");

    await expect(
      runSearchReindex({
        apply: true,
        database: db,
        indexName,
        onPage: ({ page }) => {
          if (page === 1) {
            throw new Error("simulate post-page crash");
          }
        },
        pageSize: 1,
      })
    ).rejects.toThrow("simulate post-page crash");
    const afterPage = await db
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, SEARCH_REINDEX_EVENT_TYPE),
          inArray(outboxEvent.aggregateId, aggregateIds)
        )
      );
    expect(afterPage).toHaveLength(1);

    const resumed = await runSearchReindex({
      apply: true,
      database: db,
      indexName,
      pageSize: 1,
    });
    expect(resumed.finalized).toBe(true);
    expect(resumed.existing).toBe(1);
    const replayRows = await db
      .select({ aggregateId: outboxEvent.aggregateId })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, SEARCH_REINDEX_EVENT_TYPE),
          inArray(outboxEvent.aggregateId, aggregateIds)
        )
      );
    expect(new Set(replayRows.map((row) => row.aggregateId)).size).toBe(3);
    expect(await store.read()).toMatchObject({
      generation: resumed.generation,
    });
  });

  it("keeps a generation pending for its own dead letter but ignores another index", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const [aggregateId] = await seedAanvragen(db, 1);
    if (!aggregateId) {
      throw new Error("seeded aanvraag missing");
    }
    const { indexName, store } = newStore(db);
    const initial = await store.read();
    const targetGeneration = initial.generation + 1;
    await db.insert(outboxEvent).values({
      aggregateId,
      aggregateType: "aanvraag",
      deadLetteredAt: NOW,
      eventType: SEARCH_REINDEX_EVENT_TYPE,
      payload: {
        search_generation: targetGeneration,
        search_index_name: `unrelated-${crypto.randomUUID()}`,
      },
    });

    let replayId: string | undefined;
    const blocked = await runSearchReindex({
      apply: true,
      database: db,
      force: true,
      indexName,
      onPage: async ({ generation }) => {
        replayId = searchReindexEventId(indexName, generation, aggregateId);
        await db
          .update(outboxEvent)
          .set({ deadLetteredAt: NOW })
          .where(eq(outboxEvent.id, replayId));
      },
    });
    expect(blocked).toMatchObject({
      blockedDeadLetter: 1,
      finalized: false,
      generation: targetGeneration,
    });
    const pendingCheckpoint = await store.read();
    expect(pendingCheckpoint.schemaHash).toStartWith(
      "search-reindex-pending:v1:"
    );
    if (!replayId) {
      throw new Error("replay event id was not recorded");
    }
    const [replay] = await db
      .select({ payload: outboxEvent.payload })
      .from(outboxEvent)
      .where(eq(outboxEvent.id, replayId));
    expect(replay?.payload).toMatchObject({
      search_generation: targetGeneration,
      search_index_name: indexName,
    });

    await db
      .update(outboxEvent)
      .set({ deadLetteredAt: null })
      .where(eq(outboxEvent.id, replayId));
    const resumed = await runSearchReindex({
      apply: true,
      database: db,
      indexName,
    });
    expect(resumed).toMatchObject({
      blockedDeadLetter: 0,
      finalized: true,
      generation: targetGeneration,
    });
  });

  it("concurrent operators share one pending generation without duplicate replay events", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const aggregateIds = await seedAanvragen(db, 2);
    const { indexName, store } = newStore(db);
    await store.read();
    const started = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    const first = runSearchReindex({
      apply: true,
      database: db,
      force: true,
      indexName,
      onGenerationStarted: async () => {
        started.resolve(null);
        await release.promise;
      },
    });
    await started.promise;
    try {
      const second = await runSearchReindex({
        apply: true,
        database: db,
        indexName,
      });
      expect(second).toMatchObject({ action: "resumed", finalized: true });
    } finally {
      release.resolve(null);
    }
    await expect(first).rejects.toThrow("changed while it was being scanned");
    const replayRows = await db
      .select({ aggregateId: outboxEvent.aggregateId, id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, SEARCH_REINDEX_EVENT_TYPE),
          inArray(outboxEvent.aggregateId, aggregateIds)
        )
      );
    expect(replayRows).toHaveLength(aggregateIds.length);
    expect(new Set(replayRows.map((row) => row.id)).size).toBe(
      aggregateIds.length
    );
  });

  it("is idempotent on a second applied invocation", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const aggregateIds = await seedAanvragen(db, 2);
    const { indexName, store } = newStore(db);
    await store.read();
    const first = await runSearchReindex({
      apply: true,
      database: db,
      force: true,
      indexName,
    });
    const second = await runSearchReindex({
      apply: true,
      database: db,
      indexName,
    });
    expect(second).toMatchObject({ action: "already-current", enqueued: 0 });
    const events = await db
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, SEARCH_REINDEX_EVENT_TYPE),
          inArray(outboxEvent.aggregateId, aggregateIds)
        )
      );
    expect(events).toHaveLength(aggregateIds.length);
    expect(first.enqueued).toBe(aggregateIds.length);
  });

  it("fails safely when another generation replaces the pending checkpoint mid-scan", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    await seedAanvragen(db, 2);
    const { indexName, store } = newStore(db);
    await store.read();
    await expect(
      runSearchReindex({
        apply: true,
        database: db,
        force: true,
        indexName,
        onPage: async ({ page }) => {
          if (page === 1) {
            await db
              .update(searchProjectionCheckpoint)
              .set({ schemaHash: "another-generation" })
              .where(eq(searchProjectionCheckpoint.indexName, indexName));
          }
        },
        pageSize: 1,
      })
    ).rejects.toThrow("changed while it was being scanned");
  });

  it("finalizes an empty corpus without creating outbox rows", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const { indexName, store } = newStore(db);
    await store.read();
    const result = await runSearchReindex({
      apply: true,
      database: db,
      force: true,
      indexName,
    });
    expect(result).toMatchObject({
      enqueued: 0,
      finalized: true,
      planned: 0,
      scanned: 0,
    });
  });
});
