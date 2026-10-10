import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import type { CurateStore } from "@ji/application/identity";
import {
  AANVRAAG_GEWIJZIGD_EVENT,
  curateObservation,
} from "@ji/application/identity";
import {
  AANVRAAG_STATUS_GEWIJZIGD_EVENT,
  createInMemoryLifecyclePorts,
  InMemoryMissedPollsStore,
  reconcileMissedPolls,
} from "@ji/application/lifecycle";
import type { NormalisedAanvraagDraft } from "@ji/application/normalise";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { UNKNOWN } from "@ji/domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresCurateStore } from "./postgres-curate-store";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagVersie,
  bron,
  outboxEvent,
  scrapeRun,
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
const OBSERVED_AT = new Date("2026-09-01T06:00:00.000Z");
const THRESHOLD = 3;
const provenance = { parserVersion: "spec", sourcePath: "n/a" };

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

const draft = (
  bronReferentie: string,
  contentHash: string
): NormalisedAanvraagDraft => ({
  beschrijving: { provenance, value: `beschrijving ${bronReferentie}` },
  bronReferentie: { provenance, value: bronReferentie },
  bronSpecifiek: { provenance, value: {} },
  bronUrl: { provenance, value: UNKNOWN },
  contentHash,
  extractieMethode: "html_parser",
  lifecycle: "active",
  locatieLand: { provenance, value: "NL" },
  locatieTekst: { provenance, value: UNKNOWN },
  opdrachtgeverNaam: { provenance, value: UNKNOWN },
  parserVersion: "spec",
  startDatum: { provenance, value: UNKNOWN },
  status: "active",
  tarief: { eenheid: UNKNOWN, max: UNKNOWN, min: UNKNOWN, valuta: "EUR" },
  titel: { provenance, value: `titel ${bronReferentie}` },
});

/** Injects the failure through the port; the transactional store is wrapped the same way. */
const withFailingOutbox = (base: CurateStore): CurateStore => ({
  closeOpenVersie: (aanvraagId, closedAt) =>
    base.closeOpenVersie(aanvraagId, closedAt),
  ensureDedupGroep: (input) => base.ensureDedupGroep(input),
  findAanvraagByIdentity: (bronId, bronReferentie) =>
    base.findAanvraagByIdentity(bronId, bronReferentie),
  findDedupGroepByKey: (dedupKey) => base.findDedupGroepByKey(dedupKey),
  insertAanvraag: (input) => base.insertAanvraag(input),
  insertOutboxEvent: () =>
    Promise.reject(new Error("forced outbox insert failure")),
  insertVersie: (input) => base.insertVersie(input),
  linkAanvraagToDedupGroep: (aanvraagId, dedupGroepId) =>
    base.linkAanvraagToDedupGroep(aanvraagId, dedupGroepId),
  splitDedupGroep: (dedupGroepId) => base.splitDedupGroep(dedupGroepId),
  updateAanvraag: (aanvraagId, patch) => base.updateAanvraag(aanvraagId, patch),
  withTransaction: (fn) =>
    base.withTransaction((tx) => fn(withFailingOutbox(tx))),
});

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

const seedBronAndRuns = async (
  db: TestDatabase,
  runCount: number
): Promise<{ bronId: BronId; runIds: ScrapeRunId[] }> => {
  const bronId: BronId = crypto.randomUUID();
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
  const runIds: ScrapeRunId[] = [];
  for (let index = 0; index < runCount; index += 1) {
    const id: ScrapeRunId = crypto.randomUUID();
    // oxlint-disable-next-line no-await-in-loop -- fixture setup
    await db.insert(scrapeRun).values({ bronId, id });
    runIds.push(id);
  }
  return { bronId, runIds };
};

