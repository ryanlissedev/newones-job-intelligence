import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { executeBronRun } from "@ji/application/bronnen";
import type { CurateStore } from "@ji/application/identity";
import {
  AANVRAAG_STATUS_GEWIJZIGD_EVENT,
  reconcileMissedPolls,
} from "@ji/application/lifecycle";
import type { LifecycleReconcilePorts } from "@ji/application/lifecycle";
import { InMemoryObjectStore } from "@ji/connectors";
import type { Connector } from "@ji/connectors";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  PostgresBronPersistence,
  PostgresObservationRecorder,
  PostgresRunStore,
} from "./bron-runtime";
import { createPostgresLifecyclePorts } from "./missed-polls-store";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagVersie,
  bron,
  outboxEvent,
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
const STALE_AFTER = 3;
const STARTED_AT = new Date("2026-09-01T06:00:00.000Z");

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

const hexDigest = (seed: string): string =>
  [...seed]
    .map((character) => character.codePointAt(0)?.toString(16) ?? "0")
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

const listingConnector = (bronId: BronId, refs: string[]): Connector => ({
  bronId,
  discover: () =>
    Promise.resolve({
      checkpoint: {},
      hasMore: false,
      items: refs.map((ref) => ({ bronReferentie: ref, contentHash: "" })),
    }),
  fetch: (item) =>
    Promise.resolve({
      body: new TextEncoder().encode(item.bronReferentie),
      bronReferentie: item.bronReferentie,
      contentHash: hexDigest(item.bronReferentie),
      contentType: "html" as const,
      status: "fetched" as const,
    }),
});

const withFailingOutbox = (base: CurateStore): CurateStore => ({
  closeOpenVersie: (aanvraagId, closedAt) =>
    base.closeOpenVersie(aanvraagId, closedAt),
  ensureDedupGroep: (input) => base.ensureDedupGroep(input),
  findAanvraagByIdentity: (bronId, bronReferentie) =>
    base.findAanvraagByIdentity(bronId, bronReferentie),
  findDedupGroepByKey: (dedupKey) => base.findDedupGroepByKey(dedupKey),
  insertAanvraag: (input) => base.insertAanvraag(input),
  insertOutboxEvent: () =>
    Promise.reject(new Error("forced reopen outbox failure")),
  insertVersie: (input) => base.insertVersie(input),
  linkAanvraagToDedupGroep: (aanvraagId, dedupGroepId) =>
    base.linkAanvraagToDedupGroep(aanvraagId, dedupGroepId),
  splitDedupGroep: (dedupGroepId) => base.splitDedupGroep(dedupGroepId),
  updateAanvraag: (aanvraagId, patch) => base.updateAanvraag(aanvraagId, patch),
  withTransaction: (fn) =>
    base.withTransaction((transactionStore) =>
      fn(withFailingOutbox(transactionStore))
    ),
});

const withFailingLifecycleOutbox = (
  base: LifecycleReconcilePorts
): LifecycleReconcilePorts => ({
  ...base,
  withTransaction: (bronId, fn) =>
    base.withTransaction(bronId, (transactionPorts) =>
      fn({
        ...transactionPorts,
        curateStore: withFailingOutbox(transactionPorts.curateStore),
      })
    ),
});

