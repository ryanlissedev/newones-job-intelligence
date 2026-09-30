import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { createBron, listPublicBronnen } from "@ji/application/bronnen";
import {
  CONNECTOR_OBSERVATION_CONTRACT_VERSION,
  InMemoryObjectStore,
  RunAlreadyInProgressError,
  emptyRunMetrics,
  runConnector,
} from "@ji/connectors";
import type { ObservationRecorder, RunLifecycleStore } from "@ji/connectors";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { abandonStaleRuns } from "./abandon-stale-runs";
import {
  PostgresBronPersistence,
  PostgresObservationRecorder,
  PostgresRunStore,
  progressValues,
  toRunProgress,
} from "./bron-runtime";
import type { BronRuntimeDatabase } from "./bron-runtime";
import { PostgresKnownHashStore } from "./known-hash-store";
import * as schema from "./schema";
import { aanvraagObservation, bron, scrapeRun, sourceRecord } from "./schema";

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

const persistActivationObservations = async (
  database: BronRuntimeDatabase,
  bronId: string,
  scrapeRunId: string,
  count = 20
): Promise<void> => {
  const records = Array.from({ length: count }, (_, index) => ({
    bronId,
    bronReferentie: `activation-${scrapeRunId}-${index}`,
    contentHash: `activation-hash-${index}`,
    id: crypto.randomUUID(),
    rawPayloadRef: `raw/activation/${scrapeRunId}/${index}.json`,
    scrapeRunId,
  }));
  if (records.length === 0) {
    return;
  }
  await database.insert(sourceRecord).values(records);
  await database.insert(aanvraagObservation).values(
    records.map((record, index) => ({
      bronId,
      contentHash: record.contentHash,
      outcome: "new",
      payload: {
        contentHash: record.contentHash,
        observedAt: new Date(Date.UTC(2026, 7, 29, 9, 0, index)).toISOString(),
      },
      scrapeRunId,
      sourceRecordId: record.id,
    }))
  );
};

const persistSingleRecordObservations = async (
  database: BronRuntimeDatabase,
  bronId: string,
  scrapeRunId: string,
  count: number
): Promise<void> => {
  const record = {
    bronId,
    bronReferentie: `single-record-${scrapeRunId}`,
    contentHash: "single-record-current-hash",
    id: crypto.randomUUID(),
    rawPayloadRef: `raw/activation/${scrapeRunId}/single.json`,
    scrapeRunId,
  };
  await database.insert(sourceRecord).values(record);
  await database.insert(aanvraagObservation).values(
    Array.from({ length: count }, (_, index) => ({
      bronId,
      contentHash: `single-record-hash-${index}`,
      outcome: index === 0 ? "new" : "changed",
      payload: {
        contentHash: `single-record-hash-${index}`,
        observedAt: new Date(Date.UTC(2026, 7, 29, 10, 0, index)).toISOString(),
      },
      scrapeRunId,
      sourceRecordId: record.id,
    }))
  );
};