describe("PostgresCurateStore transaction boundary (RJC-399)", () => {
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
    client = postgres(applicationUrl, { max: 1 });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await migratorClient?.end({ timeout: 5 });
  });

  const observation = (
    bronId: BronId,
    scrapeRunId: ScrapeRunId,
    bronReferentie: string,
    contentHash: string
  ) => ({
    bronId,
    draft: draft(bronReferentie, contentHash),
    observedAt: OBSERVED_AT,
    rawPayloadRef: `raw/hero/${bronReferentie}.html`,
    scrapeRunId,
  });

  it("commits aanvraag, versie and outbox event atomically on success", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const { bronId, runIds } = await seedBronAndRuns(database, 2);
    const store = new PostgresCurateStore(database);

    const created = await curateObservation(
      store,
      observation(bronId, runIds[0] ?? "", "A", "hash-1")
    );
    expect(created.status).toBe("curated");
    const aanvraagId = created.aanvraagId ?? "";

    const updated = await curateObservation(
      store,
      observation(bronId, runIds[1] ?? "", "A", "hash-2")
    );
    expect(updated).toMatchObject({ status: "curated", versie: 2 });

    const versies = await database
      .select({
        geldigTot: aanvraagVersie.geldigTot,
        versie: aanvraagVersie.versie,
      })
      .from(aanvraagVersie)
      .where(eq(aanvraagVersie.aanvraagId, aanvraagId))
      .orderBy(aanvraagVersie.versie);
    expect(versies).toEqual([
      { geldigTot: OBSERVED_AT, versie: 1 },
      { geldigTot: null, versie: 2 },
    ]);
    const events = await database
      .select({ eventType: outboxEvent.eventType })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, aanvraagId))
      .orderBy(outboxEvent.sequenceNumber);
    expect(events.map((event) => event.eventType)).toEqual([
      "aanvraag.nieuw",
      "aanvraag.gewijzigd",
    ]);
  });

  it("rolls the whole mutation back when the outbox insert fails", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const { bronId, runIds } = await seedBronAndRuns(database, 2);
    const store = new PostgresCurateStore(database);

    // Create path: nothing at all may land.
    await expect(
      curateObservation(
        withFailingOutbox(store),
        observation(bronId, runIds[0] ?? "", "A", "hash-1")
      )
    ).rejects.toThrow("forced outbox insert failure");
    expect(
      await database.select().from(aanvraag).where(eq(aanvraag.bronId, bronId))
    ).toHaveLength(0);

    // Update path: the pre-failure versie close and status write roll back.
    const created = await curateObservation(
      store,
      observation(bronId, runIds[0] ?? "", "A", "hash-1")
    );
    const aanvraagId = created.aanvraagId ?? "";
    await expect(
      curateObservation(
        withFailingOutbox(store),
        observation(bronId, runIds[1] ?? "", "A", "hash-2")
      )
    ).rejects.toThrow("forced outbox insert failure");

    const [row] = await database
      .select({ contentHash: aanvraag.contentHash, versie: aanvraag.versie })
      .from(aanvraag)
      .where(eq(aanvraag.id, aanvraagId));
    expect(row).toEqual({ contentHash: "hash-1", versie: 1 });
    const versies = await database
      .select({ geldigTot: aanvraagVersie.geldigTot })
      .from(aanvraagVersie)
      .where(eq(aanvraagVersie.aanvraagId, aanvraagId));
    expect(versies).toEqual([{ geldigTot: null }]);
    const events = await database
      .select({ eventType: outboxEvent.eventType })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, aanvraagId));
    expect(events).toEqual([{ eventType: "aanvraag.nieuw" }]);
  });

  it("writes reconcile's status transition atomically and rolls it back on outbox failure", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const { bronId, runIds } = await seedBronAndRuns(database, 3);
    const store = new PostgresCurateStore(database);
    const created = await curateObservation(
      store,
      observation(bronId, runIds[0] ?? "", "B", "hash-1")
    );
    const aanvraagId = created.aanvraagId ?? "";

    const missedPolls = new InMemoryMissedPollsStore();
    missedPolls.ensure(bronId, "B");
    const primed = missedPolls.read(bronId, "B");
    if (primed) {
      primed.missedPolls = THRESHOLD - 1;
    }

    // Outbox failure first: the transition must leave no trace.
    await expect(
      reconcileMissedPolls(
        createInMemoryLifecyclePorts(withFailingOutbox(store), missedPolls, {
          missedPollsBeforeStale: THRESHOLD,
        }),
        {
          bronId,
          completeness: { complete: true },
          observedAt: OBSERVED_AT,
          observedBronReferenties: [],
          scrapeRunId: runIds[1] ?? "",
        }
      )
    ).rejects.toThrow("forced outbox insert failure");
    const [afterFailure] = await database
      .select({ status: aanvraag.status, versie: aanvraag.versie })
      .from(aanvraag)
      .where(eq(aanvraag.id, aanvraagId));
    expect(afterFailure).toEqual({ status: "active", versie: 1 });
    expect(
      await database
        .select({ id: aanvraagVersie.id })
        .from(aanvraagVersie)
        .where(eq(aanvraagVersie.aanvraagId, aanvraagId))
    ).toHaveLength(1);

    // The saturating counter gives one retry; the healthy store lands it whole.
    const retried = missedPolls.read(bronId, "B");
    if (retried) {
      retried.missedPolls = THRESHOLD - 1;
      retried.lastMissedScrapeRunId = null;
    }
    const result = await reconcileMissedPolls(
      createInMemoryLifecyclePorts(store, missedPolls, {
        missedPollsBeforeStale: THRESHOLD,
      }),
      {
        bronId,
        completeness: { complete: true },
        observedAt: OBSERVED_AT,
        observedBronReferenties: [],
        scrapeRunId: runIds[2] ?? "",
      }
    );
    expect(result.staled).toEqual([aanvraagId]);
    const [staled] = await database
      .select({ status: aanvraag.status, versie: aanvraag.versie })
      .from(aanvraag)
      .where(eq(aanvraag.id, aanvraagId));
    expect(staled).toEqual({ status: "stale", versie: 2 });
    const events = await database
      .select({ eventType: outboxEvent.eventType })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, aanvraagId))
      .orderBy(outboxEvent.sequenceNumber);
    expect(events.map((event) => event.eventType)).toEqual([
      "aanvraag.nieuw",
      AANVRAAG_STATUS_GEWIJZIGD_EVENT,
    ]);
  });

  /**
   * CTP-498: the unchanged-content path writes projected fields, so its outbox
   * event has to commit through real Postgres together with the row -- the
   * in-memory double cannot prove the transaction boundary.
   */
  it("commits the unchanged-content seen and status writes with their events", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const { bronId, runIds } = await seedBronAndRuns(database, 3);
    const store = new PostgresCurateStore(database);

    const created = await curateObservation(
      store,
      observation(bronId, runIds[0] ?? "", "A", "hash-stable")
    );
    const aanvraagId = created.aanvraagId ?? "";

    // Seen-only: later observedAt, same content, same status.
    const seenAt = new Date("2026-09-02T06:00:00.000Z");
    const seen = await curateObservation(store, {
      ...observation(bronId, runIds[1] ?? "", "A", "hash-stable"),
      observedAt: seenAt,
    });
    expect(seen).toMatchObject({ status: "unchanged" });
    expect(seen.outboxEventId).toBeTruthy();

    const [afterSeen] = await database
      .select({
        laatstGezienOp: aanvraag.laatstGezienOp,
        versie: aanvraag.versie,
      })
      .from(aanvraag)
      .where(eq(aanvraag.id, aanvraagId));
    expect(afterSeen).toEqual({ laatstGezienOp: seenAt, versie: 1 });
    expect(
      await database
        .select({ id: aanvraagVersie.id })
        .from(aanvraagVersie)
        .where(eq(aanvraagVersie.aanvraagId, aanvraagId))
    ).toHaveLength(1);

    // Status flip on unchanged content: new SCD2 version plus status event.
    const closedAt = new Date("2026-09-03T06:00:00.000Z");
    const base = observation(bronId, runIds[2] ?? "", "A", "hash-stable");
    const flipped = await curateObservation(store, {
      ...base,
      draft: { ...base.draft, status: "closed" },
      observedAt: closedAt,
    });
    expect(flipped).toMatchObject({ status: "unchanged", versie: 2 });

    const [afterFlip] = await database
      .select({ status: aanvraag.status, versie: aanvraag.versie })
      .from(aanvraag)
      .where(eq(aanvraag.id, aanvraagId));
    expect(afterFlip).toEqual({ status: "closed", versie: 2 });
    const versies = await database
      .select({
        geldigTot: aanvraagVersie.geldigTot,
        versie: aanvraagVersie.versie,
      })
      .from(aanvraagVersie)
      .where(eq(aanvraagVersie.aanvraagId, aanvraagId))
      .orderBy(aanvraagVersie.versie);
    expect(versies).toEqual([
      { geldigTot: closedAt, versie: 1 },
      { geldigTot: null, versie: 2 },
    ]);

    const events = await database
      .select({ eventType: outboxEvent.eventType })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, aanvraagId))
      .orderBy(outboxEvent.sequenceNumber);
    expect(events.map((event) => event.eventType)).toEqual([
      "aanvraag.nieuw",
      AANVRAAG_GEWIJZIGD_EVENT,
      AANVRAAG_STATUS_GEWIJZIGD_EVENT,
    ]);
  });
});