describe("PostgresMissedPollsStore through executeBronRun", () => {
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

  it("closes a record that disappears from consecutive listings and reopens it when it returns", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const client = postgres(applicationUrl, { max: 1 });
    const database = drizzle(client, { schema });
    const bronId = crypto.randomUUID();
    const runIds: ScrapeRunId[] = Array.from(
      { length: 6 },
      () =>
        // SAFETY: ScrapeRunId is a nominal UUID string brand; randomUUID yields a valid value.
        crypto.randomUUID() as ScrapeRunId
    );
    const runIdAt = (index: number): ScrapeRunId => {
      const id = runIds[index];
      if (!id) {
        throw new Error(`No run id at index ${index}`);
      }
      return id;
    };
    const persistence = new PostgresBronPersistence(database);
    const observationRecorder = new PostgresObservationRecorder(database);
    const runLifecycleStore = new PostgresRunStore(database);
    const objectStore = new InMemoryObjectStore();
    const lifecycle = createPostgresLifecyclePorts(database, {
      missedPollsBeforeStale: STALE_AFTER,
    });
    const runListing = (
      runIndex: number,
      refs: string[],
      lifecyclePorts: LifecycleReconcilePorts = lifecycle
    ) =>
      executeBronRun(persistence, {
        bronId,
        bronSlug: "hero",
        connector: listingConnector(bronId, refs),
        lifecycle: lifecyclePorts,
        objectStore,
        observationRecorder,
        runLifecycleStore,
        scrapeRunId: runIdAt(runIndex),
        startedAt: new Date(STARTED_AT.getTime() + runIndex * 3_600_000),
        wait: () => Promise.resolve(),
        writeNow: () => new Date(STARTED_AT.getTime() + runIndex * 3_600_000),
      });
    const readSourceRecord = async (ref: string) => {
      const [row] = await database
        .select({
          lastMissedScrapeRunId: sourceRecord.lastMissedScrapeRunId,
          lastSeenAt: sourceRecord.lastSeenAt,
          lastSeenScrapeRunId: sourceRecord.lastSeenScrapeRunId,
          missedPolls: sourceRecord.missedPolls,
        })
        .from(sourceRecord)
        .where(
          and(
            eq(sourceRecord.bronId, bronId),
            eq(sourceRecord.bronReferentie, ref)
          )
        );
      return row;
    };

    try {
      await database.insert(bron).values({
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

      const first = await runListing(0, ["A", "B"]);
      expect(first.completeness).toEqual({ complete: true });
      expect(first.lifecycle).toMatchObject({ incremented: 0, reset: 2 });

      // The curate step (not under test here) is what creates the aanvraag
      // rows; seed the two it would have created from run 1.
      const created = await Promise.all(
        ["A", "B"].map((ref) =>
          lifecycle.curateStore.insertAanvraag({
            beschrijving: ref,
            bronId,
            bronReferentie: ref,
            bronSpecifiek: {},
            bronUrl: null,
            contactpersonen: [],
            contentHash: hexDigest(ref),
            contracttype: null,
            dedupGroepId: null,
            eersteGezienOp: STARTED_AT,
            eindDatum: null,
            extractieMethode: "html_parser",
            laatstGezienOp: STARTED_AT,
            locatieLand: "NL",
            locatieTekst: null,
            opdrachtgeverNaam: null,
            parserVersion: "spec",
            provenance: {
              beschrijving: { parserVersion: "spec", sourcePath: "n/a" },
              bron_referentie: { parserVersion: "spec", sourcePath: "n/a" },
              bron_specifiek: { parserVersion: "spec", sourcePath: "n/a" },
              bron_url: { parserVersion: "spec", sourcePath: "n/a" },
              locatie_land: { parserVersion: "spec", sourcePath: "n/a" },
              locatie_tekst: { parserVersion: "spec", sourcePath: "n/a" },
              opdrachtgever_naam: { parserVersion: "spec", sourcePath: "n/a" },
              start_datum: { parserVersion: "spec", sourcePath: "n/a" },
              tarief_eenheid: { parserVersion: "spec", sourcePath: "n/a" },
              tarief_max: { parserVersion: "spec", sourcePath: "n/a" },
              tarief_min: { parserVersion: "spec", sourcePath: "n/a" },
              titel: { parserVersion: "spec", sourcePath: "n/a" },
            },
            publicatiedatum: null,
            rawPayloadRef: `raw/hero/${ref}.html`,
            scrapeRunId: runIdAt(0),
            sluitingsdatum: null,
            startDatum: null,
            status: "active",
            tariefEenheid: null,
            tariefMax: null,
            tariefMin: null,
            tariefValuta: "EUR",
            titel: ref,
            urenPerWeek: null,
            versie: 1,
            werkvorm: null,
          })
        )
      );
      const bAanvraagId = created[1]?.aanvraagId;
      if (!bAanvraagId) {
        throw new Error("Expected aanvraag B to be created");
      }

      const second = await runListing(1, ["A"]);
      expect(second.lifecycle).toMatchObject({ incremented: 1, staled: [] });
      expect(await readSourceRecord("B")).toMatchObject({
        lastMissedScrapeRunId: runIds[1],
        lastSeenScrapeRunId: runIds[0],
        missedPolls: 1,
      });
      // Replay guard, straight against the store: same run id bumps nothing.
      const replay = await lifecycle.missedPolls.incrementMissed({
        bronId,
        exceptBronReferenties: ["A"],
        scrapeRunId: runIdAt(1),
        staleAtOrAbove: STALE_AFTER,
      });
      expect(replay).toEqual({ atThreshold: [], incremented: 0 });
      expect(await readSourceRecord("B")).toMatchObject({ missedPolls: 1 });
      expect(await readSourceRecord("A")).toMatchObject({
        lastSeenScrapeRunId: runIds[1],
        missedPolls: 0,
      });

      await runListing(2, ["A"]);
      const fourth = await runListing(3, ["A"]);
      expect(fourth.lifecycle?.staled).toEqual([bAanvraagId]);
      expect(await readSourceRecord("B")).toMatchObject({
        missedPolls: STALE_AFTER,
      });

      const [bRow] = await database
        .select({ status: aanvraag.status, versie: aanvraag.versie })
        .from(aanvraag)
        .where(eq(aanvraag.id, bAanvraagId));
      expect(bRow).toEqual({ status: "stale", versie: 2 });

      const versies = await database
        .select({
          geldigTot: aanvraagVersie.geldigTot,
          scrapeRunId: aanvraagVersie.scrapeRunId,
          snapshot: aanvraagVersie.snapshot,
          versie: aanvraagVersie.versie,
        })
        .from(aanvraagVersie)
        .where(eq(aanvraagVersie.aanvraagId, bAanvraagId))
        .orderBy(aanvraagVersie.versie);
      // The seed inserted no versie row, so the reconcile step's row is the only one.
      expect(versies).toEqual([
        {
          geldigTot: null,
          scrapeRunId: runIdAt(3),
          snapshot: expect.objectContaining({ status: "stale" }),
          versie: 2,
        },
      ]);

      const events = await database
        .select({
          eventType: outboxEvent.eventType,
          payload: outboxEvent.payload,
          processedAt: outboxEvent.processedAt,
        })
        .from(outboxEvent)
        .where(eq(outboxEvent.aggregateId, bAanvraagId))
        .orderBy(outboxEvent.sequenceNumber);
      expect(events).toEqual([
        {
          eventType: AANVRAAG_STATUS_GEWIJZIGD_EVENT,
          payload: {
            missed_polls: STALE_AFTER,
            reden: "listing_verdwenen",
            scrape_run_id: runIdAt(3),
            status: "stale",
          },
          processedAt: null,
        },
      ]);

      await expect(
        runListing(4, ["A", "B"], withFailingLifecycleOutbox(lifecycle))
      ).rejects.toThrow("forced reopen outbox failure");
      expect(await readSourceRecord("B")).toMatchObject({
        lastSeenAt: STARTED_AT,
        lastSeenScrapeRunId: runIds[0],
        missedPolls: STALE_AFTER,
      });
      const [afterFailedReopen] = await database
        .select({ status: aanvraag.status, versie: aanvraag.versie })
        .from(aanvraag)
        .where(eq(aanvraag.id, bAanvraagId));
      expect(afterFailedReopen).toEqual({ status: "stale", versie: 2 });
      const versionsAfterFailedReopen = await database
        .select({ versie: aanvraagVersie.versie })
        .from(aanvraagVersie)
        .where(eq(aanvraagVersie.aanvraagId, bAanvraagId));
      expect(versionsAfterFailedReopen).toEqual([{ versie: 2 }]);
      const eventsAfterFailedReopen = await database
        .select({ payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(eq(outboxEvent.aggregateId, bAanvraagId));
      expect(eventsAfterFailedReopen).toHaveLength(1);

      const recovered = await runListing(5, ["A", "B"]);
      expect(recovered.lifecycle?.reopened).toEqual([bAanvraagId]);
      expect(await readSourceRecord("B")).toMatchObject({
        lastSeenAt: new Date(STARTED_AT.getTime() + 5 * 3_600_000),
        lastSeenScrapeRunId: runIds[5],
        missedPolls: 0,
      });
      const [reopened] = await database
        .select({ status: aanvraag.status, versie: aanvraag.versie })
        .from(aanvraag)
        .where(eq(aanvraag.id, bAanvraagId));
      expect(reopened).toEqual({ status: "active", versie: 3 });
      const versionsAfterRecovery = await database
        .select({ versie: aanvraagVersie.versie })
        .from(aanvraagVersie)
        .where(eq(aanvraagVersie.aanvraagId, bAanvraagId))
        .orderBy(aanvraagVersie.versie);
      expect(versionsAfterRecovery).toEqual([{ versie: 2 }, { versie: 3 }]);
      const reopenEvents = await database
        .select({ payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(eq(outboxEvent.aggregateId, bAanvraagId))
        .orderBy(outboxEvent.sequenceNumber);
      expect(reopenEvents.at(-1)?.payload).toMatchObject({
        reden: "listing_teruggekeerd",
        scrape_run_id: runIdAt(5),
        status: "active",
      });
      expect(reopenEvents).toHaveLength(2);

      const recoveryReplay = await reconcileMissedPolls(lifecycle, {
        bronId,
        completeness: { complete: true },
        observedAt: new Date(STARTED_AT.getTime() + 5 * 3_600_000),
        observedBronReferenties: ["A", "B"],
        scrapeRunId: runIdAt(5),
      });
      expect(recoveryReplay.reopened).toEqual([]);
      const [afterReplay] = await database
        .select({ status: aanvraag.status, versie: aanvraag.versie })
        .from(aanvraag)
        .where(eq(aanvraag.id, bAanvraagId));
      expect(afterReplay).toEqual({ status: "active", versie: 3 });
      expect(
        await database
          .select({ versie: aanvraagVersie.versie })
          .from(aanvraagVersie)
          .where(eq(aanvraagVersie.aanvraagId, bAanvraagId))
      ).toHaveLength(2);
      expect(
        await database
          .select({ id: outboxEvent.id })
          .from(outboxEvent)
          .where(eq(outboxEvent.aggregateId, bAanvraagId))
      ).toHaveLength(2);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