describe("durable bron runtime adapters", () => {
  let available = false;
  let migratorClient: ReturnType<typeof postgres> | undefined;

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
  });

  afterAll(async () => {
    await migratorClient?.end({ timeout: 5 });
  });

  it("survives adapter and connection re-instantiation with truthful metrics", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }

    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const testImportRunId = crypto.randomUUID();
    const firstClient = postgres(applicationUrl, { max: 1 });
    const firstDb = drizzle(firstClient, { schema });
    const bronRepository = new PostgresBronPersistence(firstDb);
    const runStore = new PostgresRunStore(firstDb);
    const recorder = new PostgresObservationRecorder(firstDb);

    const created = createBron({
      bronId,
      categorie: "overheidsportaal",
      crawlDelayMs: 750,
      interval: "*/15 * * * *",
      loginVereist: false,
      mappingRef: "mappings/runtime-v1.json",
      method: "json-api",
      naam: `Runtime ${bronId}`,
      rateLimitPerMinute: 12,
      retentionDays: 30,
      secretRef: null,
      status: "deferred",
      voorwaardenStatus: "toegestaan",
    });
    if (!created.ok) {
      throw new Error("Expected valid bron fixture");
    }

    try {
      await bronRepository.create(created.record);
      const testKey = { bronId, scrapeRunId: testImportRunId };
      const testRun = await runStore.start({
        key: testKey,
        mode: "reset",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "test",
        startedAt: new Date("2026-08-29T09:30:00Z"),
      });
      await runStore.complete({
        fenceToken: testRun.fenceToken,
        finishedAt: new Date("2026-08-29T09:31:00Z"),
        key: testKey,
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
      });
      await persistActivationObservations(firstDb, bronId, testImportRunId);
      await bronRepository.activate({ bronId, testImportRunId });
      const key = { bronId, scrapeRunId };
      const pollRun = await runStore.start({
        key,
        mode: "reset",
        progress: {
          checkpoint: { page: 1 },
          metrics: emptyRunMetrics(),
        },
        runKind: "poll",
        startedAt: new Date("2026-08-29T10:00:00Z"),
      });
      await runStore.checkpoint(
        key,
        { checkpoint: null, metrics: emptyRunMetrics() },
        pollRun.fenceToken
      );
      expect(await runStore.load(key)).toEqual({
        checkpoint: null,
        metrics: emptyRunMetrics(),
      });
      await runStore.checkpoint(
        key,
        {
          checkpoint: { cursor: "next", page: 2 },
          metrics: { ...emptyRunMetrics(), found: 2, new: 1 },
        },
        pollRun.fenceToken
      );
      const otherBronId = crypto.randomUUID();
      const otherBron = createBron({
        ...created.record,
        bronId: otherBronId,
        naam: `Other runtime ${otherBronId}`,
      });
      if (!otherBron.ok) {
        throw new Error("Expected valid cross-bron fixture");
      }
      await bronRepository.create(otherBron.record);
      await expect(
        runStore.start({
          key: { bronId: otherBronId, scrapeRunId },
          mode: "resume",
          progress: { checkpoint: null, metrics: emptyRunMetrics() },
          runKind: "poll",
          startedAt: new Date("2026-08-29T10:00:00Z"),
        })
      ).rejects.toThrow("Cannot resume mismatched or completed scrape run");
      await firstDb.delete(bron).where(eq(bron.id, otherBronId));
      let currentFenceToken = pollRun.fenceToken;
      const resumeClient = postgres(applicationUrl, { max: 1 });
      try {
        const resumedStore = new PostgresRunStore(
          drizzle(resumeClient, { schema })
        );
        const resumedRun = await resumedStore.start({
          key,
          mode: "resume",
          progress: {
            checkpoint: { page: 99 },
            metrics: emptyRunMetrics(),
          },
          runKind: "poll",
          startedAt: new Date("2026-08-29T10:00:30Z"),
        });
        currentFenceToken = resumedRun.fenceToken;
        expect(await resumedStore.load(key)).toEqual({
          checkpoint: { cursor: "next", page: 2 },
          metrics: { ...emptyRunMetrics(), found: 2, new: 1 },
        });
      } finally {
        await resumeClient.end({ timeout: 5 });
      }

      const pointer = {
        bronId,
        bronReferentie: "runtime-1",
        contentHash: "hash-1",
        rawPayloadRef: `raw/runtime/${scrapeRunId}/runtime-1.json`,
        scrapeRunId,
      };
      const recordObservation = (
        sourcePointer: typeof pointer
      ): ReturnType<PostgresObservationRecorder["record"]> =>
        recorder.record({
          fenceToken: currentFenceToken,
          key,
          observation: {
            bronId,
            bronReferentie: sourcePointer.bronReferentie,
            contentHash: sourcePointer.contentHash,
            contentType: "json",
            contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
            observedAt: "2026-08-29T10:00:30.000Z",
            rawPayloadRef: sourcePointer.rawPayloadRef,
            scrapeRunId,
          },
          sourceRecord: sourcePointer,
        });
      const inserted = await recordObservation(pointer);
      expect(inserted.outcome).toBe("new");
      const replay = await recordObservation(pointer);
      expect(replay).toEqual(inserted);
      const changed = await recordObservation({
        ...pointer,
        contentHash: "hash-2",
      });
      expect(changed).toEqual({
        outcome: "changed",
        sourceRecordId: inserted.sourceRecordId,
      });

      const second = await recordObservation({
        ...pointer,
        bronReferentie: "runtime-2",
        contentHash: "hash-3",
      });
      const third = await recordObservation({
        ...pointer,
        bronReferentie: "runtime-3",
        contentHash: "hash-3",
      });
      expect(second.outcome).toBe("new");
      expect(third.outcome).toBe("new");

      await runStore.complete({
        fenceToken: currentFenceToken,
        finishedAt: new Date("2026-08-29T10:01:00Z"),
        key,
        progress: {
          checkpoint: { cursor: "next", page: 2 },
          metrics: {
            ...emptyRunMetrics(),
            changed: 1,
            found: 4,
            new: 3,
          },
        },
      });
      const failedRunId = crypto.randomUUID();
      const failedKey = { bronId, scrapeRunId: failedRunId };
      const failedRun = await runStore.start({
        key: failedKey,
        mode: "reset",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: new Date("2026-08-29T09:00:00Z"),
      });
      await runStore.fail({
        failure: {
          class: "internal",
          code: "UNEXPECTED_FAILURE",
          message: "Connector run failed",
          phase: "unknown",
        },
        fenceToken: failedRun.fenceToken,
        finishedAt: new Date("2026-08-29T09:01:00Z"),
        key: failedKey,
        progress: {
          checkpoint: null,
          metrics: { ...emptyRunMetrics(), error: 1 },
        },
      });
    } finally {
      await firstClient.end({ timeout: 5 });
    }

    const secondClient = postgres(applicationUrl, { max: 1 });
    const secondDb = drizzle(secondClient, { schema });
    try {
      const restored = await new PostgresBronPersistence(secondDb).findById(
        bronId
      );
      expect(restored).toMatchObject({
        actief: true,
        crawlDelayMs: 750,
        lastRun: {
          changed: 1,
          error: 0,
          failure: null,
          found: 4,
          new: 3,
          rejected: 0,
          scrapeRunId,
          status: "succeeded",
        },
        rateLimitPerMinute: 12,
        retentionDays: 30,
      });
      expect(
        await new PostgresRunStore(secondDb).load({ bronId, scrapeRunId })
      ).toEqual({
        checkpoint: { cursor: "next", page: 2 },
        metrics: {
          ...emptyRunMetrics(),
          changed: 1,
          found: 4,
          new: 3,
        },
      });
      const allObservations = await secondDb
        .select()
        .from(aanvraagObservation)
        .where(eq(aanvraagObservation.scrapeRunId, scrapeRunId));
      expect(allObservations).toHaveLength(4);
      expect(allObservations[0]?.payload).toMatchObject({
        contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
        sourceRecordId: expect.any(String),
      });
      expect(
        await secondDb
          .select()
          .from(aanvraagObservation)
          .where(eq(aanvraagObservation.scrapeRunId, testImportRunId))
      ).toHaveLength(20);
      const [failedRun] = await secondDb
        .select()
        .from(scrapeRun)
        .where(
          and(eq(scrapeRun.bronId, bronId), eq(scrapeRun.status, "failed"))
        );
      expect(failedRun).toMatchObject({
        failureClass: "internal",
        failureCode: "UNEXPECTED_FAILURE",
        failureMessage: "Connector run failed",
        failurePhase: "unknown",
        fouten: 1,
        status: "failed",
      });
      if (!failedRun) {
        throw new Error("Expected failed run");
      }
      await secondDb
        .update(scrapeRun)
        .set({ gestart: new Date("2026-08-29T11:00:00Z") })
        .where(eq(scrapeRun.id, failedRun.id));
      const failedLastRun = await new PostgresBronPersistence(
        secondDb
      ).findById(bronId);
      expect(failedLastRun?.lastRun?.failure).toEqual({
        class: "internal",
        code: "UNEXPECTED_FAILURE",
        message: "Connector run failed",
        phase: "unknown",
      });
      expect(JSON.stringify(failedLastRun?.lastRun)).not.toContain(
        "bounded retry exhausted"
      );
    } finally {
      await secondDb.delete(bron).where(eq(bron.id, bronId));
      await secondClient.end({ timeout: 5 });
    }
  });

  it("resumes runConnector after crash-equivalent failures without metric loss or replay duplicates", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const setupClient = postgres(applicationUrl, { max: 1 });
    const setupDb = drizzle(setupClient, { schema });
    await setupDb.insert(bron).values({
      actief: true,
      categorie: "runtime-test",
      id: bronId,
      naam: `Crash resume ${bronId}`,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
    await setupClient.end({ timeout: 5 });

    const connector = {
      bronId,
      discover: (checkpoint: { page?: number } | null) => {
        const page = (checkpoint?.page ?? 0) + 1;
        return Promise.resolve({
          checkpoint: { page },
          hasMore: page < 3,
          items: [
            {
              bronReferentie: `crash-${page}`,
              contentHash: String(page).padStart(64, "0"),
            },
          ],
        });
      },
      fetch: (item: { bronReferentie: string; contentHash: string }) =>
        Promise.resolve({
          body: new TextEncoder().encode(item.bronReferentie),
          bronReferentie: item.bronReferentie,
          contentHash: item.contentHash,
          contentType: "json" as const,
          status: "fetched" as const,
        }),
    };
    const limiter = { acquire: () => Promise.resolve() };
    const retryPolicy = {
      initialDelayMs: 0,
      maxAttempts: 1,
      maxDelayMs: 0,
      multiplier: 1,
    };
    const objectStore = new InMemoryObjectStore();
    const crash = new Error("simulated hard process crash");

    const firstClient = postgres(applicationUrl, { max: 1 });
    const firstDb = drizzle(firstClient, { schema });
    const firstStore = new PostgresRunStore(firstDb);
    const durableRecorder = new PostgresObservationRecorder(firstDb);
    let crashAfterRecord = true;
    const crashingRecorder: ObservationRecorder = {
      record: async (input) => {
        const result = await durableRecorder.record(input);
        if (crashAfterRecord) {
          crashAfterRecord = false;
          throw crash;
        }
        return result;
      },
    };
    const noFailureWriteStore: RunLifecycleStore = {
      checkpoint: (key, progress, fenceToken) =>
        firstStore.checkpoint(key, progress, fenceToken),
      complete: (input) => firstStore.complete(input),
      fail: () => Promise.reject(crash),
      load: (key) => firstStore.load(key),
      start: (input) => firstStore.start(input),
    };
    await expect(
      runConnector({
        bronId,
        bronSlug: "crash-resume",
        connector,
        limiter,
        objectStore,
        observationRecorder: crashingRecorder,
        rawRetentionDays: 30,
        retryPolicy,
        runKind: "poll",
        runLifecycleStore: noFailureWriteStore,
        scrapeRunId,
        startedAt: new Date("2026-08-29T10:00:00Z"),
      })
    ).rejects.toThrow("failure persistence also failed");
    await firstClient.end({ timeout: 5 });

    const secondClient = postgres(applicationUrl, { max: 1 });
    const secondDb = drizzle(secondClient, { schema });
    const secondStore = new PostgresRunStore(secondDb);
    let checkpointWrites = 0;
    const crashAfterSecondCheckpoint: RunLifecycleStore = {
      checkpoint: async (key, progress, fenceToken) => {
        await secondStore.checkpoint(key, progress, fenceToken);
        checkpointWrites += 1;
        if (checkpointWrites === 2) {
          throw crash;
        }
      },
      complete: (input) => secondStore.complete(input),
      fail: () => Promise.reject(crash),
      load: (key) => secondStore.load(key),
      start: (input) => secondStore.start(input),
    };
    await expect(
      runConnector({
        bronId,
        bronSlug: "crash-resume",
        connector,
        limiter,
        objectStore,
        observationRecorder: new PostgresObservationRecorder(secondDb),
        rawRetentionDays: 30,
        retryPolicy,
        runKind: "poll",
        runLifecycleStore: crashAfterSecondCheckpoint,
        scrapeRunId,
        startedAt: new Date("2026-08-29T11:00:00Z"),
      })
    ).rejects.toThrow("failure persistence also failed");
    expect(await secondStore.load({ bronId, scrapeRunId })).toEqual({
      checkpoint: { page: 2 },
      metrics: { ...emptyRunMetrics(), found: 2, new: 2 },
    });
    await secondClient.end({ timeout: 5 });

    const finalClient = postgres(applicationUrl, { max: 1 });
    const finalDb = drizzle(finalClient, { schema });
    try {
      const result = await runConnector({
        bronId,
        bronSlug: "crash-resume",
        connector,
        limiter,
        objectStore,
        observationRecorder: new PostgresObservationRecorder(finalDb),
        rawRetentionDays: 30,
        retryPolicy,
        runKind: "poll",
        runLifecycleStore: new PostgresRunStore(finalDb),
        scrapeRunId,
        startedAt: new Date("2026-08-29T12:00:00Z"),
      });
      expect(result.metrics).toEqual({
        ...emptyRunMetrics(),
        found: 3,
        new: 3,
      });
      const observations = await finalDb
        .select()
        .from(aanvraagObservation)
        .where(eq(aanvraagObservation.scrapeRunId, scrapeRunId));
      expect(observations).toHaveLength(3);
      const [persistedRun] = await finalDb
        .select()
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));
      expect(persistedRun).toMatchObject({
        aantalGevonden: 3,
        gestart: new Date("2026-08-29T10:00:00Z"),
        nieuw: 3,
        status: "succeeded",
      });
    } finally {
      await finalDb.delete(bron).where(eq(bron.id, bronId));
      await finalClient.end({ timeout: 5 });
    }
  });

  it("reopens a failed run on resume and refetches only the failed page (CTP-643)", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 2 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const store = new PostgresRunStore(database);
    const limiter = { acquire: () => Promise.resolve() };
    const retryPolicy = {
      initialDelayMs: 0,
      maxAttempts: 1,
      maxDelayMs: 0,
      multiplier: 1,
    };
    const objectStore = new InMemoryObjectStore();
    let failPageTwoFetch = true;
    const discoveredPages: number[] = [];
    // Three pages; the page-2 fetch fails once, the way a rate-limited or
    // flaky detail request does on a real bron.
    const connector = {
      bronId,
      discover: (checkpoint: { page?: number } | null) => {
        const page = (checkpoint?.page ?? 0) + 1;
        discoveredPages.push(page);
        return Promise.resolve({
          checkpoint: { page },
          hasMore: page < 3,
          items: [
            {
              bronReferentie: `retry-${page}`,
              contentHash: String(page).padStart(64, "0"),
            },
          ],
        });
      },
      fetch: (item: { bronReferentie: string; contentHash: string }) => {
        if (item.bronReferentie === "retry-2" && failPageTwoFetch) {
          failPageTwoFetch = false;
          return Promise.reject(new Error("page 2 detail request failed"));
        }
        return Promise.resolve({
          body: new TextEncoder().encode(item.bronReferentie),
          bronReferentie: item.bronReferentie,
          contentHash: item.contentHash,
          contentType: "json" as const,
          status: "fetched" as const,
        });
      },
    };
    const attempt = (startedAt: Date) =>
      runConnector({
        bronId,
        bronSlug: "durable-retry",
        connector,
        limiter,
        objectStore,
        observationRecorder: new PostgresObservationRecorder(database),
        rawRetentionDays: 30,
        retryPolicy,
        runKind: "poll",
        runLifecycleStore: store,
        scrapeRunId,
        startedAt,
      });
    const loadRun = async () => {
      const [row] = await database
        .select()
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));
      return row;
    };

    try {
      await database.insert(bron).values({
        actief: true,
        categorie: "runtime-test",
        id: bronId,
        naam: `Durable retry ${bronId}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });

      await expect(attempt(new Date("2026-08-29T10:00:00Z"))).rejects.toThrow();
      expect(await loadRun()).toMatchObject({
        checkpoint: { page: 1 },
        failureCode: "FETCH_FAILED",
        fenceToken: 1,
        status: "failed",
      });
      expect(discoveredPages).toEqual([1, 2]);

      discoveredPages.length = 0;
      const resumedAt = new Date("2026-08-29T10:05:00Z");
      const result = await attempt(resumedAt);
      // Page 1 was never asked for again: the retake started from the
      // checkpoint the failed attempt left behind.
      expect(discoveredPages).toEqual([2, 3]);
      expect(result.completeness).toEqual({
        complete: false,
        reason: "resumed",
      });
      // Metrics carry over from the failed attempt, which had already counted
      // page 2 as found and recorded its error before `fail()` persisted them;
      // the retake counts page 2 once more. Observations do not double: the
      // recorder dedupes on the run's identity.
      expect(result.metrics).toEqual({
        ...emptyRunMetrics(),
        error: 1,
        found: 4,
        new: 3,
      });
      const observations = await database
        .select({ id: aanvraagObservation.id })
        .from(aanvraagObservation)
        .where(eq(aanvraagObservation.scrapeRunId, scrapeRunId));
      expect(observations).toHaveLength(3);
      const runs = await database
        .select()
        .from(scrapeRun)
        .where(eq(scrapeRun.bronId, bronId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        aantalGevonden: 4,
        failureClass: null,
        failureCode: null,
        failureMessage: null,
        failurePhase: null,
        fenceToken: 2,
        gestart: resumedAt,
        nieuw: 3,
        status: "succeeded",
      });
      expect(runs[0]?.geindigd).not.toBeNull();

      await expect(
        store.start({
          key,
          mode: "resume",
          progress: { checkpoint: null, metrics: emptyRunMetrics() },
          runKind: "poll",
          startedAt: new Date("2026-08-29T11:00:00Z"),
        })
      ).rejects.toThrow("Cannot resume mismatched or completed scrape run");
    } finally {
      await database
        .delete(aanvraagObservation)
        .where(eq(aanvraagObservation.scrapeRunId, scrapeRunId));
      await database
        .delete(sourceRecord)
        .where(eq(sourceRecord.bronId, bronId));
      await database.delete(scrapeRun).where(eq(scrapeRun.id, scrapeRunId));
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("reopens a run abandonStaleRuns failed, refuses reset and a bron with a live poll (CTP-643)", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 2 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const liveRunId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const store = new PostgresRunStore(database);
    const progress = {
      checkpoint: { page: 4 },
      metrics: { ...emptyRunMetrics(), found: 4, new: 4 },
    };
    const olderThanMs = 60_000;

    try {
      await database.insert(bron).values({
        actief: true,
        categorie: "runtime-test",
        id: bronId,
        naam: `Abandoned resume ${bronId}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      const started = await store.start({
        key,
        mode: "reset",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-29T10:00:00Z"),
      });
      await store.checkpoint(key, progress, started.fenceToken);
      const abandoned = await abandonStaleRuns(database, {
        now: new Date(Date.parse("2026-08-29T10:00:00Z") + olderThanMs + 1),
        olderThanMs,
      });
      expect(abandoned).toContain(scrapeRunId);

      await expect(
        store.start({
          key,
          mode: "reset",
          progress,
          runKind: "poll",
          startedAt: new Date("2026-08-29T10:10:00Z"),
        })
      ).rejects.toThrow("Cannot resume mismatched or completed scrape run");

      const reopenedAt = new Date("2026-08-29T10:10:00Z");
      const reopened = await store.start({
        key,
        mode: "resume",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: reopenedAt,
      });
      // abandonStaleRuns bumped the fence once; the reopen bumps it again.
      expect(reopened.fenceToken).toBe(3);
      expect(reopened.progress).toEqual(progress);
      const [row] = await database
        .select()
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));
      expect(row).toMatchObject({
        failureClass: null,
        failureCode: null,
        failureMessage: null,
        failurePhase: null,
        fenceToken: 3,
        geindigd: null,
        gestart: reopenedAt,
        status: "running",
      });

      // Fail it again, then start a second live poll for the same bron: the
      // failed row must not be reopened over another executor's run.
      await store.fail({
        failure: {
          class: "internal",
          code: "UNEXPECTED_FAILURE",
          message: "Connector run failed",
          phase: "unknown",
        },
        fenceToken: reopened.fenceToken,
        finishedAt: new Date("2026-08-29T10:11:00Z"),
        key,
        progress,
      });
      await store.start({
        key: { bronId, scrapeRunId: liveRunId },
        mode: "reset",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: new Date(),
      });
      await expect(
        store.start({
          key,
          mode: "resume",
          progress: { checkpoint: null, metrics: emptyRunMetrics() },
          runKind: "poll",
          startedAt: new Date(),
        })
      ).rejects.toBeInstanceOf(RunAlreadyInProgressError);
    } finally {
      await database
        .delete(scrapeRun)
        .where(inArray(scrapeRun.id, [scrapeRunId, liveRunId]));
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("keeps the newest checkpoint across concurrent duplicate resumes", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 2 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const store = new PostgresRunStore(database);
    const staleProgress = {
      checkpoint: { page: 1 },
      metrics: { ...emptyRunMetrics(), found: 1, new: 1 },
    };
    const newestProgress = {
      checkpoint: { page: 2 },
      metrics: { ...emptyRunMetrics(), found: 2, new: 2 },
    };

    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Concurrent resume ${bronId}`,
      });
      const seeded = await store.start({
        key,
        mode: "reset",
        progress: staleProgress,
        runKind: "poll",
        startedAt: new Date("2026-08-29T08:00:00Z"),
      });
      await store.checkpoint(key, newestProgress, seeded.fenceToken);

      const resumed = await Promise.all([
        store.start({
          key,
          mode: "resume",
          progress: staleProgress,
          runKind: "poll",
          startedAt: new Date("2026-08-29T09:00:00Z"),
        }),
        store.start({
          key,
          mode: "resume",
          progress: staleProgress,
          runKind: "poll",
          startedAt: new Date("2026-08-29T10:00:00Z"),
        }),
      ]);

      expect(resumed.map((result) => result.progress)).toEqual([
        newestProgress,
        newestProgress,
      ]);
      const tokens = resumed
        .map((result) => result.fenceToken)
        .toSorted((a, b) => a - b);
      expect(tokens).toEqual([seeded.fenceToken + 1, seeded.fenceToken + 2]);
      const [staleToken, currentToken] = tokens;
      if (staleToken === undefined || currentToken === undefined) {
        throw new Error("Expected two fence tokens");
      }
      await expect(
        store.checkpoint(key, staleProgress, staleToken)
      ).rejects.toMatchObject({ code: "RUN_OWNERSHIP_LOST" });
      await expect(
        store.complete({
          fenceToken: staleToken,
          finishedAt: new Date("2026-08-29T10:01:00Z"),
          key,
          progress: staleProgress,
        })
      ).rejects.toMatchObject({ code: "RUN_OWNERSHIP_LOST" });
      await expect(
        store.fail({
          failure: {
            class: "internal",
            code: "UNEXPECTED_FAILURE",
            message: "Connector run failed",
            phase: "unknown",
          },
          fenceToken: staleToken,
          finishedAt: new Date("2026-08-29T10:01:00Z"),
          key,
          progress: staleProgress,
        })
      ).rejects.toMatchObject({ code: "RUN_OWNERSHIP_LOST" });
      expect(await store.load(key)).toEqual(newestProgress);
      await store.checkpoint(key, newestProgress, currentToken);
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("rejects reset after immutable observations could be reordered", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const originalStartedAt = new Date("2026-08-29T08:00:00Z");
    const store = new PostgresRunStore(database);
    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Reset ordering ${bronId}`,
      });
      const run = await store.start({
        key,
        mode: "reset",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: originalStartedAt,
      });
      await new PostgresObservationRecorder(database).record({
        fenceToken: run.fenceToken,
        key,
        observation: {
          bronId,
          bronReferentie: "reset-reference",
          contentHash: "reset-hash",
          contentType: "json",
          contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
          observedAt: originalStartedAt.toISOString(),
          rawPayloadRef: "raw/reset/observation.json",
          scrapeRunId,
        },
        sourceRecord: {
          bronId,
          bronReferentie: "reset-reference",
          contentHash: "reset-hash",
          rawPayloadRef: "raw/reset/observation.json",
          scrapeRunId,
        },
      });

      await expect(
        store.start({
          key,
          mode: "reset",
          progress: { checkpoint: null, metrics: emptyRunMetrics() },
          runKind: "poll",
          startedAt: new Date("2026-08-29T12:00:00Z"),
        })
      ).rejects.toThrow("use a new scrapeRunId");
      const [persistedRun] = await database
        .select({ startedAt: scrapeRun.gestart })
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));
      expect(persistedRun?.startedAt).toEqual(originalStartedAt);
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("rejects a stale observation before it can mutate source state", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 2 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const store = new PostgresRunStore(database);
    const recorder = new PostgresObservationRecorder(database);
    const progress = { checkpoint: null, metrics: emptyRunMetrics() };
    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Observation fence ${bronId}`,
      });
      const staleRun = await store.start({
        key,
        mode: "reset",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-29T08:00:00Z"),
      });
      const currentRun = await store.start({
        key,
        mode: "resume",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-29T09:00:00Z"),
      });
      const inputFor = (contentHash: string, fenceToken: number) => ({
        fenceToken,
        key,
        observation: {
          bronId,
          bronReferentie: "fenced-reference",
          contentHash,
          contentType: "json" as const,
          contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
          observedAt: "2026-08-29T09:00:00.000Z",
          rawPayloadRef: `raw/fenced/${contentHash}.json`,
          scrapeRunId,
        },
        sourceRecord: {
          bronId,
          bronReferentie: "fenced-reference",
          contentHash,
          rawPayloadRef: `raw/fenced/${contentHash}.json`,
          scrapeRunId,
        },
      });
      expect(
        await recorder.record(inputFor("current-hash", currentRun.fenceToken))
      ).toMatchObject({ outcome: "new" });
      await store.complete({
        fenceToken: currentRun.fenceToken,
        finishedAt: new Date("2026-08-29T09:01:00Z"),
        key,
        progress,
      });

      await expect(
        recorder.record(inputFor("stale-hash", staleRun.fenceToken))
      ).rejects.toMatchObject({ code: "RUN_OWNERSHIP_LOST" });
      const [persistedSource] = await database
        .select()
        .from(sourceRecord)
        .where(eq(sourceRecord.bronId, bronId));
      expect(persistedSource?.contentHash).toBe("current-hash");
      expect(
        await database
          .select()
          .from(aanvraagObservation)
          .where(eq(aanvraagObservation.bronId, bronId))
      ).toHaveLength(1);
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("keeps the source pointer on the canonically newest run and observation", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 2 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const olderRunId = crypto.randomUUID();
    const newerRunId = crypto.randomUUID();
    const store = new PostgresRunStore(database);
    const recorder = new PostgresObservationRecorder(database);
    const progress = { checkpoint: null, metrics: emptyRunMetrics() };
    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Pointer ordering ${bronId}`,
      });
      const olderRun = await store.start({
        key: { bronId, scrapeRunId: olderRunId },
        mode: "reset",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-29T09:00:00Z"),
      });
      const newerRun = await store.start({
        key: { bronId, scrapeRunId: newerRunId },
        mode: "reset",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-29T10:00:00Z"),
      });
      const record = (
        scrapeRunId: string,
        fenceToken: number,
        contentHash: string,
        observedAt: string
      ) =>
        recorder.record({
          fenceToken,
          key: { bronId, scrapeRunId },
          observation: {
            bronId,
            bronReferentie: "overlapping-reference",
            contentHash,
            contentType: "json",
            contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
            observedAt,
            rawPayloadRef: `raw/pointer/${contentHash}.json`,
            scrapeRunId,
          },
          sourceRecord: {
            bronId,
            bronReferentie: "overlapping-reference",
            contentHash,
            rawPayloadRef: `raw/pointer/${contentHash}.json`,
            scrapeRunId,
          },
        });

      await record(
        newerRunId,
        newerRun.fenceToken,
        "newer-run-hash",
        "2026-08-29T10:01:00.000Z"
      );
      await record(
        olderRunId,
        olderRun.fenceToken,
        "older-run-late-arrival",
        "2026-08-29T11:00:00.000Z"
      );
      await record(
        newerRunId,
        newerRun.fenceToken,
        "newest-observation-hash",
        "2026-08-29T10:02:00.000Z"
      );
      await record(
        newerRunId,
        newerRun.fenceToken,
        "out-of-order-observation-hash",
        "2026-08-29T10:00:30.000Z"
      );

      const [pointer] = await database
        .select()
        .from(sourceRecord)
        .where(eq(sourceRecord.bronId, bronId));
      expect(pointer).toMatchObject({
        contentHash: "newest-observation-hash",
        rawPayloadRef: "raw/pointer/newest-observation-hash.json",
        scrapeRunId: newerRunId,
      });
      expect(
        await database
          .select()
          .from(aanvraagObservation)
          .where(eq(aanvraagObservation.bronId, bronId))
      ).toHaveLength(4);
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("classifies against arrival state while canonically repairing a history-divergent pointer", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const sourceRecordId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const store = new PostgresRunStore(database);
    const recorder = new PostgresObservationRecorder(database);
    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Divergent pointer ${bronId}`,
      });
      const run = await store.start({
        key,
        mode: "reset",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: new Date("2026-08-29T09:00:00Z"),
      });
      await database.insert(sourceRecord).values({
        bronId,
        bronReferentie: "divergent-reference",
        contentHash: "legacy-current-hash",
        id: sourceRecordId,
        rawPayloadRef: "raw/divergent/legacy-current.json",
        scrapeRunId,
      });
      await database.insert(aanvraagObservation).values([
        {
          bronId,
          contentHash: "history-later-hash",
          outcome: "changed",
          payload: {
            contentHash: "history-later-hash",
            observedAt: "2026-08-29T12:00:00.000Z",
            rawPayloadRef: "raw/divergent/history-later.json",
          },
          scrapeRunId,
          sourceRecordId,
        },
        {
          bronId,
          contentHash: "legacy-current-hash",
          outcome: "changed",
          payload: {
            contentHash: "legacy-current-hash",
            observedAt: "2026-08-29T10:00:00.000Z",
          },
          scrapeRunId,
          sourceRecordId,
        },
        {
          bronId,
          contentHash: "invalid-history-hash",
          outcome: "changed",
          payload: {
            contentHash: "invalid-history-hash",
            observedAt: "2026-08-29T13:00:00.000Z",
            rawPayloadRef: "   ",
          },
          scrapeRunId,
          sourceRecordId,
        },
      ]);

      const arrivalInput: Parameters<PostgresObservationRecorder["record"]>[0] =
        {
          fenceToken: run.fenceToken,
          key,
          observation: {
            bronId,
            bronReferentie: "divergent-reference",
            contentHash: "arrival-hash",
            contentType: "json",
            contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
            observedAt: "2026-08-29T11:00:00.000Z",
            rawPayloadRef: "raw/divergent/arrival.json",
            scrapeRunId,
          },
          sourceRecord: {
            bronId,
            bronReferentie: "divergent-reference",
            contentHash: "arrival-hash",
            rawPayloadRef: "raw/divergent/arrival.json",
            scrapeRunId,
          },
        };
      const result = await recorder.record(arrivalInput);
      const replay = await recorder.record({
        ...arrivalInput,
        observation: {
          ...arrivalInput.observation,
          observedAt: "2026-08-29T14:00:00.000Z",
          rawPayloadRef: "raw/divergent/unpersisted-replay.json",
        },
        sourceRecord: {
          ...arrivalInput.sourceRecord,
          rawPayloadRef: "raw/divergent/unpersisted-replay.json",
        },
      });

      expect(result).toEqual({ outcome: "changed", sourceRecordId });
      expect(replay).toEqual(result);
      const [pointer] = await database
        .select()
        .from(sourceRecord)
        .where(eq(sourceRecord.id, sourceRecordId));
      expect(pointer).toMatchObject({
        contentHash: "history-later-hash",
        rawPayloadRef: "raw/divergent/history-later.json",
      });
      const [arrivalObservation] = await database
        .select()
        .from(aanvraagObservation)
        .where(eq(aanvraagObservation.contentHash, "arrival-hash"));
      expect(arrivalObservation?.outcome).toBe("changed");
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("rejects partial and invalid persisted failure envelopes", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Failure constraints ${bronId}`,
      });
      await expect(
        database
          .insert(scrapeRun)
          .values({
            bronId,
            failureClass: "internal",
            id: crypto.randomUUID(),
            status: "running",
          })
          .execute()
      ).rejects.toThrow();
      await expect(
        database
          .insert(scrapeRun)
          .values({
            bronId,
            failureClass: "internal",
            failureCode: "MADE_UP",
            failureMessage: "unsafe details",
            failurePhase: "unknown",
            geindigd: new Date(),
            id: crypto.randomUUID(),
            status: "failed",
          })
          .execute()
      ).rejects.toThrow();
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("requires a same-bron succeeded test-import and enforces activation policy", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const repository = new PostgresBronPersistence(database);
    const allowedId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const forbiddenId = crypto.randomUUID();
    const unknownId = crypto.randomUUID();
    const bronIds = [allowedId, otherId, forbiddenId, unknownId];
    const pollRunId = crypto.randomUUID();
    const failedRunId = crypto.randomUUID();
    const runningRunId = crypto.randomUUID();
    const otherRunId = crypto.randomUUID();
    const emptySucceededRunId = crypto.randomUUID();
    const repeatedRecordRunId = crypto.randomUUID();
    const allowedRunId = crypto.randomUUID();
    const forbiddenRunId = crypto.randomUUID();
    const unknownRunId = crypto.randomUUID();
    try {
      await database.insert(bron).values([
        {
          categorie: "test",
          id: allowedId,
          naam: `Allowed ${allowedId}`,
          status: "deferred",
          voorwaardenStatus: "toegestaan",
        },
        {
          categorie: "test",
          id: otherId,
          naam: `Other ${otherId}`,
          status: "deferred",
          voorwaardenStatus: "toegestaan",
        },
        {
          categorie: "test",
          id: forbiddenId,
          naam: `Forbidden ${forbiddenId}`,
          status: "deferred",
          voorwaardenStatus: "verboden",
        },
        {
          categorie: "test",
          id: unknownId,
          naam: `Unknown ${unknownId}`,
          status: "deferred",
          voorwaardenStatus: "te_toetsen",
        },
      ]);
      await database.insert(scrapeRun).values([
        {
          bronId: allowedId,
          geindigd: new Date(),
          id: pollRunId,
          runKind: "poll",
          status: "succeeded",
        },
        {
          bronId: allowedId,
          failureClass: "internal",
          failureCode: "LEGACY_FAILURE",
          failureMessage: "Legacy run failed; details unavailable",
          failurePhase: "unknown",
          geindigd: new Date(),
          id: failedRunId,
          runKind: "test",
          status: "failed",
        },
        {
          bronId: allowedId,
          id: runningRunId,
          runKind: "test",
          status: "running",
        },
        {
          bronId: otherId,
          geindigd: new Date(),
          id: otherRunId,
          runKind: "test",
          status: "succeeded",
        },
        {
          bronId: allowedId,
          geindigd: new Date(),
          id: emptySucceededRunId,
          runKind: "test",
          status: "succeeded",
        },
        {
          bronId: allowedId,
          geindigd: new Date(),
          id: allowedRunId,
          runKind: "test",
          status: "succeeded",
        },
        {
          bronId: allowedId,
          geindigd: new Date(),
          id: repeatedRecordRunId,
          runKind: "test",
          status: "succeeded",
        },
        {
          bronId: forbiddenId,
          geindigd: new Date(),
          id: forbiddenRunId,
          runKind: "test",
          status: "succeeded",
        },
        {
          bronId: unknownId,
          geindigd: new Date(),
          id: unknownRunId,
          runKind: "test",
          status: "succeeded",
        },
      ]);
      await persistSingleRecordObservations(
        database,
        allowedId,
        repeatedRecordRunId,
        20
      );
      await persistActivationObservations(database, allowedId, allowedRunId);
      await persistActivationObservations(
        database,
        forbiddenId,
        forbiddenRunId
      );
      await persistActivationObservations(database, unknownId, unknownRunId);
      await Promise.all(
        [
          pollRunId,
          failedRunId,
          runningRunId,
          otherRunId,
          emptySucceededRunId,
        ].map((testImportRunId) =>
          expect(
            repository.activate({ bronId: allowedId, testImportRunId })
          ).rejects.toThrow("succeeded test-import")
        )
      );
      await expect(
        repository.activate({
          bronId: allowedId,
          testImportRunId: repeatedRecordRunId,
        })
      ).rejects.toThrow("distinct persisted source records");
      await expect(
        repository.activate({
          bronId: forbiddenId,
          testImportRunId: forbiddenRunId,
        })
      ).rejects.toThrow();
      await expect(
        repository.activate({
          bronId: allowedId,
          testImportRunId: allowedRunId,
        })
      ).resolves.toMatchObject({ actief: true, status: "ready" });
      await expect(
        repository.activate({
          bronId: unknownId,
          testImportRunId: unknownRunId,
        })
      ).rejects.toThrow();
      await expect(repository.setActive(allowedId, true)).rejects.toThrow(
        "succeeded test-import"
      );
    } finally {
      await database.delete(bron).where(inArray(bron.id, bronIds));
      await client.end({ timeout: 5 });
    }
  });

  it("honours a per-source activation threshold below the default", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const repository = new PostgresBronPersistence(database);
    const bronId = crypto.randomUUID();
    const testImportRunId = crypto.randomUUID();
    const zeroRunId = crypto.randomUUID();
    try {
      await database.insert(bron).values({
        categorie: "test",
        id: bronId,
        naam: `Small catalog ${bronId}`,
        status: "deferred",
        voorwaardenStatus: "toegestaan",
      });
      await database.insert(scrapeRun).values([
        {
          bronId,
          geindigd: new Date(),
          id: testImportRunId,
          runKind: "test",
          status: "succeeded",
        },
        {
          bronId,
          geindigd: new Date(),
          id: zeroRunId,
          runKind: "test",
          status: "succeeded",
        },
      ]);
      await persistActivationObservations(database, bronId, testImportRunId, 5);
      await expect(
        repository.activate({ bronId, testImportRunId })
      ).rejects.toThrow("distinct persisted source records");
      await expect(
        repository.activate({
          bronId,
          minimumTestImportObservations: 5,
          testImportRunId,
        })
      ).resolves.toMatchObject({ actief: true, status: "ready" });
      await expect(
        repository.activate({
          bronId,
          minimumTestImportObservations: 0,
          testImportRunId: zeroRunId,
        })
      ).rejects.toThrow("positive integer");
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("lists persisted operator state without exposing opaque secret references", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const repository = new PostgresBronPersistence(database);
    const bronId = crypto.randomUUID();
    const missingSecretId = crypto.randomUUID();
    const created = createBron({
      bronId,
      crawlDelayMs: 0,
      interval: "0 * * * *",
      loginVereist: true,
      mappingRef: null,
      method: "json-api",
      naam: `Secret ${bronId}`,
      rateLimitPerMinute: 1,
      secretRef: "op://vault/source/api-token",
      status: "deferred",
      voorwaardenStatus: "toegestaan",
    });
    if (!created.ok) {
      throw new Error("Expected valid opaque secret reference");
    }
    try {
      await repository.create(created.record);
      const olderRunId = crypto.randomUUID();
      const latestRunId = crypto.randomUUID();
      await database.insert(scrapeRun).values([
        {
          aantalGevonden: 5,
          bronId,
          geindigd: new Date("2026-08-29T09:01:00Z"),
          gestart: new Date("2026-08-29T09:00:00Z"),
          id: olderRunId,
          nieuw: 5,
          status: "succeeded",
        },
        {
          bronId,
          failureClass: "internal",
          failureCode: "UNEXPECTED_FAILURE",
          failureMessage: "Connector run failed",
          failurePhase: "unknown",
          fouten: 1,
          geindigd: new Date("2026-08-29T10:01:00Z"),
          gestart: new Date("2026-08-29T10:00:00Z"),
          id: latestRunId,
          status: "failed",
        },
      ]);
      const restored = await repository.findById(bronId);
      expect(restored?.secretRef).toBe("op://vault/source/api-token");
      const publicBronnen = await listPublicBronnen(repository);
      const publicBron = publicBronnen.find((view) => view.bronId === bronId);
      expect(publicBron).toMatchObject({
        hasSecretRef: true,
        lastRun: {
          error: 1,
          scrapeRunId: latestRunId,
          status: "failed",
        },
        status: "deferred",
      });
      const serialized = JSON.stringify(publicBron);
      expect(serialized).not.toContain("secretRef");
      expect(serialized).not.toContain("op://vault/source/api-token");
      const missingSecret = createBron({
        ...created.record,
        bronId: missingSecretId,
        secretRef: null,
      });
      expect(missingSecret.ok).toBe(false);
      expect(await repository.findById(missingSecretId)).toBeNull();
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("rejects plaintext secret references at the persistence boundary", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const repository = new PostgresBronPersistence(database);
    const bronId = crypto.randomUUID();
    const valid = createBron({
      bronId,
      crawlDelayMs: 0,
      interval: "0 * * * *",
      loginVereist: true,
      mappingRef: null,
      method: "json-api",
      naam: `Plaintext secret ${bronId}`,
      rateLimitPerMinute: 1,
      secretRef: "op://vault/source/api-token",
      status: "deferred",
      voorwaardenStatus: "toegestaan",
    });
    if (!valid.ok) {
      throw new Error("Expected valid bron fixture");
    }

    try {
      await expect(
        repository.create({
          ...valid.record,
          secretRef: "plaintext-secret",
        })
      ).rejects.toThrow("Invalid secret reference");
      expect(await repository.findById(bronId)).toBeNull();
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("rejects active records at the persistence creation boundary", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const repository = new PostgresBronPersistence(database);
    const bronId = crypto.randomUUID();
    const valid = createBron({
      bronId,
      crawlDelayMs: 0,
      interval: "0 * * * *",
      loginVereist: false,
      mappingRef: null,
      method: "json-api",
      naam: `Unsafe active creation ${bronId}`,
      rateLimitPerMinute: 1,
      secretRef: null,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
    if (!valid.ok) {
      throw new Error("Expected valid inactive bron fixture");
    }

    try {
      await expect(
        repository.create({ ...valid.record, actief: true })
      ).rejects.toThrow("Bron must be created inactive");
      expect(await repository.findById(bronId)).toBeNull();
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });
  it("persists listing_hash on insert and update, and PostgresKnownHashStore reads that tier (RJC-357)", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 2 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const firstRunId = crypto.randomUUID();
    const secondRunId = crypto.randomUUID();
    const store = new PostgresRunStore(database);
    const recorder = new PostgresObservationRecorder(database);
    const knownHashes = new PostgresKnownHashStore(database);
    const progress = { checkpoint: null, metrics: emptyRunMetrics() };
    const record = (
      scrapeRunId: string,
      fenceToken: number,
      contentHash: string,
      listingHash: string | null,
      observedAt: string
    ) =>
      recorder.record({
        fenceToken,
        key: { bronId, scrapeRunId },
        observation: {
          bronId,
          bronReferentie: "listing-hash-reference",
          contentHash,
          contentType: "json",
          contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
          observedAt,
          rawPayloadRef: `raw/listing-hash/${contentHash}.json`,
          scrapeRunId,
        },
        sourceRecord: {
          bronId,
          bronReferentie: "listing-hash-reference",
          contentHash,
          listingHash,
          rawPayloadRef: `raw/listing-hash/${contentHash}.json`,
          scrapeRunId,
        },
      });
    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Listing hash ${bronId}`,
      });
      const firstRun = await store.start({
        key: { bronId, scrapeRunId: firstRunId },
        mode: "reset",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-30T09:00:00Z"),
      });
      // No listing hash recorded yet: the store must answer null (never skip).
      expect(
        await knownHashes.get(bronId, "listing-hash-reference")
      ).toBeNull();

      await record(
        firstRunId,
        firstRun.fenceToken,
        "payload-hash-1",
        "listing-hash-1",
        "2026-08-30T09:01:00.000Z"
      );
      // The store returns the LISTING hash, never the payload hash — the
      // two tiers never match each other (the RJC-357 bug).
      expect(await knownHashes.get(bronId, "listing-hash-reference")).toBe(
        "listing-hash-1"
      );

      const secondRun = await store.start({
        key: { bronId, scrapeRunId: secondRunId },
        mode: "reset",
        progress,
        runKind: "poll",
        startedAt: new Date("2026-08-30T10:00:00Z"),
      });
      await record(
        secondRunId,
        secondRun.fenceToken,
        "payload-hash-2",
        "listing-hash-2",
        "2026-08-30T10:01:00.000Z"
      );
      expect(await knownHashes.get(bronId, "listing-hash-reference")).toBe(
        "listing-hash-2"
      );

      // An observation without a listing hash clears the stored value so a
      // stale listing hash can never authorise a skip.
      await record(
        secondRunId,
        secondRun.fenceToken,
        "payload-hash-3",
        null,
        "2026-08-30T10:02:00.000Z"
      );
      expect(
        await knownHashes.get(bronId, "listing-hash-reference")
      ).toBeNull();
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });

  it("writes gesloten: 0 when closed metric is omitted (no backfill)", () => {
    const values = progressValues({
      checkpoint: null,
      metrics: emptyRunMetrics(),
    });
    expect(values.gesloten).toBe(0);
    expect(values.aantalGevonden).toBe(0);
    expect(values.fouten).toBe(0);
    expect(values.gewijzigd).toBe(0);
    expect(values.nieuw).toBe(0);
    expect(values.rejected).toBe(0);
  });

  it("writes gesloten from metrics.closed when present", () => {
    const values = progressValues({
      checkpoint: { page: 1 },
      metrics: {
        ...emptyRunMetrics(),
        closed: 4,
        found: 10,
        new: 2,
      },
    });
    expect(values.gesloten).toBe(4);
    expect(values.aantalGevonden).toBe(10);
    expect(values.nieuw).toBe(2);
  });

  it("toRunProgress exposes closed only when non-zero and always exposes unchanged", () => {
    const zeroClosed = toRunProgress({
      changed: 1,
      checkpoint: null,
      closed: 0,
      error: 0,
      found: 5,
      new: 2,
      rejected: 0,
    });
    expect(zeroClosed.metrics.unchanged).toBe(0);
    expect(zeroClosed.metrics.closed).toBeUndefined();

    const withClosed = toRunProgress({
      changed: 1,
      checkpoint: null,
      closed: 3,
      error: 0,
      found: 5,
      new: 2,
      rejected: 0,
    });
    expect(withClosed.metrics.closed).toBe(3);
    expect(withClosed.metrics.unchanged).toBe(0);
  });

  it("persists gesloten and roundtrips via load", async () => {
    if (!available) {
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const scrapeRunId = crypto.randomUUID();
    const key = { bronId, scrapeRunId };
    const store = new PostgresRunStore(database);

    try {
      await database.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Gesloten test ${bronId}`,
      });

      const started = await store.start({
        key,
        mode: "reset",
        progress: { checkpoint: null, metrics: emptyRunMetrics() },
        runKind: "poll",
        startedAt: new Date("2026-08-31T10:00:00Z"),
      });

      await store.checkpoint(
        key,
        {
          checkpoint: { page: 1 },
          metrics: { ...emptyRunMetrics(), closed: 7, found: 20 },
        },
        started.fenceToken
      );

      const loaded = await store.load(key);
      expect(loaded).toEqual({
        checkpoint: { page: 1 },
        metrics: {
          ...emptyRunMetrics(),
          closed: 7,
          found: 20,
        },
      });

      const [persistedRow] = await database
        .select({ gesloten: scrapeRun.gesloten })
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));
      expect(persistedRow?.gesloten).toBe(7);
    } finally {
      await database.delete(bron).where(eq(bron.id, bronId));
      await client.end({ timeout: 5 });
    }
  });
});
