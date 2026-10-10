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

import { curateObservation } from "@ji/application/identity";
import type { StoredAanvraag } from "@ji/application/identity";
import { AANVRAAG_STATUS_GEWIJZIGD_EVENT } from "@ji/application/lifecycle";
import { SOURCES } from "@ji/application/sources";
import {
  CONNECTOR_OBSERVATION_CONTRACT_VERSION,
  InMemoryObjectStore,
} from "@ji/connectors";
import type {
  ConnectorObservation,
  ConnectorRunKind,
  ObjectStore,
} from "@ji/connectors";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { candidateSourceRecordIds, curateScrapeRun } from "./curate-scrape-run";
import { PostgresCurateStore } from "./postgres-curate-store";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagObservation,
  aanvraagVersie,
  bron,
  outboxEvent,
  scrapeRun,
  sourceRecord,
} from "./schema";

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
const BRON_ID: BronId = "00000000-0000-4000-8000-0000000000ad";
const BRON_SLUG = "opdrachtoverheid" as const;
const BASE_TIME = Date.parse("2026-09-03T08:00:00.000Z");

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

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

const atMinute = (minute: number): Date =>
  new Date(BASE_TIME + minute * 60_000);

const payloadBody = (bronReferentie: string, title: string): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      jobPosting: null,
      tender: {
        opdracht_overheid_url: `https://www.opdrachtoverheid.nl/inhuuropdracht/test/recovery/${bronReferentie}`,
        tender_buying_organization: "Synthetic Recovery Organisation",
        tender_id: bronReferentie,
        tender_name: title,
        web_key: bronReferentie,
      },
    })
  );

const rawRef = (bronReferentie: string, contentHash: string): string =>
  `raw/opdrachtoverheid/rjc-433/${bronReferentie}/${contentHash}.json`;

const putRaw = (
  objectStore: InMemoryObjectStore,
  bronReferentie: string,
  contentHash: string,
  title: string
): Promise<void> =>
  objectStore.put({
    body: payloadBody(bronReferentie, title),
    contentType: "json",
    expiresAt: atMinute(10_000),
    path: rawRef(bronReferentie, contentHash),
  });

const snapshotFor = (stored: StoredAanvraag) => ({
  beschrijving: stored.beschrijving,
  bron_referentie: stored.bronReferentie,
  bron_specifiek: stored.bronSpecifiek,
  status: stored.status,
  tarief_eenheid: stored.tariefEenheid ?? "UNKNOWN",
  tarief_max: stored.tariefMax ?? "UNKNOWN",
  tarief_min: stored.tariefMin ?? "UNKNOWN",
  titel: stored.titel,
});

const seedRun = async (
  database: TestDatabase,
  minute: number,
  runKind: ConnectorRunKind = "poll"
): Promise<ScrapeRunId> => {
  const id: ScrapeRunId = crypto.randomUUID();
  await database.insert(scrapeRun).values({
    bronId: BRON_ID,
    geindigd: atMinute(minute + 1),
    gestart: atMinute(minute),
    id,
    runKind,
    status: "succeeded",
  });
  return id;
};

const seedSourceRecord = async (
  database: TestDatabase,
  bronReferentie: string,
  scrapeRunId: ScrapeRunId,
  contentHash = "listing-hash"
): Promise<string> => {
  const id = crypto.randomUUID();
  await database.insert(sourceRecord).values({
    bronId: BRON_ID,
    bronReferentie,
    contentHash,
    id,
    rawPayloadRef: rawRef(bronReferentie, contentHash),
    scrapeRunId,
  });
  return id;
};

interface SeedObservationInput {
  bronReferentie: string;
  contentHash: string;
  database: TestDatabase;
  minute: number;
  objectStore?: InMemoryObjectStore;
  outcome?: "changed" | "new" | "unchanged";
  payloadOverrides?: Partial<ConnectorObservation>;
  rawPayloadRef?: string;
  scrapeRunId: ScrapeRunId;
  sourceRecordId: string;
  status?: string;
  title: string;
}

const seedObservation = async (
  input: SeedObservationInput
): Promise<string> => {
  const id = crypto.randomUUID();
  const objectRef =
    input.rawPayloadRef ?? rawRef(input.bronReferentie, input.contentHash);
  const body = payloadBody(input.bronReferentie, input.title);
  await input.objectStore?.put({
    body,
    contentType: "json",
    expiresAt: atMinute(10_000),
    path: objectRef,
  });
  await input.database.insert(aanvraagObservation).values({
    bronId: BRON_ID,
    contentHash: input.contentHash,
    createdAt: atMinute(input.minute),
    id,
    outcome: input.outcome ?? "changed",
    payload: {
      bronId: BRON_ID,
      bronReferentie: input.bronReferentie,
      contentHash: input.contentHash,
      contentType: "json",
      contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
      observedAt: atMinute(input.minute).toISOString(),
      rawPayloadRef: objectRef,
      scrapeRunId: input.scrapeRunId,
      sourceRecordId: input.sourceRecordId,
      ...input.payloadOverrides,
    },
    scrapeRunId: input.scrapeRunId,
    sourceRecordId: input.sourceRecordId,
    status: input.status ?? "awaiting_curation",
  });
  return id;
};

const seedCommitted = async (input: {
  bronReferentie: string;
  contentHash: string;
  database: TestDatabase;
  minute: number;
  rawPayloadRef?: string;
  scrapeRunId: ScrapeRunId;
  title: string;
}): Promise<string> => {
  const objectRef =
    input.rawPayloadRef ?? rawRef(input.bronReferentie, input.contentHash);
  const body = payloadBody(input.bronReferentie, input.title);
  const draft = SOURCES[BRON_SLUG].normalise(body, input.contentHash);
  const result = await curateObservation(
    new PostgresCurateStore(input.database),
    {
      bronId: BRON_ID,
      draft,
      observedAt: atMinute(input.minute),
      rawPayloadRef: objectRef,
      scrapeRunId: input.scrapeRunId,
    }
  );
  if (!result.aanvraagId) {
    throw new Error("Expected committed fixture to create an aanvraag");
  }
  return result.aanvraagId;
};

const seedLifecycleVersion = async (input: {
  aanvraagId: string;
  database: TestDatabase;
  minute: number;
  scrapeRunId: ScrapeRunId;
  status: "closed" | "stale";
}): Promise<void> => {
  const store = new PostgresCurateStore(input.database);
  const [identity] = await input.database
    .select({ bronReferentie: aanvraag.bronReferentie })
    .from(aanvraag)
    .where(eq(aanvraag.id, input.aanvraagId))
    .limit(1);
  if (!identity) {
    throw new Error("Expected lifecycle fixture identity");
  }
  await store.withTransaction(async (transactionStore) => {
    const existing = await transactionStore.findAanvraagByIdentity(
      BRON_ID,
      identity.bronReferentie
    );
    if (!existing) {
      throw new Error("Expected lifecycle fixture aanvraag");
    }
    const geldigVan = atMinute(input.minute);
    const versie = existing.versie + 1;
    await transactionStore.closeOpenVersie(existing.aanvraagId, geldigVan);
    const updated = await transactionStore.updateAanvraag(existing.aanvraagId, {
      status: input.status,
      versie,
    });
    await transactionStore.insertVersie({
      aanvraagId: updated.aanvraagId,
      contentHash: updated.contentHash,
      geldigTot: null,
      geldigVan,
      rawPayloadRef: updated.rawPayloadRef,
      scrapeRunId: input.scrapeRunId,
      snapshot: snapshotFor(updated),
      versie,
    });
    await transactionStore.insertOutboxEvent({
      aggregateId: updated.aanvraagId,
      aggregateType: "aanvraag",
      eventType: AANVRAAG_STATUS_GEWIJZIGD_EVENT,
      payload: {
        missed_polls: 3,
        reden: "listing_verdwenen",
        scrape_run_id: input.scrapeRunId,
        status: input.status,
      },
    });
  });
};

const readHistory = async (database: TestDatabase, aanvraagId: string) => {
  const [current, versions, events] = await Promise.all([
    database
      .select({
        contentHash: aanvraag.contentHash,
        laatstGezienOp: aanvraag.laatstGezienOp,
        status: aanvraag.status,
        titel: aanvraag.titel,
        versie: aanvraag.versie,
      })
      .from(aanvraag)
      .where(eq(aanvraag.id, aanvraagId))
      .limit(1),
    database
      .select({
        contentHash: aanvraagVersie.contentHash,
        geldigTot: aanvraagVersie.geldigTot,
        geldigVan: aanvraagVersie.geldigVan,
        rawPayloadRef: aanvraagVersie.rawPayloadRef,
        scrapeRunId: aanvraagVersie.scrapeRunId,
        versie: aanvraagVersie.versie,
      })
      .from(aanvraagVersie)
      .where(eq(aanvraagVersie.aanvraagId, aanvraagId))
      .orderBy(asc(aanvraagVersie.versie)),
    database
      .select({ eventType: outboxEvent.eventType })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, aanvraagId))
      .orderBy(asc(outboxEvent.sequenceNumber)),
  ]);
  return { current: current[0], events, versions };
};

const expectMonotoneHistory = (
  versions: { geldigTot: Date | null; geldigVan: Date }[]
): void => {
  for (const [index, version] of versions.entries()) {
    const next = versions[index + 1];
    if (next) {
      expect(version.geldigTot).toEqual(next.geldigVan);
      expect(version.geldigVan.getTime()).toBeLessThanOrEqual(
        next.geldigVan.getTime()
      );
    } else {
      expect(version.geldigTot).toBeNull();
    }
  }
};

