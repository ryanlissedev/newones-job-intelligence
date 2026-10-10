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

import {
  CONNECTOR_OBSERVATION_CONTRACT_VERSION,
  InMemoryObjectStore,
} from "@ji/connectors";
import type { ObjectStore } from "@ji/connectors";
import { curateScrapeRun } from "@ji/db/curate-scrape-run";
import * as schema from "@ji/db/schema/index";
import {
  aanvraag,
  aanvraagObservation,
  bron,
  outboxEvent,
  scrapeRun,
  sourceRecord,
} from "@ji/db/schema/index";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { runApply, runReport } from "./recover-failed-run-observations";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(
  import.meta.dir,
  "../../packages/db/src/migrations"
);
// Opdrachtoverheid, the same registered source the curation recovery specs use.
const BRON_ID: BronId = "00000000-0000-4000-8000-0000000000ad";
const BRON_SLUG = "opdrachtoverheid" as const;
const BASE_TIME = Date.parse("2026-09-20T08:00:00.000Z");

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;
type RunStatus = "cancelled" | "failed" | "succeeded";

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
        opdracht_overheid_url: `https://www.opdrachtoverheid.nl/inhuuropdracht/test/ctp-625/${bronReferentie}`,
        tender_buying_organization: "Synthetic Recovery Organisation",
        tender_id: bronReferentie,
        tender_name: title,
        web_key: bronReferentie,
      },
    })
  );

const rawRef = (bronReferentie: string, contentHash: string): string =>
  `raw/opdrachtoverheid/ctp-625/${bronReferentie}/${contentHash}.json`;

const FAILURE_ENVELOPES = {
  DISCOVER_FAILED: {
    failureClass: "connector",
    failureCode: "DISCOVER_FAILED",
    failureMessage: "Connector discovery failed",
    failurePhase: "discover",
  },
  FETCH_FAILED: {
    failureClass: "connector",
    failureCode: "FETCH_FAILED",
    failureMessage: "Connector fetch failed",
    failurePhase: "fetch",
  },
} as const;

const seedRun = async (
  database: TestDatabase,
  minute: number,
  status: RunStatus,
  failure?: { code: keyof typeof FAILURE_ENVELOPES; fouten: number }
): Promise<ScrapeRunId> => {
  const id: ScrapeRunId = crypto.randomUUID();
  const envelope =
    status === "failed" && failure ? FAILURE_ENVELOPES[failure.code] : {};
  await database.insert(scrapeRun).values({
    bronId: BRON_ID,
    fouten: failure?.fouten ?? 0,
    geindigd: atMinute(minute + 1),
    gestart: atMinute(minute),
    id,
    runKind: "poll",
    status,
    ...envelope,
  });
  return id;
};

const seedObservation = async (input: {
  database: TestDatabase;
  minute: number;
  objectStore: InMemoryObjectStore;
  scrapeRunId: ScrapeRunId;
  title: string;
}): Promise<{ bronReferentie: string; observationId: string }> => {
  const bronReferentie = `ctp-625-${crypto.randomUUID()}`;
  const contentHash = `hash-${bronReferentie}`;
  const objectRef = rawRef(bronReferentie, contentHash);
  const sourceRecordId = crypto.randomUUID();
  await input.database.insert(sourceRecord).values({
    bronId: BRON_ID,
    bronReferentie,
    contentHash,
    id: sourceRecordId,
    rawPayloadRef: objectRef,
    scrapeRunId: input.scrapeRunId,
  });
  await input.objectStore.put({
    body: payloadBody(bronReferentie, input.title),
    contentType: "json",
    expiresAt: atMinute(10_000),
    path: objectRef,
  });
  const observationId = crypto.randomUUID();
  await input.database.insert(aanvraagObservation).values({
    bronId: BRON_ID,
    contentHash,
    createdAt: atMinute(input.minute),
    id: observationId,
    outcome: "new",
    payload: {
      bronId: BRON_ID,
      bronReferentie,
      contentHash,
      contentType: "json",
      contractVersion: CONNECTOR_OBSERVATION_CONTRACT_VERSION,
      observedAt: atMinute(input.minute).toISOString(),
      rawPayloadRef: objectRef,
      scrapeRunId: input.scrapeRunId,
      sourceRecordId,
    },
    scrapeRunId: input.scrapeRunId,
    sourceRecordId,
    status: "awaiting_curation",
  });
  return { bronReferentie, observationId };
};

const observationStatus = async (
  database: TestDatabase,
  observationId: string
): Promise<string | undefined> => {
  const [row] = await database
    .select({ status: aanvraagObservation.status })
    .from(aanvraagObservation)
    .where(eq(aanvraagObservation.id, observationId));
  return row?.status;
};

