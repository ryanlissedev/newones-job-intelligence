import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { pruneProcessedOutboxEvents } from "./prune-outbox-events";
import * as schema from "./schema";
import { outboxEvent } from "./schema";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

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

/** Fixed clock: every row sits on the intended side of the cutoff. */
const NOW = new Date("2026-09-17T12:00:00.000Z");
const RETENTION_DAYS = 30;
const daysAgo = (days: number): Date =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

interface Fixture {
  readonly cleanup: () => Promise<void>;
  readonly database: PostgresJsDatabase<typeof schema>;
  readonly ids: {
    deadLettered: string;
    freshProcessed: string;
    oldProcessed: string[];
    unprocessed: string;
  };
}

const seed = async (
  database: PostgresJsDatabase<typeof schema>
): Promise<Fixture> => {
  const aggregateId = crypto.randomUUID();
  const base = {
    aggregateId,
    aggregateType: "aanvraag",
    eventType: "aanvraag.observed",
    payload: { probe: true },
  };
  const oldProcessed = [crypto.randomUUID(), crypto.randomUUID()];
  const freshProcessed = crypto.randomUUID();
  const unprocessed = crypto.randomUUID();
  const deadLettered = crypto.randomUUID();

  await database.insert(outboxEvent).values([
    // Well past retention: deleted.
    ...oldProcessed.map((id) => ({
      ...base,
      id,
      processedAt: daysAgo(45),
    })),
    // Processed but inside the window: kept.
    { ...base, id: freshProcessed, processedAt: daysAgo(5) },
    // Never processed: the drain still owns it, never pruned here.
    { ...base, id: unprocessed },
    // Dead-lettered and unprocessed: forensic evidence, never pruned here.
    { ...base, deadLetteredAt: daysAgo(60), id: deadLettered },
  ]);

  return {
    // aggregateId scoping keeps the lane independent of other spec data.
    cleanup: async () => {
      await database
        .delete(outboxEvent)
        .where(
          inArray(outboxEvent.id, [
            ...oldProcessed,
            freshProcessed,
            unprocessed,
            deadLettered,
          ])
        );
    },
    database,
    ids: { deadLettered, freshProcessed, oldProcessed, unprocessed },
  };
};

describe("pruneProcessedOutboxEvents", () => {
  let sqlClient: ReturnType<typeof postgres> | null = null;
  let fixture: Fixture | null = null;

  beforeAll(async () => {
    const available = await isPostgresAvailable();
    if (!available) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    sqlClient = postgres(testDatabaseUrl, { max: 2 });
    fixture = await seed(drizzle(sqlClient, { schema }));
  });

  afterAll(async () => {
    await fixture?.cleanup();
    await sqlClient?.end({ timeout: 5 });
  });

  it("deletes only processed events past the retention window", async () => {
    if (!fixture) {
      return;
    }
    const deleted = await pruneProcessedOutboxEvents(fixture.database, {
      batchSize: 100,
      now: NOW,
      retentionDays: RETENTION_DAYS,
    });
    expect(deleted).toBe(fixture.ids.oldProcessed.length);

    const survivors = await fixture.database
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        inArray(outboxEvent.id, [
          ...fixture.ids.oldProcessed,
          fixture.ids.freshProcessed,
          fixture.ids.unprocessed,
          fixture.ids.deadLettered,
        ])
      );
    const survivorIds = new Set(survivors.map((row) => row.id));
    expect(survivorIds).toEqual(
      new Set([
        fixture.ids.freshProcessed,
        fixture.ids.unprocessed,
        fixture.ids.deadLettered,
      ])
    );
  });

  it("honours the batch cap instead of deleting the whole backlog at once", async () => {
    if (!fixture) {
      return;
    }
    const batchIds = [crypto.randomUUID(), crypto.randomUUID()];
    await fixture.database.insert(outboxEvent).values(
      batchIds.map((id) => ({
        aggregateId: crypto.randomUUID(),
        aggregateType: "aanvraag",
        eventType: "aanvraag.observed",
        id,
        payload: { probe: true },
        processedAt: daysAgo(45),
      }))
    );
    try {
      const deleted = await pruneProcessedOutboxEvents(fixture.database, {
        batchSize: 1,
        now: NOW,
        retentionDays: RETENTION_DAYS,
      });
      expect(deleted).toBe(1);
      const remaining = await fixture.database
        .select({ id: outboxEvent.id })
        .from(outboxEvent)
        .where(inArray(outboxEvent.id, batchIds));
      expect(remaining).toHaveLength(1);
    } finally {
      await fixture.database
        .delete(outboxEvent)
        .where(inArray(outboxEvent.id, batchIds));
    }
  });
});