const cleanFixture = async (database: TestDatabase): Promise<void> => {
  const rows = await database
    .select({ id: aanvraag.id })
    .from(aanvraag)
    .where(eq(aanvraag.bronId, BRON_ID));
  const aanvraagIds = rows.map((row) => row.id);
  if (aanvraagIds.length > 0) {
    await database
      .delete(outboxEvent)
      .where(inArray(outboxEvent.aggregateId, aanvraagIds));
    await database.delete(aanvraag).where(eq(aanvraag.bronId, BRON_ID));
  }
  await database.delete(bron).where(eq(bron.id, BRON_ID));
};

const requeueMissingRaw = async (
  database: TestDatabase,
  freshObservationIds: string[],
  legacyObservationIds: string[]
): Promise<void> => {
  if (freshObservationIds.length > 0) {
    await database
      .update(aanvraagObservation)
      .set({ status: "awaiting_curation" })
      .where(
        and(
          inArray(aanvraagObservation.id, freshObservationIds),
          eq(aanvraagObservation.status, "deferred_missing_raw")
        )
      );
  }
  if (legacyObservationIds.length > 0) {
    await database
      .update(aanvraagObservation)
      .set({ status: "pending" })
      .where(
        and(
          inArray(aanvraagObservation.id, legacyObservationIds),
          eq(aanvraagObservation.status, "deferred_missing_raw_legacy")
        )
      );
  }
};