const aanvraagCount = async (
  database: TestDatabase,
  bronReferentie: string
): Promise<number> => {
  const rows = await database
    .select({ id: aanvraag.id })
    .from(aanvraag)
    .where(eq(aanvraag.bronReferentie, bronReferentie));
  return rows.length;
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

describe("recover-failed-run-observations (CTP-625)", () => {
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
      naam: "Opdrachtoverheid failed-run recovery",
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

  it("recovers a failed run's observation once, and a rerun converges", async () => {
    if (!(available && database && client)) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0, "failed", {
      code: "DISCOVER_FAILED",
      fouten: 0,
    });
    const { bronReferentie, observationId } = await seedObservation({
      database,
      minute: 1,
      objectStore,
      scrapeRunId: runId,
      title: "Recorded before discovery died",
    });
    const dependencies = { objectStore, sql: client };
    const arguments_ = { apply: false, limit: 100, scrapeRunId: runId };

    const untouched = await curateScrapeRun({
      bronId: BRON_ID,
      bronSlug: BRON_SLUG,
      database,
      objectStore,
      scrapeRunId: runId,
    });
    expect(untouched).toMatchObject({ curated: 0, remaining: 0 });
    expect(await observationStatus(database, observationId)).toBe(
      "awaiting_curation"
    );

    const report = await runReport(arguments_, dependencies);
    expect(report).toMatchObject({
      byStatus: { awaiting_curation: 1 },
      eligibility: { eligible: true, status: "failed" },
      missingRawInSample: 0,
      operation: "report",
      parseInvalid: 0,
      recoverable: 1,
      sampled: 1,
    });
    expect(await observationStatus(database, observationId)).toBe(
      "awaiting_curation"
    );
    expect(await aanvraagCount(database, bronReferentie)).toBe(0);

    const applied = await runApply(
      { ...arguments_, apply: true },
      dependencies
    );
    expect(applied.result).toMatchObject({
      curated: 1,
      failed: 0,
      remaining: 0,
    });
    expect(await aanvraagCount(database, bronReferentie)).toBe(1);

    const again = await runApply({ ...arguments_, apply: true }, dependencies);
    expect(again.result).toMatchObject({ curated: 0, failed: 0, remaining: 0 });
    expect(await aanvraagCount(database, bronReferentie)).toBe(1);

    const [run] = await database
      .select({ fouten: scrapeRun.fouten, status: scrapeRun.status })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, runId));
    expect(run).toEqual({ fouten: 0, status: "failed" });
  });

  it("recovers a cancelled run's observation", async () => {
    if (!(available && database && client)) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0, "cancelled");
    const { bronReferentie } = await seedObservation({
      database,
      minute: 1,
      objectStore,
      scrapeRunId: runId,
      title: "Recorded before the operator cancelled",
    });

    const applied = await runApply(
      { apply: true, limit: 100, scrapeRunId: runId },
      { objectStore, sql: client }
    );
    expect(applied.eligibility).toEqual({
      eligible: true,
      status: "cancelled",
    });
    expect(applied.result).toMatchObject({ curated: 1, remaining: 0 });
    expect(await aanvraagCount(database, bronReferentie)).toBe(1);
  });

  it("refuses a run that failed per record and leaves its rows alone", async () => {
    if (!(available && database && client)) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0, "failed", {
      code: "FETCH_FAILED",
      fouten: 1,
    });
    const { bronReferentie, observationId } = await seedObservation({
      database,
      minute: 1,
      objectStore,
      scrapeRunId: runId,
      title: "Sibling of a broken fetch",
    });

    const applied = await runApply(
      { apply: true, limit: 100, scrapeRunId: runId },
      { objectStore, sql: client }
    );
    expect(applied).toMatchObject({
      eligibility: { eligible: false, reason: "per_record_failure" },
      result: null,
    });
    expect(await observationStatus(database, observationId)).toBe(
      "awaiting_curation"
    );
    expect(await aanvraagCount(database, bronReferentie)).toBe(0);
  });

  it("scopes recovery to the named run", async () => {
    if (!(available && database && client)) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const targetRun = await seedRun(database, 0, "cancelled");
    const otherRun = await seedRun(database, 5, "cancelled");
    const target = await seedObservation({
      database,
      minute: 1,
      objectStore,
      scrapeRunId: targetRun,
      title: "In the named run",
    });
    const other = await seedObservation({
      database,
      minute: 6,
      objectStore,
      scrapeRunId: otherRun,
      title: "In a different cancelled run",
    });

    const applied = await runApply(
      { apply: true, limit: 100, scrapeRunId: targetRun },
      { objectStore, sql: client }
    );
    expect(applied.result).toMatchObject({ curated: 1, remaining: 0 });
    expect(await aanvraagCount(database, target.bronReferentie)).toBe(1);
    expect(await aanvraagCount(database, other.bronReferentie)).toBe(0);
    expect(await observationStatus(database, other.observationId)).toBe(
      "awaiting_curation"
    );
  });

  it("aborts without parking when the object store is unreachable", async () => {
    if (!(available && database && client)) {
      expect(available).toBe(false);
      return;
    }
    const objectStore = new InMemoryObjectStore();
    const runId = await seedRun(database, 0, "cancelled");
    const { observationId } = await seedObservation({
      database,
      minute: 1,
      objectStore,
      scrapeRunId: runId,
      title: "Raw behind an outage",
    });
    const unreachable: ObjectStore = {
      deleteExpired: (before: Date) => objectStore.deleteExpired(before),
      get: () => Promise.reject(new Error("object store unreachable")),
      put: (object) => objectStore.put(object),
    };

    await expect(
      runApply(
        { apply: true, limit: 100, scrapeRunId: runId },
        { objectStore: unreachable, sql: client }
      )
    ).rejects.toThrow("Raw object read failed for");
    expect(await observationStatus(database, observationId)).toBe(
      "awaiting_curation"
    );
  });
});
