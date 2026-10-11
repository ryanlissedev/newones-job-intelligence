import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { BronRuntimeDatabase } from "./bron-runtime";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagEnrichment,
  bron,
  outboxEvent,
  scrapeRun,
  searchProjectionCheckpoint,
  searchProjectionState,
} from "./schema";
import {
  runSearchExpirySweep,
  SEARCH_EXPIRY_SWEEP_LOCK_KEY,
} from "./search-expiry-sweep";
import { SEARCH_REINDEX_EVENT_TYPE } from "./search-reindex";
import { PostgresSearchVersionStore } from "./search-version-store";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired = process.env.REQUIRE_DATABASE_TESTS === "1";
const migrationsFolder = path.join(import.meta.dir, "migrations");
const NOW = new Date("2026-09-02T08:00:00.000Z");

const idAt = (ids: readonly string[], index: number): string => {
  const id = ids[index];
  if (!id) {
    throw new Error(`Missing fixture id at index ${index}`);
  }
  return id;
};

describe("runSearchExpirySweep", () => {
  let available = false;
  let migratorClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let database: BronRuntimeDatabase | undefined;
  const aggregateIds: string[] = [];
  const sourceIds: string[] = [];
  const runIds: string[] = [];
  const indexNames: string[] = [];

  beforeAll(async () => {
    const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
    try {
      await probe`SELECT 1`;
      available = true;
    } catch {
      available = false;
    } finally {
      await probe.end({ timeout: 1 });
    }
    if (!available) {
      if (databaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    migratorClient = postgres(migratorUrl, { max: 1 });
    await migrate(drizzle(migratorClient, { schema }), { migrationsFolder });
    client = postgres(applicationUrl, { max: 3 });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (database) {
      if (aggregateIds.length > 0) {
        await database
          .delete(outboxEvent)
          .where(inArray(outboxEvent.aggregateId, aggregateIds));
        await database
          .delete(searchProjectionState)
          .where(inArray(searchProjectionState.aggregateId, aggregateIds));
        await database
          .delete(aanvraag)
          .where(inArray(aanvraag.id, aggregateIds));
      }
      if (indexNames.length > 0) {
        await database
          .delete(searchProjectionCheckpoint)
          .where(inArray(searchProjectionCheckpoint.indexName, indexNames));
      }
      if (runIds.length > 0) {
        await database.delete(scrapeRun).where(inArray(scrapeRun.id, runIds));
      }
      if (sourceIds.length > 0) {
        await database.delete(bron).where(inArray(bron.id, sourceIds));
      }
    }
    await client?.end({ timeout: 5 });
    await migratorClient?.end({ timeout: 5 });
  });

  const requireDatabase = (): BronRuntimeDatabase => {
    if (!database) {
      throw new Error("Database unavailable");
    }
    return database;
  };

  const createCorpus = async (
    count: number,
    options: {
      deadline?: Date | null;
      hash?: string;
      missingState?: boolean;
      overlayDeadline?: Date;
    } = {}
  ): Promise<{ generation: number; ids: string[]; indexName: string }> => {
    const db = requireDatabase();
    const sourceId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const indexName = `expiry-sweep-spec-${crypto.randomUUID()}`;
    sourceIds.push(sourceId);
    runIds.push(runId);
    indexNames.push(indexName);
    await db.insert(bron).values({
      actief: true,
      categorie: "msp_broker",
      id: sourceId,
      ingestieType: "html",
      interval: "*/15 * * * *",
      naam: `Expiry source ${sourceId}`,
      rateLimitPerMinute: 600,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
    await db.insert(scrapeRun).values({ bronId: sourceId, id: runId });
    const rows = await db
      .insert(aanvraag)
      .values(
        Array.from({ length: count }, (_, index) => ({
          beschrijving: `expiry fixture ${index}`,
          bronId: sourceId,
          bronReferentie: `expiry-${crypto.randomUUID()}`,
          contentHash: `expiry-${index}-${crypto.randomUUID()}`,
          eersteGezienOp: NOW,
          extractieMethode: "html_parser",
          laatstGezienOp: NOW,
          rawPayloadRef: `raw/expiry-${crypto.randomUUID()}.html`,
          scrapeRunId: runId,
          sluitingsdatum:
            options.deadline === undefined
              ? new Date("2026-09-01T00:00:00.000Z")
              : options.deadline,
          status: "active",
          titel: `Expiry fixture ${index}`,
        }))
      )
      .returning({ id: aanvraag.id });
    const ids = rows.map((row) => row.id);
    aggregateIds.push(...ids);
    const store = new PostgresSearchVersionStore(db, { indexName });
    await store.read();
    const generation = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    await db
      .update(searchProjectionCheckpoint)
      .set({ generation })
      .where(eq(searchProjectionCheckpoint.indexName, indexName));
    if (!options.missingState) {
      await db.insert(searchProjectionState).values(
        ids.map((aggregateId) => ({
          aggregateId,
          appliedSequence: 1n,
          generation,
          projectionHash: options.hash ?? "active:expiry-fixture",
        }))
      );
    }
    if (options.overlayDeadline !== undefined) {
      await db.insert(aanvraagEnrichment).values(
        ids.map((aanvraagId) => ({
          aanvraagId,
          confidence: "1",
          field: "sluitingsdatum",
          rawRefs: [],
          source: "deterministic",
          value: { sluitingsdatum: options.overlayDeadline?.toISOString() },
        }))
      );
    }
    return { generation, ids, indexName };
  };

  it("excludes archive hashes, future and NULL deadlines, superseded rows, and missing current-generation state", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(6);
    await db
      .update(searchProjectionState)
      .set({ projectionHash: "archive:fixture" })
      .where(eq(searchProjectionState.aggregateId, idAt(corpus.ids, 1)));
    await db
      .update(aanvraag)
      .set({ sluitingsdatum: new Date("2026-09-03T00:00:00.000Z") })
      .where(eq(aanvraag.id, idAt(corpus.ids, 2)));
    await db
      .update(aanvraag)
      .set({ sluitingsdatum: null })
      .where(eq(aanvraag.id, idAt(corpus.ids, 3)));
    const keptId = idAt(corpus.ids, 0);
    const supersededId = idAt(corpus.ids, 4);
    await db
      .update(aanvraag)
      .set({ supersededBy: keptId })
      .where(eq(aanvraag.id, supersededId));
    await db
      .delete(searchProjectionState)
      .where(eq(searchProjectionState.aggregateId, idAt(corpus.ids, 5)));

    const result = await runSearchExpirySweep({
      database: db,
      indexName: corpus.indexName,
      mode: "dry-run",
      now: NOW,
    });
    expect(result.candidates).toBe(1);
    expect(result.sampleIds).toEqual([idAt(corpus.ids, 0)]);
  });

  it("dry-run writes nothing and returns candidates and sample ids", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(2);
    const before = await db.select({ id: outboxEvent.id }).from(outboxEvent);
    const result = await runSearchExpirySweep({
      database: db,
      indexName: corpus.indexName,
      mode: "dry-run",
      now: NOW,
    });
    const after = await db.select({ id: outboxEvent.id }).from(outboxEvent);
    expect(after).toHaveLength(before.length);
    expect(result.candidates).toBe(2);
    expect(result.sampleIds.toSorted()).toEqual(corpus.ids.toSorted());
    expect(result.enqueued).toBe(0);
  });

  it("enqueues an overlay-only deadline after it passes", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(1, {
      deadline: null,
      overlayDeadline: new Date("2026-09-01T00:00:00.000Z"),
    });

    const result = await runSearchExpirySweep({
      database: db,
      indexName: corpus.indexName,
      mode: "apply",
      now: NOW,
    });

    expect(result).toMatchObject({ candidates: 1, enqueued: 1 });
  });

  it("does not enqueue an overlay-only deadline that is still in the future", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(1, {
      deadline: null,
      overlayDeadline: new Date("2026-09-03T00:00:00.000Z"),
    });

    const result = await runSearchExpirySweep({
      database: db,
      indexName: corpus.indexName,
      mode: "apply",
      now: NOW,
    });

    expect(result).toMatchObject({ candidates: 0, enqueued: 0 });
  });

  it("applies one reindex event per candidate, skips pending, and re-enqueues dead letters", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(3);
    await db.insert(outboxEvent).values({
      aggregateId: idAt(corpus.ids, 1),
      aggregateType: "aanvraag",
      eventType: "aanvraag.gewijzigd",
      payload: {},
    });
    await db.insert(outboxEvent).values({
      aggregateId: idAt(corpus.ids, 2),
      aggregateType: "aanvraag",
      deadLetteredAt: NOW,
      eventType: SEARCH_REINDEX_EVENT_TYPE,
      payload: { reden: "old" },
    });
    const first = await runSearchExpirySweep({
      database: db,
      indexName: corpus.indexName,
      mode: "apply",
      now: NOW,
    });
    expect(first.enqueued).toBe(2);
    expect(first.skippedPending).toBe(1);
    const events = await db
      .select({
        aggregateId: outboxEvent.aggregateId,
        reden: sql<string>`${outboxEvent.payload}->>'reden'`,
      })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, SEARCH_REINDEX_EVENT_TYPE),
          inArray(outboxEvent.aggregateId, corpus.ids)
        )
      );
    const expiredReasonEvents = events.filter(
      (event) => event.reden === "sluitingsdatum_verstreken"
    );
    expect(expiredReasonEvents).toHaveLength(2);
    const second = await runSearchExpirySweep({
      database: db,
      indexName: corpus.indexName,
      mode: "apply",
      now: NOW,
    });
    expect(second.enqueued).toBe(0);
  });

  it("leaves curated rows unchanged and never deletes them", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(2);
    const before = await db
      .select()
      .from(aanvraag)
      .where(inArray(aanvraag.id, corpus.ids));
    await runSearchExpirySweep({
      database: db,
      indexName: corpus.indexName,
      mode: "apply",
      now: NOW,
    });
    const after = await db
      .select()
      .from(aanvraag)
      .where(inArray(aanvraag.id, corpus.ids));
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
  });

  it("batches and caps at maxPerRun, then resumes after pending skips", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(5);
    await db.insert(outboxEvent).values({
      aggregateId: idAt(corpus.ids.toSorted(), 0),
      aggregateType: "aanvraag",
      eventType: "aanvraag.gewijzigd",
      payload: {},
    });
    const first = await runSearchExpirySweep({
      batchSize: 2,
      database: db,
      indexName: corpus.indexName,
      maxPerRun: 3,
      mode: "apply",
      now: NOW,
    });
    expect(first).toMatchObject({
      batches: 2,
      candidates: 4,
      capped: true,
      enqueued: 3,
      skippedPending: 1,
    });
    const second = await runSearchExpirySweep({
      batchSize: 2,
      database: db,
      indexName: corpus.indexName,
      maxPerRun: 3,
      mode: "apply",
      now: NOW,
    });
    expect(second).toMatchObject({
      candidates: 5,
      enqueued: 1,
      skippedPending: 4,
    });
  });

  it("skips when another session holds the sweep lock", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const corpus = await createCorpus(1);
    const lockClient = postgres(applicationUrl, { max: 1 });
    try {
      await lockClient`SELECT pg_advisory_lock(${SEARCH_EXPIRY_SWEEP_LOCK_KEY})`;
      const result = await runSearchExpirySweep({
        database: db,
        indexName: corpus.indexName,
        mode: "apply",
        now: NOW,
      });
      expect(result.skipped).toBe("lock_held");
      expect(result.enqueued).toBe(0);
    } finally {
      await lockClient`SELECT pg_advisory_unlock(${SEARCH_EXPIRY_SWEEP_LOCK_KEY})`;
      await lockClient.end({ timeout: 5 });
    }
  });
});