describe("historical curation recovery (RJC-433)", () => {
  let available = false;
  let migratorClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let database: TestDatabase | undefined;

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
    client = postgres(applicationUrl, { max: 4 });
    database = drizzle(client, { schema });
  });

  beforeEach(async () => {
    if (!database) {
      return;
    }
    await cleanFixture(database);
    await database.insert(bron).values({
      actief: true,
      categorie: "aggregator",
      crawlDelayMs: 0,
      id: BRON_ID,
      ingestieType: "json-api",
      interval: "*/15 * * * *",
      naam: "Opdrachtoverheid recovery regression",
      rateLimitPerMinute: 600,
      retentionDays: 30,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
  });

  afterEach(async () => {
    if (database) {
      await cleanFixture(database);
    }
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await migratorClient?.end({ timeout: 5 });
  });

  it("processes same-run observations after lifecycle-only versions, including exact inherited content", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const initialRunId = await seedRun(database, 0);
    const recoveryRunId = await seedRun(database, 60);

    const unchangedRef = `rjc-433-db-unchanged-${crypto.randomUUID()}`;
    const unchangedSourceId = await seedSourceRecord(
      database,
      unchangedRef,
      initialRunId
    );
    const unchangedRaw = rawRef(unchangedRef, "same-hash");
    const unchangedAanvraagId = await seedCommitted({
      bronReferentie: unchangedRef,
      contentHash: "same-hash",
      database,
      minute: 5,
      rawPayloadRef: unchangedRaw,
      scrapeRunId: initialRunId,
      title: "Same content",
    });
    await seedLifecycleVersion({
      aanvraagId: unchangedAanvraagId,
      database,
      minute: 70,
      scrapeRunId: recoveryRunId,
      status: "stale",
    });
    await seedObservation({
      bronReferentie: unchangedRef,
      contentHash: "same-hash",
      database,
      minute: 65,
      objectStore,
      rawPayloadRef: unchangedRaw,
      scrapeRunId: recoveryRunId,
      sourceRecordId: unchangedSourceId,
      title: "Same content",
    });

    const changedRef = `rjc-433-db-changed-${crypto.randomUUID()}`;
    const changedSourceId = await seedSourceRecord(
      database,
      changedRef,
      initialRunId
    );
    const changedAanvraagId = await seedCommitted({
      bronReferentie: changedRef,
      contentHash: "before-hash",
      database,
      minute: 6,
      scrapeRunId: initialRunId,
      title: "Before lifecycle",
    });
    await seedLifecycleVersion({
      aanvraagId: changedAanvraagId,
      database,
      minute: 71,
      scrapeRunId: recoveryRunId,
      status: "stale",
    });
    await seedObservation({
      bronReferentie: changedRef,
      contentHash: "after-hash",
      database,
      minute: 66,
      objectStore,
      scrapeRunId: recoveryRunId,
      sourceRecordId: changedSourceId,
      title: "After lifecycle",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: recoveryRunId,
    });

    expect(result).toMatchObject({
      alreadyCommitted: 0,
      curated: 1,
      remaining: 0,
      unchanged: 1,
    });
    const unchanged = await readHistory(database, unchangedAanvraagId);
    // CTP-498: the replayed observation flips the lifecycle-only `stale` back
    // to `active` on unchanged content. `status` is a snapshot field, so that
    // now closes the lifecycle version and opens a third one, and it carries
    // its own status event -- without which the search index would keep the
    // stale status, because the projector skips a later same-content event.
    expect(unchanged.current).toMatchObject({
      contentHash: "same-hash",
      laatstGezienOp: atMinute(70),
      status: "active",
      versie: 3,
    });
    expect(unchanged.versions).toHaveLength(3);
    expect(unchanged.events).toHaveLength(3);
    expect(unchanged.events.at(-1)?.eventType).toBe(
      AANVRAAG_STATUS_GEWIJZIGD_EVENT
    );
    expectMonotoneHistory(unchanged.versions);

    const changed = await readHistory(database, changedAanvraagId);
    expect(changed.current).toMatchObject({
      contentHash: "after-hash",
      laatstGezienOp: atMinute(71),
      status: "active",
      titel: "After lifecycle",
      versie: 3,
    });
    expect(changed.versions.map((version) => version.contentHash)).toEqual([
      "before-hash",
      "before-hash",
      "after-hash",
    ]);
    expect(changed.events).toHaveLength(3);
    expectMonotoneHistory(changed.versions);
  });

  it("supersedes delayed older content and terminalizes an exact committed version without raw readback", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const contentRunId = await seedRun(database, 0);
    const lifecycleRunId = await seedRun(database, 60);
    const delayedRef = `rjc-433-db-delayed-${crypto.randomUUID()}`;
    const delayedSourceId = await seedSourceRecord(
      database,
      delayedRef,
      contentRunId
    );
    const delayedAanvraagId = await seedCommitted({
      bronReferentie: delayedRef,
      contentHash: "content-b",
      database,
      minute: 20,
      scrapeRunId: contentRunId,
      title: "Newer B",
    });
    await seedObservation({
      bronReferentie: delayedRef,
      contentHash: "content-b",
      database,
      minute: 15,
      rawPayloadRef: rawRef(delayedRef, "content-b"),
      scrapeRunId: contentRunId,
      sourceRecordId: delayedSourceId,
      status: "curated",
      title: "Newer B",
    });
    const delayedObservationId = await seedObservation({
      bronReferentie: delayedRef,
      contentHash: "content-a",
      database,
      minute: 10,
      scrapeRunId: contentRunId,
      sourceRecordId: delayedSourceId,
      title: "Older A",
    });
    const laterObservationId = await seedObservation({
      bronReferentie: delayedRef,
      contentHash: "content-c",
      database,
      minute: 17,
      objectStore,
      scrapeRunId: contentRunId,
      sourceRecordId: delayedSourceId,
      title: "Later C",
    });

    const exactRunId = await seedRun(database, 120, "test");
    const exactRef = `rjc-433-db-exact-${crypto.randomUUID()}`;
    const exactSourceId = await seedSourceRecord(
      database,
      exactRef,
      exactRunId
    );
    const exactRaw = rawRef(exactRef, "exact-hash");
    const exactAanvraagId = await seedCommitted({
      bronReferentie: exactRef,
      contentHash: "exact-hash",
      database,
      minute: 125,
      rawPayloadRef: exactRaw,
      scrapeRunId: exactRunId,
      title: "Already committed",
    });
    const exactObservationId = await seedObservation({
      bronReferentie: exactRef,
      contentHash: "exact-hash",
      database,
      minute: 125,
      rawPayloadRef: exactRaw,
      scrapeRunId: exactRunId,
      sourceRecordId: exactSourceId,
      status: "pending",
      title: "Already committed",
    });

    const firstResult = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: lifecycleRunId,
    });
    expect(firstResult).toMatchObject({
      alreadyCommitted: 1,
      curated: 1,
      remaining: 0,
      superseded: 1,
    });

    await seedLifecycleVersion({
      aanvraagId: delayedAanvraagId,
      database,
      minute: 70,
      scrapeRunId: lifecycleRunId,
      status: "closed",
    });
    const delayedAfterLifecycleId = await seedObservation({
      bronReferentie: delayedRef,
      contentHash: "content-pre-a",
      database,
      minute: 8,
      scrapeRunId: contentRunId,
      sourceRecordId: delayedSourceId,
      title: "Prehistoric content",
    });
    const secondResult = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: lifecycleRunId,
    });
    expect(secondResult).toMatchObject({
      curated: 0,
      remaining: 0,
      superseded: 1,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: delayedObservationId, status: "superseded" },
        { id: laterObservationId, status: "curated" },
        { id: delayedAfterLifecycleId, status: "superseded" },
        { id: exactObservationId, status: "already_committed" },
      ])
    );
    const delayed = await readHistory(database, delayedAanvraagId);
    expect(delayed.current).toMatchObject({
      contentHash: "content-c",
      status: "closed",
      titel: "Later C",
      versie: 3,
    });
    expect(delayed.versions.map((version) => version.contentHash)).toEqual([
      "content-b",
      "content-c",
      "content-c",
    ]);
    expect(delayed.events).toHaveLength(3);
    expectMonotoneHistory(delayed.versions);
    const exact = await readHistory(database, exactAanvraagId);
    expect(exact.versions).toHaveLength(1);
    expect(exact.events).toHaveLength(1);
  });

  it("lets later malformed history yield to valid work while earlier malformed history blocks safely", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const earlierRunId = await seedRun(database, 0);
    const laterRunId = await seedRun(database, 60);

    const allowedRef = `rjc-433-db-malformed-later-${crypto.randomUUID()}`;
    const allowedSourceId = await seedSourceRecord(
      database,
      allowedRef,
      earlierRunId
    );
    const allowedObservationId = await seedObservation({
      bronReferentie: allowedRef,
      contentHash: "valid-earlier",
      database,
      minute: 10,
      objectStore,
      scrapeRunId: earlierRunId,
      sourceRecordId: allowedSourceId,
      title: "Valid before malformed",
    });
    const malformedLaterId = crypto.randomUUID();
    await database.insert(aanvraagObservation).values({
      bronId: BRON_ID,
      contentHash: "malformed-later",
      createdAt: atMinute(70),
      id: malformedLaterId,
      outcome: "changed",
      payload: { observedAt: atMinute(70).toISOString() },
      scrapeRunId: laterRunId,
      sourceRecordId: allowedSourceId,
      status: "awaiting_curation",
    });

    const blockedRef = `rjc-433-db-malformed-earlier-${crypto.randomUUID()}`;
    const blockedSourceId = await seedSourceRecord(
      database,
      blockedRef,
      earlierRunId
    );
    const malformedEarlierId = crypto.randomUUID();
    await database.insert(aanvraagObservation).values({
      bronId: BRON_ID,
      contentHash: "malformed-earlier",
      createdAt: atMinute(5),
      id: malformedEarlierId,
      outcome: "changed",
      payload: { observedAt: atMinute(5).toISOString() },
      scrapeRunId: earlierRunId,
      sourceRecordId: blockedSourceId,
      status: "awaiting_curation",
    });
    const blockedObservationId = await seedObservation({
      bronReferentie: blockedRef,
      contentHash: "valid-later",
      database,
      minute: 75,
      objectStore,
      scrapeRunId: laterRunId,
      sourceRecordId: blockedSourceId,
      title: "Blocked by ambiguous predecessor",
    });

    const result = await curateScrapeRun({
      attemptLimit: 4,
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: laterRunId,
    });

    expect(result).toMatchObject({
      blockedOrdering: 3,
      curated: 1,
      remaining: 3,
    });
    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: allowedObservationId, status: "curated" },
        { id: malformedLaterId, status: "blocked_ordering" },
        { id: malformedEarlierId, status: "blocked_ordering" },
        { id: blockedObservationId, status: "blocked_ordering" },
      ])
    );
    const [allowed] = await database
      .select({ id: aanvraag.id })
      .from(aanvraag)
      .where(
        and(
          eq(aanvraag.bronId, BRON_ID),
          eq(aanvraag.bronReferentie, allowedRef)
        )
      );
    expect(allowed?.id).toBeDefined();
    if (!allowed) {
      throw new Error("Expected valid observation to create an aanvraag");
    }
    const allowedHistory = await readHistory(database, allowed.id);
    expect(allowedHistory.current).toMatchObject({
      contentHash: "valid-earlier",
      status: "active",
      titel: "Valid before malformed",
      versie: 1,
    });
    expect(allowedHistory.versions).toHaveLength(1);
    expect(allowedHistory.events).toHaveLength(1);
    expectMonotoneHistory(allowedHistory.versions);
    const [blocked] = await database
      .select({ id: aanvraag.id })
      .from(aanvraag)
      .where(
        and(
          eq(aanvraag.bronId, BRON_ID),
          eq(aanvraag.bronReferentie, blockedRef)
        )
      );
    expect(blocked).toBeUndefined();
  });

  it("does not let a full malformed queue starve valid cross-kind backlog", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const backlogRunId = await seedRun(database, 0, "test");
    const requestedRunId = await seedRun(database, 60, "poll");
    const validRef = `rjc-433-db-cross-kind-${crypto.randomUUID()}`;
    const validSourceId = await seedSourceRecord(
      database,
      validRef,
      backlogRunId
    );
    const validObservationId = await seedObservation({
      bronReferentie: validRef,
      contentHash: "cross-kind-valid",
      database,
      minute: 10,
      objectStore,
      scrapeRunId: backlogRunId,
      sourceRecordId: validSourceId,
      title: "Cross-kind valid backlog",
    });
    for (let index = 0; index < 3; index += 1) {
      const malformedRef = `rjc-433-db-starvation-${index}-${crypto.randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- fixture rows are intentionally ordered
      const malformedSourceId = await seedSourceRecord(
        database,
        malformedRef,
        requestedRunId
      );
      // oxlint-disable-next-line no-await-in-loop -- fixture rows are intentionally ordered
      await database.insert(aanvraagObservation).values({
        bronId: BRON_ID,
        contentHash: `malformed-${index}`,
        createdAt: atMinute(61 + index),
        outcome: "changed",
        payload: { observedAt: atMinute(61 + index).toISOString() },
        scrapeRunId: requestedRunId,
        sourceRecordId: malformedSourceId,
        status: "awaiting_curation",
      });
    }

    const result = await curateScrapeRun({
      attemptLimit: 1,
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: requestedRunId,
    });

    expect(result).toMatchObject({
      blockedOrdering: 0,
      curated: 1,
      remaining: 3,
    });
    expect(result.attemptedObservationIds).toEqual([validObservationId]);
    const [current] = await database
      .select({ id: aanvraag.id })
      .from(aanvraag)
      .where(
        and(eq(aanvraag.bronId, BRON_ID), eq(aanvraag.bronReferentie, validRef))
      );
    if (!current) {
      throw new Error("Expected cross-kind backlog aanvraag");
    }
    const history = await readHistory(database, current.id);
    expect(history.current).toMatchObject({
      contentHash: "cross-kind-valid",
      status: "active",
      titel: "Cross-kind valid backlog",
      versie: 1,
    });
    expect(history.versions).toHaveLength(1);
    expect(history.events).toHaveLength(1);
    expectMonotoneHistory(history.versions);
  });

  it("durably defers missing raw work so bounded retries reach ready rows and recover without duplicates", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    const missing = [
      {
        contentHash: "missing-fresh-one",
        legacy: false,
        ref: `rjc-433-db-missing-fresh-one-${crypto.randomUUID()}`,
        title: "Missing fresh one",
      },
      {
        contentHash: "missing-legacy",
        legacy: true,
        ref: `rjc-433-db-missing-legacy-${crypto.randomUUID()}`,
        title: "Missing legacy",
      },
      {
        contentHash: "missing-fresh-two",
        legacy: false,
        ref: `rjc-433-db-missing-fresh-two-${crypto.randomUUID()}`,
        title: "Missing fresh two",
      },
    ];
    const missingObservationIds: string[] = [];
    for (const [index, fixture] of missing.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- fixture order creates the starvation boundary
      const sourceRecordId = await seedSourceRecord(
        database,
        fixture.ref,
        runId
      );
      // oxlint-disable-next-line no-await-in-loop -- fixture order creates the starvation boundary
      const observationId = await seedObservation({
        bronReferentie: fixture.ref,
        contentHash: fixture.contentHash,
        database,
        minute: 10 + index,
        scrapeRunId: runId,
        sourceRecordId,
        status: fixture.legacy ? "pending" : "awaiting_curation",
        title: fixture.title,
      });
      missingObservationIds.push(observationId);
    }
    const [freshOneId, legacyId, freshTwoId] = missingObservationIds;
    if (!freshOneId || !legacyId || !freshTwoId) {
      throw new Error("Expected all missing-raw fixture observations");
    }
    const readyRef = `rjc-433-db-ready-after-missing-${crypto.randomUUID()}`;
    const readySourceId = await seedSourceRecord(database, readyRef, runId);
    const readyObservationId = await seedObservation({
      bronReferentie: readyRef,
      contentHash: "ready-after-missing",
      database,
      minute: 13,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId: readySourceId,
      title: "Ready after missing",
    });
    let progressCalls = 0;
    const input = {
      attemptLimit: 2,
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      onProgress: () => {
        progressCalls += 1;
        return Promise.resolve();
      },
      scrapeRunId: runId,
    };

    const first = await curateScrapeRun(input);
    expect(first).toMatchObject({ curated: 0, pending: 2, remaining: 4 });
    expect(progressCalls).toBe(0);
    expect(first.attemptedObservationIds).toEqual(
      missingObservationIds.slice(0, 2)
    );
    const firstStatuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(firstStatuses).toEqual(
      expect.arrayContaining([
        {
          id: freshOneId,
          status: "deferred_missing_raw",
        },
        {
          id: legacyId,
          status: "deferred_missing_raw_legacy",
        },
      ])
    );

    const second = await curateScrapeRun(input);
    expect(second).toMatchObject({ curated: 1, pending: 3, remaining: 3 });
    expect(progressCalls).toBe(1);
    expect(second.attemptedObservationIds).toEqual([
      freshTwoId,
      readyObservationId,
    ]);
    const [readyObservation] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, readyObservationId));
    expect(readyObservation?.status).toBe("curated");

    for (const fixture of missing) {
      // oxlint-disable-next-line no-await-in-loop -- raw restoration mirrors independent object arrival
      await putRaw(
        objectStore,
        fixture.ref,
        fixture.contentHash,
        fixture.title
      );
    }
    const dormant = await curateScrapeRun(input);
    expect(dormant).toMatchObject({ curated: 0, pending: 3, remaining: 3 });
    expect(progressCalls).toBe(1);
    expect(dormant.attemptedObservationIds).toEqual([]);
    await requeueMissingRaw(database, [freshOneId, freshTwoId], [legacyId]);
    const requeuedStatuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(requeuedStatuses).toEqual(
      expect.arrayContaining([
        { id: freshOneId, status: "awaiting_curation" },
        { id: legacyId, status: "pending" },
        { id: freshTwoId, status: "awaiting_curation" },
      ])
    );
    const third = await curateScrapeRun(input);
    const fourth = await curateScrapeRun(input);
    const replay = await curateScrapeRun(input);
    expect(third).toMatchObject({ curated: 2, pending: 0, remaining: 1 });
    expect(fourth).toMatchObject({ curated: 1, pending: 0, remaining: 0 });
    expect(replay).toMatchObject({ curated: 0, pending: 0, remaining: 0 });
    expect(progressCalls).toBe(4);

    const observations = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(observations).toHaveLength(4);
    expect(observations.every((row) => row.status === "curated")).toBe(true);
    const aanvragen = await database
      .select({ id: aanvraag.id })
      .from(aanvraag)
      .where(eq(aanvraag.bronId, BRON_ID));
    expect(aanvragen).toHaveLength(4);
    for (const current of aanvragen) {
      // oxlint-disable-next-line no-await-in-loop -- each identity has an independent SCD2 history
      const history = await readHistory(database, current.id);
      expect(history.versions).toHaveLength(1);
      expect(history.events).toHaveLength(1);
      expectMonotoneHistory(history.versions);
    }
  });

  it("preserves legacy classification while an exact committed row waits behind missing raw history", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const predecessorRunId = await seedRun(database, 0);
    const committedRunId = await seedRun(database, 60);
    const bronReferentie = `rjc-433-db-legacy-deferred-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      predecessorRunId
    );
    const missingPredecessorId = await seedObservation({
      bronReferentie,
      contentHash: "missing-predecessor",
      database,
      minute: 10,
      scrapeRunId: predecessorRunId,
      sourceRecordId,
      title: "Missing predecessor",
    });
    const predecessorInput = {
      attemptLimit: 2,
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: predecessorRunId,
    };
    const deferred = await curateScrapeRun(predecessorInput);
    expect(deferred).toMatchObject({ pending: 1, remaining: 1 });

    const committedRaw = rawRef(bronReferentie, "legacy-exact");
    const aanvraagId = await seedCommitted({
      bronReferentie,
      contentHash: "legacy-exact",
      database,
      minute: 65,
      rawPayloadRef: committedRaw,
      scrapeRunId: committedRunId,
      title: "Legacy exact committed",
    });
    const legacyObservationId = await seedObservation({
      bronReferentie,
      contentHash: "legacy-exact",
      database,
      minute: 65,
      rawPayloadRef: committedRaw,
      scrapeRunId: committedRunId,
      sourceRecordId,
      status: "pending",
      title: "Legacy exact committed",
    });
    const input = {
      attemptLimit: 2,
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: committedRunId,
    };

    const blocked = await curateScrapeRun(input);
    expect(blocked).toMatchObject({
      blockedOrdering: 1,
      pending: 1,
      remaining: 2,
    });
    const [legacyBlocked] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, legacyObservationId));
    expect(legacyBlocked?.status).toBe("blocked_ordering_legacy");

    await putRaw(
      objectStore,
      bronReferentie,
      "missing-predecessor",
      "Missing predecessor"
    );
    await requeueMissingRaw(database, [missingPredecessorId], []);
    const recovered = await curateScrapeRun(input);
    expect(recovered).toMatchObject({
      alreadyCommitted: 1,
      remaining: 0,
      superseded: 1,
    });
    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: missingPredecessorId, status: "superseded" },
        { id: legacyObservationId, status: "already_committed" },
      ])
    );
    expect(objectStore.has(committedRaw)).toBe(false);
    const history = await readHistory(database, aanvraagId);
    expect(history.current).toMatchObject({
      contentHash: "legacy-exact",
      titel: "Legacy exact committed",
      versie: 1,
    });
    expect(history.versions).toHaveLength(1);
    expect(history.events).toHaveLength(1);
    expectMonotoneHistory(history.versions);
  });

  it("parks a candidate that throws and still curates the next identity (CTP-499)", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    // Two identities in one run. The poison one is created first, so
    // `fairOldestFirst` offers it first -- exactly the production ordering that
    // let it abort every pass before this identity could ever be reached.
    const poisonReferentie = `ctp-499-poison-${crypto.randomUUID()}`;
    const healthyReferentie = `ctp-499-healthy-${crypto.randomUUID()}`;
    const poisonSourceRecordId = await seedSourceRecord(
      database,
      poisonReferentie,
      runId
    );
    const healthySourceRecordId = await seedSourceRecord(
      database,
      healthyReferentie,
      runId
    );
    const poisonObservationId = await seedObservation({
      bronReferentie: poisonReferentie,
      contentHash: "ctp-499-poison",
      database,
      minute: 10,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId: poisonSourceRecordId,
      title: "Poison observation",
    });
    const healthyObservationId = await seedObservation({
      bronReferentie: healthyReferentie,
      contentHash: "ctp-499-healthy",
      database,
      minute: 20,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId: healthySourceRecordId,
      title: "Healthy observation",
    });

    // Stands in for the real defect: a throw raised from inside the curation
    // transaction, which is where `PostgresError 54000` came from. A raw
    // payload that is not parseable JSON makes `SOURCES[...].normalise` throw
    // at exactly that point, and unlike an unreadable object it is a property
    // of this row, so the terminal status is the right answer. Any unexpected
    // throw out of `processCandidate` reaches the same branch.
    const poisonRef = rawRef(poisonReferentie, "ctp-499-poison");
    const failingObjectStore: ObjectStore = {
      deleteExpired: (before: Date) => objectStore.deleteExpired(before),
      get: async (objectPath: string) => {
        const stored = await objectStore.get(objectPath);
        if (objectPath !== poisonRef || !stored) {
          return stored;
        }
        return {
          ...stored,
          body: new TextEncoder().encode("{ not valid json"),
        };
      },
      put: (object) => objectStore.put(object),
    };
    const input = {
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore: failingObjectStore,
      scrapeRunId: runId,
    };

    const first = await curateScrapeRun(input);

    expect(first).toMatchObject({ curated: 1, failed: 1 });
    expect(first.attemptedObservationIds).toEqual(
      expect.arrayContaining([poisonObservationId, healthyObservationId])
    );
    // The parked row is terminal, so it is not backlog any more.
    expect(first.remaining).toBe(0);
    const afterFirst = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(afterFirst).toEqual(
      expect.arrayContaining([
        { id: poisonObservationId, status: "curation_failed" },
        { id: healthyObservationId, status: "curated" },
      ])
    );

    const second = await curateScrapeRun(input);

    expect(second).toMatchObject({ curated: 0, failed: 0, remaining: 0 });
    expect(second.attemptedObservationIds).not.toContain(poisonObservationId);
    const [afterSecond] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, poisonObservationId));
    expect(afterSecond?.status).toBe("curation_failed");
  });

  it("aborts rather than parking when the object store is unreachable (CTP-499)", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    const bronReferentie = `ctp-499-unreadable-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      runId
    );
    const observationId = await seedObservation({
      bronReferentie,
      contentHash: "ctp-499-unreadable",
      database,
      minute: 10,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId,
      title: "Unreadable raw",
    });
    const unreachableObjectStore: ObjectStore = {
      deleteExpired: (before: Date) => objectStore.deleteExpired(before),
      get: () => Promise.reject(new Error("object store unreachable")),
      put: (object) => objectStore.put(object),
    };

    // Neither status the pass could write is self-clearing, so an outage must
    // leave the row exactly as it found it.
    await expect(
      curateScrapeRun({
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        database,
        objectStore: unreachableObjectStore,
        scrapeRunId: runId,
      })
    ).rejects.toThrow("Raw object read failed for");
    const [afterOutage] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, observationId));
    expect(afterOutage?.status).toBe("awaiting_curation");

    // The next poll, with the store back, curates it with no operator action.
    const recovered = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: runId,
    });

    expect(recovered).toMatchObject({ curated: 1, failed: 0, remaining: 0 });
  });

  it("aborts rather than parking on a transient Postgres error (CTP-499)", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    const bronReferentie = `ctp-499-deadlock-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      runId
    );
    const observationId = await seedObservation({
      bronReferentie,
      contentHash: "ctp-499-deadlock",
      database,
      minute: 10,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId,
      title: "Deadlocked",
    });
    let raised = false;
    const deadlockingObjectStore: ObjectStore = {
      deleteExpired: (before: Date) => objectStore.deleteExpired(before),
      get: async (objectPath: string) => {
        const stored = await objectStore.get(objectPath);
        if (raised) {
          return stored;
        }
        raised = true;
        // A deadlock surfaces from inside the transaction in production; this
        // raises the same shape one step earlier, which is the same branch.
        throw new Error("Failed query: select ... for update", {
          cause: Object.assign(new Error("deadlock detected"), {
            code: "40P01",
          }),
        });
      },
      put: (object) => objectStore.put(object),
    };
    const input = {
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore: deadlockingObjectStore,
      scrapeRunId: runId,
    };

    await expect(curateScrapeRun(input)).rejects.toThrow();
    const [afterDeadlock] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, observationId));
    // A retry would have curated it, so it must not have burned a status.
    expect(afterDeadlock?.status).toBe("awaiting_curation");

    expect(await curateScrapeRun(input)).toMatchObject({
      curated: 1,
      failed: 0,
    });
  });

  it("stops a pass once too many observations park (CTP-499)", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    const poisonCount = 7;
    const observationIds: string[] = [];
    for (let index = 0; index < poisonCount; index += 1) {
      const bronReferentie = `ctp-499-systemic-${index}-${crypto.randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- fixture rows are seeded in order
      const sourceRecordId = await seedSourceRecord(
        database,
        bronReferentie,
        runId
      );
      observationIds.push(
        // oxlint-disable-next-line no-await-in-loop -- fixture rows are seeded in order
        await seedObservation({
          bronReferentie,
          contentHash: `ctp-499-systemic-${index}`,
          database,
          minute: 10 + index,
          objectStore,
          scrapeRunId: runId,
          sourceRecordId,
          title: `Systemic ${index}`,
        })
      );
    }
    // Every row fails the same way: what a revoked grant or a half-applied
    // deploy looks like one row at a time.
    const corruptingObjectStore: ObjectStore = {
      deleteExpired: (before: Date) => objectStore.deleteExpired(before),
      get: async (objectPath: string) => {
        const stored = await objectStore.get(objectPath);
        return stored
          ? { ...stored, body: new TextEncoder().encode("{ not valid json") }
          : stored;
      },
      put: (object) => objectStore.put(object),
    };

    await expect(
      curateScrapeRun({
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        database,
        objectStore: corruptingObjectStore,
        scrapeRunId: runId,
      })
    ).rejects.toThrow("stopping in case the failure is systemic");

    const parked = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    // Progress is kept: the rows parked before the cap stay parked, and the
    // rest are untouched for the next poll.
    expect(
      parked.filter((row) => row.status === "curation_failed")
    ).toHaveLength(5);
    expect(
      parked.filter((row) => row.status === "awaiting_curation")
    ).toHaveLength(poisonCount - 5);
    expect(observationIds).toHaveLength(poisonCount);
  });

  it("serializes concurrent recovery and leaves repeated runs idempotent", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    const bronReferentie = `rjc-433-db-concurrent-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      runId
    );
    const observationId = await seedObservation({
      bronReferentie,
      contentHash: "concurrent-hash",
      database,
      minute: 10,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId,
      title: "Concurrent recovery",
    });
    const input = {
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: runId,
    };

    const concurrent = await Promise.all([
      curateScrapeRun(input),
      curateScrapeRun(input),
    ]);
    const replay = await curateScrapeRun(input);

    expect(
      concurrent.reduce((total, result) => total + result.curated, 0)
    ).toBe(1);
    expect(replay).toMatchObject({
      alreadyCommitted: 0,
      curated: 0,
      remaining: 0,
    });
    const [observation] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, observationId));
    expect(observation?.status).toBe("curated");
    const [current] = await database
      .select({ id: aanvraag.id })
      .from(aanvraag)
      .where(
        and(
          eq(aanvraag.bronId, BRON_ID),
          eq(aanvraag.bronReferentie, bronReferentie)
        )
      );
    if (!current) {
      throw new Error("Expected concurrent recovery aanvraag");
    }
    const history = await readHistory(database, current.id);
    expect(history.versions).toHaveLength(1);
    expect(history.events).toHaveLength(1);
    expectMonotoneHistory(history.versions);
  });

  it("does not report progress when another curator already completed the selected row", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const currentDatabase = database;
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(currentDatabase, 0);
    const bronReferentie = `ctp-618-progress-race-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      currentDatabase,
      bronReferentie,
      runId
    );
    const observationId = await seedObservation({
      bronReferentie,
      contentHash: "progress-race-hash",
      database: currentDatabase,
      minute: 10,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId,
      title: "Concurrent terminal transition",
    });
    const racingObjectStore: ObjectStore = {
      deleteExpired: (before: Date) => objectStore.deleteExpired(before),
      get: async (objectPath: string) => {
        const stored = await objectStore.get(objectPath);
        // Candidate selection has happened, but its transaction has not locked it yet.
        await currentDatabase
          .update(aanvraagObservation)
          .set({ status: "curated" })
          .where(eq(aanvraagObservation.id, observationId));
        return stored;
      },
      put: (object) => objectStore.put(object),
    };
    let calls = 0;
    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database: currentDatabase,
      objectStore: racingObjectStore,
      onProgress: () => {
        calls += 1;
        return Promise.resolve();
      },
      scrapeRunId: runId,
    });
    expect(result.alreadyCommitted).toBe(1);
    expect(result.remaining).toBe(0);
    expect(calls).toBe(0);
  });

  it("reports committed progress without parking data when telemetry fails", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const currentDatabase = database;
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(currentDatabase, 0);
    const bronReferentie = `ctp-618-progress-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      currentDatabase,
      bronReferentie,
      runId
    );
    const observationId = await seedObservation({
      bronReferentie,
      contentHash: "progress-hash",
      database: currentDatabase,
      minute: 10,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId,
      title: "Committed progress",
    });
    const telemetryError = new Error("telemetry unavailable");
    let calls = 0;
    await expect(
      curateScrapeRun({
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        database: currentDatabase,
        objectStore,
        onProgress: async () => {
          calls += 1;
          const [row] = await currentDatabase
            .select({ status: aanvraagObservation.status })
            .from(aanvraagObservation)
            .where(eq(aanvraagObservation.id, observationId));
          expect(row?.status).toBe("curated");
          throw telemetryError;
        },
        scrapeRunId: runId,
      })
    ).rejects.toBe(telemetryError);
    expect(calls).toBe(1);
    const [row] = await currentDatabase
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, observationId));
    expect(row?.status).toBe("curated");
    const replay = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database: currentDatabase,
      objectStore,
      onProgress: () => {
        calls += 1;
        return Promise.resolve();
      },
      scrapeRunId: runId,
    });
    expect(replay.remaining).toBe(0);
    expect(calls).toBe(1);
  });

  it("rolls back the final observation update when cancellation arrives before return", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    const bronReferentie = `rjc-618-db-abort-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      runId
    );
    const observationId = await seedObservation({
      bronReferentie,
      contentHash: "abort-hash",
      database,
      minute: 10,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId,
      title: "Abort after update",
    });
    const abortController = new AbortController();
    const abortReason = new Error("poller lock lost");
    let finalObservationUpdateExecuted = false;
    const beforeOutbox = await database
      .select({ id: outboxEvent.id })
      .from(outboxEvent);
    /* oxlint-disable promise/prefer-await-to-callbacks, unicorn/prefer-type-error, anti-slop/no-known-value-widening, anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-apply, anti-slop/require-safety-comment-for-type-assertion -- This test-only Proxy sits at the Drizzle transaction boundary to place a real AbortController barrier on the final observation UPDATE. */
    const wrapObservationQuery = (query: object): object =>
      new Proxy(query, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property === "then" && typeof value === "function") {
            return (
              onFulfilled?: (result: unknown) => unknown,
              onRejected?: (error: unknown) => unknown
            ) =>
              Reflect.apply(value, target, [
                (result: unknown) => {
                  finalObservationUpdateExecuted = true;
                  abortController.abort(abortReason);
                  return onFulfilled?.(result);
                },
                onRejected,
              ]);
          }
          if (typeof value !== "function") {
            return value;
          }
          return (...args: unknown[]) => {
            const next = Reflect.apply(value, target, args);
            if (
              next !== null &&
              (typeof next === "object" || typeof next === "function")
            ) {
              return wrapObservationQuery(next);
            }
            return next;
          };
        },
      });
    const wrapTransaction = (transaction: object): object =>
      new Proxy(transaction, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "update" || typeof value !== "function") {
            return value;
          }
          return (table: unknown, ...args: unknown[]) => {
            const query = Reflect.apply(value, target, [table, ...args]);
            if (table !== aanvraagObservation) {
              return query;
            }
            if (
              query === null ||
              (typeof query !== "object" && typeof query !== "function")
            ) {
              throw new Error("Expected observation update query builder");
            }
            return wrapObservationQuery(query);
          };
        },
      });
    const databaseWithAbortBarrier = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "transaction" || typeof value !== "function") {
          return value;
        }
        return (callback: unknown, ...args: unknown[]) => {
          if (typeof callback !== "function") {
            throw new Error("Expected transaction callback");
          }
          return Reflect.apply(value, target, [
            (transaction: object, ...callbackArgs: unknown[]) =>
              Reflect.apply(callback, undefined, [
                wrapTransaction(transaction),
                ...callbackArgs,
              ]),
            ...args,
          ]);
        };
      },
    });
    /* oxlint-enable promise/prefer-await-to-callbacks, unicorn/prefer-type-error, anti-slop/no-known-value-widening, anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-apply, anti-slop/require-safety-comment-for-type-assertion */

    let progressCalls = 0;
    await expect(
      curateScrapeRun({
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        database: databaseWithAbortBarrier,
        objectStore,
        onProgress: () => {
          progressCalls += 1;
          return Promise.resolve();
        },
        scrapeRunId: runId,
        signal: abortController.signal,
      })
    ).rejects.toThrow(abortReason);

    expect(finalObservationUpdateExecuted).toBe(true);
    expect(progressCalls).toBe(0);

    const [observation] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, observationId));
    expect(observation?.status).toBe("awaiting_curation");
    const history = await database
      .select({ id: aanvraag.id })
      .from(aanvraag)
      .where(
        and(
          eq(aanvraag.bronId, BRON_ID),
          eq(aanvraag.bronReferentie, bronReferentie)
        )
      );
    expect(history).toHaveLength(0);
    const afterOutbox = await database
      .select({ id: outboxEvent.id })
      .from(outboxEvent);
    expect(afterOutbox).toEqual(beforeOutbox);
  });

  it("selects oldest heads across a bounded scan larger than one batch", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const identityCount = 101;
    const historicalObservationCount = 11;
    const historicalRunIds: ScrapeRunId[] = [];
    for (
      let revision = 0;
      revision < historicalObservationCount;
      revision += 1
    ) {
      // oxlint-disable-next-line no-await-in-loop -- run starts define pointer order
      historicalRunIds.push(await seedRun(database, revision * 10));
    }
    const currentRunId = await seedRun(database, 600);
    const [firstHistoricalRunId] = historicalRunIds;
    if (!firstHistoricalRunId) {
      throw new Error("Expected historical fixture runs");
    }

    for (let identity = 0; identity < identityCount; identity += 1) {
      const bronReferentie = `rjc-621-large-${identity}-${crypto.randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      const sourceRecordId = await seedSourceRecord(
        database,
        bronReferentie,
        firstHistoricalRunId
      );
      for (
        let revision = 0;
        revision < historicalObservationCount;
        revision += 1
      ) {
        const historicalRunId = historicalRunIds[revision];
        if (!historicalRunId) {
          throw new Error("Expected historical run for every revision");
        }
        // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
        await seedObservation({
          bronReferentie,
          contentHash: `rjc-621-${identity}-${revision}`,
          database,
          minute: identity * (historicalObservationCount + 1) + revision,
          objectStore,
          scrapeRunId: historicalRunId,
          sourceRecordId,
          title: `CTP621 ${identity} revision ${revision}`,
        });
      }
      // The current-run pointer is later than every historical head but is
      // inserted into the current-run scan before the source-wide scan.
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      await seedObservation({
        bronReferentie,
        contentHash: `rjc-621-${identity}-current`,
        database,
        minute:
          identity * (historicalObservationCount + 1) +
          historicalObservationCount,
        objectStore,
        scrapeRunId: currentRunId,
        sourceRecordId,
        title: `CTP621 ${identity} current`,
      });
    }

    const input = {
      attemptLimit: 100,
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: currentRunId,
    };
    const remainingTrend: number[] = [];
    const first = await curateScrapeRun(input);
    remainingTrend.push(first.remaining);
    expect(first).toMatchObject({
      blockedOrdering: 0,
      curated: 100,
      remaining: identityCount * (historicalObservationCount + 1) - 100,
    });

    const firstHeads = await database
      .select({
        contentHash: aanvraagObservation.contentHash,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    const firstHistoricalHeadCount = firstHeads.filter(
      (row) => row.contentHash.endsWith("-0") && row.status === "curated"
    ).length;
    const firstCurrentCount = firstHeads.filter(
      (row) =>
        row.contentHash.endsWith("-current") &&
        row.status !== "awaiting_curation"
    ).length;

    for (let pass = 0; pass < historicalObservationCount + 2; pass += 1) {
      if (remainingTrend.at(-1) === 0) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- repeated bounded recovery pass
      const next = await curateScrapeRun(input);
      remainingTrend.push(next.remaining);
    }

    expect(remainingTrend.at(-1)).toBe(0);
    for (const [index, remaining] of remainingTrend.entries()) {
      if (index === 0) {
        continue;
      }
      const previous = remainingTrend[index - 1];
      if (previous === undefined) {
        throw new Error("Expected previous remaining count");
      }
      expect(remaining).toBeLessThan(previous);
    }
    const finalStatuses = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    expect(finalStatuses.every((row) => row.status === "curated")).toBe(true);
    // CTP-621: identity-first selection guarantees every ranked identity's
    // true pointer head is loaded, so no current-run row can be attempted
    // ahead of its historical chain. Before the fix this pass curated 84
    // heads and parked 16 current-run rows `blocked_ordering`.
    expect({ firstCurrentCount, firstHistoricalHeadCount }).toEqual({
      firstCurrentCount: 0,
      firstHistoricalHeadCount: 100,
    });
  }, 120_000);

  it("supersedes unchanged observations dominated by a later same-content sibling", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const firstRunId = await seedRun(database, 0);
    const secondRunId = await seedRun(database, 10);
    const latestRunId = await seedRun(database, 20);
    const bronReferentie = `rjc-621-dominated-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      firstRunId
    );
    // Domination only applies to provable no-op refreshes: the canonical
    // record must already be active on the same content hash.
    await seedCommitted({
      bronReferentie,
      contentHash: "dup-hash",
      database,
      minute: 0,
      scrapeRunId: firstRunId,
      title: "Dominated duplicate",
    });

    const firstDominatedId = await seedObservation({
      bronReferentie,
      contentHash: "dup-hash",
      database,
      minute: 1,
      outcome: "unchanged",
      scrapeRunId: firstRunId,
      sourceRecordId,
      title: "Dominated duplicate",
    });
    const secondDominatedId = await seedObservation({
      bronReferentie,
      contentHash: "dup-hash",
      database,
      minute: 11,
      outcome: "unchanged",
      scrapeRunId: secondRunId,
      sourceRecordId,
      title: "Dominated duplicate",
    });
    const survivingId = await seedObservation({
      bronReferentie,
      contentHash: "dup-hash",
      database,
      minute: 21,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: latestRunId,
      sourceRecordId,
      title: "Dominated duplicate",
    });

    const first = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: latestRunId,
    });
    expect(first).toMatchObject({
      remaining: 0,
      superseded: 2,
      unchanged: 1,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    const statusById = new Map(
      statuses.map((row) => [row.id, row.status] as const)
    );
    expect(statusById.get(firstDominatedId)).toBe("superseded");
    expect(statusById.get(secondDominatedId)).toBe("superseded");
    expect(statusById.get(survivingId)).toBe("unchanged");

    // The sweep is idempotent: a second pass finds nothing left to dominate
    // and does not reopen the terminally marked rows.
    const second = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: latestRunId,
    });
    expect(second).toMatchObject({ remaining: 0, superseded: 0 });
  });

  it("keeps an unchanged head when its only later siblings are revivable", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const firstRunId = await seedRun(database, 0);
    const secondRunId = await seedRun(database, 10);
    const thirdRunId = await seedRun(database, 20);
    const fourthRunId = await seedRun(database, 30);

    const failedRef = `rjc-621-failed-sibling-${crypto.randomUUID()}`;
    const failedSourceId = await seedSourceRecord(
      database,
      failedRef,
      firstRunId
    );
    await seedCommitted({
      bronReferentie: failedRef,
      contentHash: "failed-dup-hash",
      database,
      minute: 0,
      scrapeRunId: firstRunId,
      title: "Duplicate before failure",
    });
    const failedSurvivorId = await seedObservation({
      bronReferentie: failedRef,
      contentHash: "failed-dup-hash",
      database,
      minute: 1,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: firstRunId,
      sourceRecordId: failedSourceId,
      title: "Duplicate before failure",
    });
    const failedSiblingId = await seedObservation({
      bronReferentie: failedRef,
      contentHash: "failed-dup-hash",
      database,
      minute: 11,
      outcome: "unchanged",
      scrapeRunId: secondRunId,
      sourceRecordId: failedSourceId,
      status: "curation_failed",
      title: "Duplicate before failure",
    });

    const missingRawRef = `rjc-621-missing-raw-sibling-${crypto.randomUUID()}`;
    const missingRawSourceId = await seedSourceRecord(
      database,
      missingRawRef,
      thirdRunId
    );
    await seedCommitted({
      bronReferentie: missingRawRef,
      contentHash: "missing-raw-dup-hash",
      database,
      minute: 20,
      scrapeRunId: thirdRunId,
      title: "Duplicate before missing raw",
    });
    const missingRawSurvivorId = await seedObservation({
      bronReferentie: missingRawRef,
      contentHash: "missing-raw-dup-hash",
      database,
      minute: 21,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: thirdRunId,
      sourceRecordId: missingRawSourceId,
      title: "Duplicate before missing raw",
    });
    const missingRawSiblingId = await seedObservation({
      bronReferentie: missingRawRef,
      contentHash: "missing-raw-dup-hash",
      database,
      minute: 31,
      outcome: "unchanged",
      scrapeRunId: fourthRunId,
      sourceRecordId: missingRawSourceId,
      status: "deferred_missing_raw",
      title: "Duplicate before missing raw",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: fourthRunId,
    });
    // An operator can revive a failed or missing-raw sibling, and then the
    // earlier row is the fallback that still refreshes the identity, so
    // neither head is dominated. The deferred sibling stays recoverable
    // backlog until that requeue.
    expect(result).toMatchObject({
      pending: 1,
      remaining: 1,
      superseded: 0,
      unchanged: 2,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    const statusById = new Map(
      statuses.map((row) => [row.id, row.status] as const)
    );
    expect(statusById.get(failedSurvivorId)).toBe("unchanged");
    expect(statusById.get(failedSiblingId)).toBe("curation_failed");
    expect(statusById.get(missingRawSurvivorId)).toBe("unchanged");
    expect(statusById.get(missingRawSiblingId)).toBe("deferred_missing_raw");
  });

  it("does not supersede an unchanged observation whose later sibling carries different content", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const firstRunId = await seedRun(database, 0);
    const secondRunId = await seedRun(database, 10);
    const bronReferentie = `rjc-621-different-hash-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      firstRunId
    );
    await seedCommitted({
      bronReferentie,
      contentHash: "older-hash",
      database,
      minute: 0,
      scrapeRunId: firstRunId,
      title: "Older content",
    });
    const unchangedId = await seedObservation({
      bronReferentie,
      contentHash: "older-hash",
      database,
      minute: 1,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: firstRunId,
      sourceRecordId,
      title: "Older content",
    });
    const changedId = await seedObservation({
      bronReferentie,
      contentHash: "newer-hash",
      database,
      minute: 11,
      objectStore,
      scrapeRunId: secondRunId,
      sourceRecordId,
      title: "Newer content",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: secondRunId,
    });
    expect(result).toMatchObject({
      curated: 1,
      remaining: 0,
      superseded: 0,
      unchanged: 1,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.bronId, BRON_ID));
    const statusById = new Map(
      statuses.map((row) => [row.id, row.status] as const)
    );
    expect(statusById.get(unchangedId)).toBe("unchanged");
    expect(statusById.get(changedId)).toBe("curated");
  });

  it("drains a dominated-heavy backlog while real changes still curate", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const identityCount = 10;
    const runIds: ScrapeRunId[] = [];
    for (let run = 0; run < 4; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- run starts define pointer order
      runIds.push(await seedRun(database, run * 10));
    }
    const firstRunId = runIds.at(0);
    const latestRunId = runIds.at(-1);
    if (!(firstRunId && latestRunId)) {
      throw new Error("Expected fixture runs");
    }
    for (let identity = 0; identity < identityCount; identity += 1) {
      const bronReferentie = `rjc-621-treadmill-${identity}-${crypto.randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      const sourceRecordId = await seedSourceRecord(
        database,
        bronReferentie,
        firstRunId
      );
      // The canonical record is already active on the duplicate hash, so the
      // re-observations are provable no-op refreshes.
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      await seedCommitted({
        bronReferentie,
        contentHash: `treadmill-dup-${identity}`,
        database,
        minute: identity * 4,
        scrapeRunId: firstRunId,
        title: `Treadmill duplicate ${identity}`,
      });
      for (let duplicate = 0; duplicate < 3; duplicate += 1) {
        const runId = runIds[duplicate];
        if (!runId) {
          throw new Error("Expected a run per duplicate");
        }
        // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
        await seedObservation({
          bronReferentie,
          contentHash: `treadmill-dup-${identity}`,
          database,
          minute: identity * 4 + duplicate,
          // The newest duplicate still processes, so it needs raw; the two
          // dominated rows are superseded without a read.
          objectStore: duplicate === 2 ? objectStore : undefined,
          outcome: "unchanged",
          scrapeRunId: runId,
          sourceRecordId,
          title: `Treadmill duplicate ${identity}`,
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      await seedObservation({
        bronReferentie,
        contentHash: `treadmill-new-${identity}`,
        database,
        minute: identity * 4 + 3,
        objectStore,
        scrapeRunId: latestRunId,
        sourceRecordId,
        title: `Treadmill change ${identity}`,
      });
    }

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: latestRunId,
    });
    // Suppressed duplicates are invisible to ordering checks: the dominator
    // applies, the changed rows follow, and the post-pass sweep marks the
    // dups once their dominator proved the refresh redundant.
    expect(result).toMatchObject({
      blockedOrdering: 0,
      curated: 10,
      remaining: 0,
      superseded: 20,
      unchanged: 10,
    });
  });

  it("does not supersede an unchanged row that still writes a lifecycle transition", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const committedRunId = await seedRun(database, 0);
    const lifecycleRunId = await seedRun(database, 60);
    const firstDupRunId = await seedRun(database, 70);
    const secondDupRunId = await seedRun(database, 80);
    const thirdDupRunId = await seedRun(database, 90);
    const bronReferentie = `rjc-621-lifecycle-dup-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      committedRunId
    );
    const aanvraagId = await seedCommitted({
      bronReferentie,
      contentHash: "flip-hash",
      database,
      minute: 0,
      scrapeRunId: committedRunId,
      title: "Lifecycle duplicate",
    });
    await seedLifecycleVersion({
      aanvraagId,
      database,
      minute: 60,
      scrapeRunId: lifecycleRunId,
      status: "stale",
    });
    const duplicateIds: string[] = [];
    for (const [index, runId] of [
      firstDupRunId,
      secondDupRunId,
      thirdDupRunId,
    ].entries()) {
      duplicateIds.push(
        // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
        await seedObservation({
          bronReferentie,
          contentHash: "flip-hash",
          database,
          minute: 70 + index * 10,
          objectStore,
          outcome: "unchanged",
          scrapeRunId: runId,
          sourceRecordId,
          title: "Lifecycle duplicate",
        })
      );
    }

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: thirdDupRunId,
    });
    // While the canonical record is stale, the earliest duplicate is the row
    // that reactivates it: superseding it would move that transition to a
    // later pointer and lose the interval, so nothing is dominated.
    expect(result).toMatchObject({
      remaining: 0,
      superseded: 0,
      unchanged: 3,
    });

    const history = await readHistory(database, aanvraagId);
    expect(history.current).toMatchObject({ status: "active", versie: 3 });
    expect(history.versions).toHaveLength(3);
    const reactivation = history.versions.at(-1);
    expect(reactivation?.geldigVan).toEqual(atMinute(70));
    expectMonotoneHistory(history.versions);
    const duplicateStatuses = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(inArray(aanvraagObservation.id, duplicateIds));
    for (const row of duplicateStatuses) {
      expect(row.status).toBe("unchanged");
    }
  });

  it("loads an identity's pointer head even when it was inserted last", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const headRunId = await seedRun(database, 0);
    const successorRunId = await seedRun(database, 10);
    const bronReferentie = `rjc-621-backfilled-head-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      headRunId
    );
    // The pointer head carries the earliest run start but was persisted
    // after every successor, so a created_at-bounded slice would cut it.
    const headId = await seedObservation({
      bronReferentie,
      contentHash: "backfilled-head",
      database,
      minute: 0,
      objectStore,
      scrapeRunId: headRunId,
      sourceRecordId,
      title: "Backfilled head",
    });
    await database
      .update(aanvraagObservation)
      .set({ createdAt: atMinute(100) })
      .where(eq(aanvraagObservation.id, headId));
    for (let successor = 0; successor < 10; successor += 1) {
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      await seedObservation({
        bronReferentie,
        contentHash: `backfilled-successor-${successor}`,
        database,
        minute: successor,
        objectStore,
        scrapeRunId: successorRunId,
        sourceRecordId,
        title: `Backfilled successor ${successor}`,
      });
    }

    const first = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: successorRunId,
    });
    expect(first).toMatchObject({
      blockedOrdering: 0,
      curated: 10,
      remaining: 1,
    });
    const [head] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, headId));
    expect(head?.status).toBe("curated");

    const second = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: successorRunId,
    });
    expect(second).toMatchObject({ curated: 1, remaining: 0 });
  });

  it("bounds current-run identity inclusion by the attempt budget", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const backlogRunId = await seedRun(database, 0);
    const currentRunId = await seedRun(database, 100);
    const backlogSourceRecordIds: string[] = [];
    for (let identity = 0; identity < 5; identity += 1) {
      const bronReferentie = `rjc-621-cap-backlog-${identity}-${crypto.randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      const sourceRecordId = await seedSourceRecord(
        database,
        bronReferentie,
        backlogRunId
      );
      backlogSourceRecordIds.push(sourceRecordId);
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      await seedObservation({
        bronReferentie,
        contentHash: `cap-backlog-${identity}`,
        database,
        minute: identity,
        objectStore,
        scrapeRunId: backlogRunId,
        sourceRecordId,
        title: `Cap backlog ${identity}`,
      });
    }
    const currentSourceRecordIds = new Set<string>();
    for (let identity = 0; identity < 30; identity += 1) {
      const bronReferentie = `rjc-621-cap-current-${identity}-${crypto.randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      const sourceRecordId = await seedSourceRecord(
        database,
        bronReferentie,
        currentRunId
      );
      currentSourceRecordIds.add(sourceRecordId);
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      await seedObservation({
        bronReferentie,
        contentHash: `cap-current-${identity}`,
        database,
        minute: 100 + identity,
        objectStore,
        scrapeRunId: currentRunId,
        sourceRecordId,
        title: `Cap current ${identity}`,
      });
    }

    const attemptLimit = 10;
    const selected = await candidateSourceRecordIds(
      {
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        database,
        objectStore,
        scrapeRunId: currentRunId,
      },
      attemptLimit
    );
    // Ranked backlog takes up to attemptLimit identities and the current run
    // adds up to attemptLimit more; an unbounded union would have returned
    // all 35 and fanned out one chain query per identity.
    expect(selected).toHaveLength(15);
    for (const sourceRecordId of backlogSourceRecordIds) {
      expect(selected).toContain(sourceRecordId);
    }
    expect(
      selected.filter((id) => currentSourceRecordIds.has(id))
    ).toHaveLength(attemptLimit);
  });

  it("classifies a malformed observation timestamp without aborting selection", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0);
    const malformedRef = `rjc-621-bad-ts-${crypto.randomUUID()}`;
    const malformedSourceId = await seedSourceRecord(
      database,
      malformedRef,
      runId
    );
    // Prefix-shaped but invalid: a timestamptz cast aborts the whole
    // candidate query on this value, while text ordering leaves the row
    // loadable so the schema check can park it.
    const malformedId = await seedObservation({
      bronReferentie: malformedRef,
      contentHash: "bad-ts-hash",
      database,
      minute: 0,
      objectStore,
      payloadOverrides: { observedAt: "2026-99-99T00:00:00Z" },
      scrapeRunId: runId,
      sourceRecordId: malformedSourceId,
      title: "Malformed timestamp",
    });
    const validRef = `rjc-621-good-ts-${crypto.randomUUID()}`;
    const validSourceId = await seedSourceRecord(database, validRef, runId);
    const validId = await seedObservation({
      bronReferentie: validRef,
      contentHash: "good-ts-hash",
      database,
      minute: 1,
      objectStore,
      scrapeRunId: runId,
      sourceRecordId: validSourceId,
      title: "Valid timestamp",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: runId,
    });
    expect(result).toMatchObject({
      blockedOrdering: 1,
      curated: 1,
      remaining: 1,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(inArray(aanvraagObservation.id, [malformedId, validId]));
    const statusById = new Map(
      statuses.map((row) => [row.id, row.status] as const)
    );
    expect(statusById.get(malformedId)).toBe("blocked_ordering");
    expect(statusById.get(validId)).toBe("curated");
  });

  it("does not supersede an unchanged row behind a dominator with a malformed payload", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const firstRunId = await seedRun(database, 0);
    const secondRunId = await seedRun(database, 10);
    const bronReferentie = `rjc-621-bad-dominator-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      firstRunId
    );
    await seedCommitted({
      bronReferentie,
      contentHash: "bad-dominator-hash",
      database,
      minute: 0,
      scrapeRunId: firstRunId,
      title: "Dominator malformed",
    });
    const dominatedId = await seedObservation({
      bronReferentie,
      contentHash: "bad-dominator-hash",
      database,
      minute: 1,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: firstRunId,
      sourceRecordId,
      title: "Dominator malformed",
    });
    // The dominator carries the right contractVersion but an unusable
    // observedAt, so it could never process; a contractVersion-only check
    // would still have superseded the earlier row behind it.
    const dominatorId = await seedObservation({
      bronReferentie,
      contentHash: "bad-dominator-hash",
      database,
      minute: 11,
      outcome: "unchanged",
      payloadOverrides: { observedAt: "2026-99-99T00:00:00Z" },
      scrapeRunId: secondRunId,
      sourceRecordId,
      title: "Dominator malformed",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: secondRunId,
    });
    expect(result).toMatchObject({
      blockedOrdering: 1,
      remaining: 1,
      superseded: 0,
      unchanged: 1,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(inArray(aanvraagObservation.id, [dominatedId, dominatorId]));
    const statusById = new Map(
      statuses.map((row) => [row.id, row.status] as const)
    );
    expect(statusById.get(dominatedId)).toBe("unchanged");
    expect(statusById.get(dominatorId)).toBe("blocked_ordering");
  });

  it("does not supersede an unchanged row behind a dominator whose raw is missing", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const firstRunId = await seedRun(database, 0);
    const secondRunId = await seedRun(database, 10);
    const bronReferentie = `rjc-621-rawless-dominator-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      firstRunId
    );
    await seedCommitted({
      bronReferentie,
      contentHash: "rawless-dominator-hash",
      database,
      minute: 0,
      scrapeRunId: firstRunId,
      title: "Rawless dominator",
    });
    const dominatedId = await seedObservation({
      bronReferentie,
      contentHash: "rawless-dominator-hash",
      database,
      minute: 1,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: firstRunId,
      sourceRecordId,
      title: "Rawless dominator",
    });
    // The dominator is metadata-valid and still awaiting, but its raw object
    // was never captured under a distinct (non-content-addressed) ref:
    // superseding the earlier row behind it would lose the refresh when the
    // dominator defers to deferred_missing_raw.
    const dominatorId = await seedObservation({
      bronReferentie,
      contentHash: "rawless-dominator-hash",
      database,
      minute: 11,
      outcome: "unchanged",
      rawPayloadRef: `raw/opdrachtoverheid/rjc-621/never-captured-${crypto.randomUUID()}.json`,
      scrapeRunId: secondRunId,
      sourceRecordId,
      title: "Rawless dominator",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: secondRunId,
    });
    expect(result).toMatchObject({
      pending: 1,
      remaining: 1,
      superseded: 0,
      unchanged: 1,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(inArray(aanvraagObservation.id, [dominatedId, dominatorId]));
    const statusById = new Map(
      statuses.map((row) => [row.id, row.status] as const)
    );
    expect(statusById.get(dominatedId)).toBe("unchanged");
    expect(statusById.get(dominatorId)).toBe("deferred_missing_raw");
  });

  it("re-queues a suppressed row when its dominator fails during processing", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const firstRunId = await seedRun(database, 0);
    const secondRunId = await seedRun(database, 10);
    const bronReferentie = `rjc-621-failing-dominator-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      firstRunId
    );
    await seedCommitted({
      bronReferentie,
      contentHash: "failing-dominator-hash",
      database,
      minute: 0,
      scrapeRunId: firstRunId,
      title: "Failing dominator",
    });
    const dominatedId = await seedObservation({
      bronReferentie,
      contentHash: "failing-dominator-hash",
      database,
      minute: 1,
      objectStore,
      outcome: "unchanged",
      rawPayloadRef: `raw/opdrachtoverheid/rjc-621/dominated-${crypto.randomUUID()}.json`,
      scrapeRunId: firstRunId,
      sourceRecordId,
      title: "Failing dominator",
    });
    // The dominator reads a raw object, so it suppresses the earlier row
    // this pass, but its body cannot be normalised: superseding eagerly
    // would strand the earlier refresh behind a dominator that parks.
    const dominatorRef = `raw/opdrachtoverheid/rjc-621/failing-${crypto.randomUUID()}.json`;
    await objectStore.put({
      body: new TextEncoder().encode("{not-json"),
      contentType: "json",
      expiresAt: atMinute(10_000),
      path: dominatorRef,
    });
    const dominatorId = await seedObservation({
      bronReferentie,
      contentHash: "failing-dominator-hash",
      database,
      minute: 11,
      outcome: "unchanged",
      rawPayloadRef: dominatorRef,
      scrapeRunId: secondRunId,
      sourceRecordId,
      title: "Failing dominator",
    });

    const input = {
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: secondRunId,
    };
    const first = await curateScrapeRun(input);
    expect(first).toMatchObject({
      failed: 1,
      remaining: 1,
      superseded: 0,
      unchanged: 0,
    });

    const statuses = await database
      .select({
        id: aanvraagObservation.id,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(inArray(aanvraagObservation.id, [dominatedId, dominatorId]));
    const statusById = new Map(
      statuses.map((row) => [row.id, row.status] as const)
    );
    expect(statusById.get(dominatedId)).toBe("awaiting_curation");
    expect(statusById.get(dominatorId)).toBe("curation_failed");

    const second = await curateScrapeRun(input);
    expect(second).toMatchObject({
      remaining: 0,
      superseded: 0,
      unchanged: 1,
    });
    const [dominated] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, dominatedId));
    expect(dominated?.status).toBe("unchanged");
  });

  it("does not deadlock a different-content sibling between a suppressed row and its dominator", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const committedRunId = await seedRun(database, 0);
    const dupRunId = await seedRun(database, 10);
    const changeRunId = await seedRun(database, 20);
    const dominatorRunId = await seedRun(database, 30);
    const bronReferentie = `rjc-621-order-cycle-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      committedRunId
    );
    await seedCommitted({
      bronReferentie,
      contentHash: "cycle-hash",
      database,
      minute: 0,
      scrapeRunId: committedRunId,
      title: "Cycle dominator",
    });
    // A suppressed duplicate, a real change on a different hash, then the
    // dominator: if the suppressed row blocked every candidate but its
    // dominator, B would wait on A while C waited on B and nothing applied.
    const suppressedId = await seedObservation({
      bronReferentie,
      contentHash: "cycle-hash",
      database,
      minute: 11,
      outcome: "unchanged",
      scrapeRunId: dupRunId,
      sourceRecordId,
      title: "Cycle dominator",
    });
    await seedObservation({
      bronReferentie,
      contentHash: "cycle-changed-hash",
      database,
      minute: 21,
      objectStore,
      scrapeRunId: changeRunId,
      sourceRecordId,
      title: "Cycle changed",
    });
    await seedObservation({
      bronReferentie,
      contentHash: "cycle-hash",
      database,
      minute: 31,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: dominatorRunId,
      sourceRecordId,
      title: "Cycle dominator",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: dominatorRunId,
    });
    expect(result).toMatchObject({
      blockedOrdering: 0,
      curated: 2,
      remaining: 0,
      superseded: 1,
    });
    const [suppressed] = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, suppressedId));
    expect(suppressed?.status).toBe("superseded");
  });

  it("does not let suppressed rows crowd a dominator out of the per-identity slice", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const committedRunId = await seedRun(database, 0);
    const bronReferentie = `rjc-621-slice-starve-${crypto.randomUUID()}`;
    const sourceRecordId = await seedSourceRecord(
      database,
      bronReferentie,
      committedRunId
    );
    await seedCommitted({
      bronReferentie,
      contentHash: "slice-hash",
      database,
      minute: 0,
      scrapeRunId: committedRunId,
      title: "Slice dominator",
    });
    // Exactly SCAN_MULTIPLIER suppressed duplicates precede the dominator:
    // if suppression filtered after the bounded per-identity slice instead
    // of in SQL, the slice would hold only suppressed rows, the dominator
    // would never load, and the same slice would repeat every pass.
    const suppressedIds: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
      const runId = await seedRun(database, index * 10);
      suppressedIds.push(
        // oxlint-disable-next-line no-await-in-loop -- deterministic fixture order
        await seedObservation({
          bronReferentie,
          contentHash: "slice-hash",
          database,
          minute: index * 10 + 1,
          outcome: "unchanged",
          scrapeRunId: runId,
          sourceRecordId,
          title: "Slice dominator",
        })
      );
    }
    const dominatorRunId = await seedRun(database, 110);
    await seedObservation({
      bronReferentie,
      contentHash: "slice-hash",
      database,
      minute: 111,
      objectStore,
      outcome: "unchanged",
      scrapeRunId: dominatorRunId,
      sourceRecordId,
      title: "Slice dominator",
    });

    const result = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: dominatorRunId,
    });
    expect(result).toMatchObject({
      remaining: 0,
      superseded: 10,
      unchanged: 1,
    });
    const statuses = await database
      .select({ status: aanvraagObservation.status })
      .from(aanvraagObservation)
      .where(inArray(aanvraagObservation.id, suppressedIds));
    expect(statuses.every((row) => row.status === "superseded")).toBe(true);
  });
});
