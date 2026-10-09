import { afterAll, describe, expect, it } from "bun:test";

import { createBron } from "@ji/application/bronnen";
import type { RunBaselineSample } from "@ji/application/observability";
import { SOURCES } from "@ji/application/sources";
import { InMemoryObjectStore } from "@ji/connectors";
import type { ObjectStore, StoredObject } from "@ji/connectors";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";

import type { PollBronRuntime } from "./poll-bron-run";

const HERO_BRON_ID = "00000000-0000-4000-8000-000000000004";
const BACKLOG_RUN_ID = "00000000-0000-4000-8000-00000000b501";
const FLOOR_RUN_ID = "00000000-0000-4000-8000-00000000b502";
const FLOOR_FENCE_TOKEN = 41;
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousSearchProjector = process.env.SEARCH_PROJECTOR;

// @ji/db validates DATABASE_URL when its module is loaded. The test preload
// points DATABASE_APP_TEST_URL at the per-process disposable database.
process.env.DATABASE_URL = applicationUrl;
process.env.SEARCH_PROJECTOR = "onbox";

const { createBronRuntimeClient, PostgresCurateStore } = await import("@ji/db");
const { PostgresAlertStore, PostgresBronHealthStore } =
  await import("@ji/db/bron-health-stores");
const { PostgresPollerHealthTelemetryStore } =
  await import("@ji/db/poller-health-telemetry-store");
const {
  alert,
  aanvraag,
  bron,
  bronHealth,
  dedupGroep,
  outboxEvent,
  scrapeRun,
} = await import("@ji/db/schema/index");
const { aanvraagObservation } = await import("@ji/db/schema/staging");
const { DiscoveryFloorBreachedError, runBronIngestPipeline } =
  await import("./poll-bron-run");
const { curateScrapeRun } = await import("@ji/db/curate-scrape-run");
const { drainBacklog } = await import("./poller/drain-backlog");
const { createSlotLimit } = await import("./poller/slots");

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
};
const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

afterAll(() => {
  if (previousDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
  if (previousSearchProjector === undefined) {
    Reflect.deleteProperty(process.env, "SEARCH_PROJECTOR");
  } else {
    process.env.SEARCH_PROJECTOR = previousSearchProjector;
  }
});

class ReadGatedObjectStore implements ObjectStore {
  private readonly backing = new InMemoryObjectStore();

  private readsEnabled = false;

  deleteExpired(before: Date): Promise<number> {
    return this.backing.deleteExpired(before);
  }

  enableReads(): void {
    this.readsEnabled = true;
  }

  get(path: string): Promise<StoredObject | null> {
    if (!this.readsEnabled) {
      return Promise.reject(new Error("injected raw object read failure"));
    }
    return this.backing.get(path);
  }

  put(object: StoredObject): Promise<void> {
    return this.backing.put(object);
  }
}

type FloorDatabase = ReturnType<typeof createBronRuntimeClient>["database"];

const cleanHeroRows = async (database: FloorDatabase): Promise<void> => {
  const requests = await database
    .select({ dedupGroepId: aanvraag.dedupGroepId, id: aanvraag.id })
    .from(aanvraag)
    .where(eq(aanvraag.bronId, HERO_BRON_ID));
  const requestIds = requests.map((request) => request.id);
  if (requestIds.length > 0) {
    await database
      .delete(outboxEvent)
      .where(inArray(outboxEvent.aggregateId, requestIds));
    await database.delete(aanvraag).where(inArray(aanvraag.id, requestIds));
  }
  const dedupGroepIds = requests.flatMap((request) =>
    request.dedupGroepId ? [request.dedupGroepId] : []
  );
  if (dedupGroepIds.length > 0) {
    await database
      .delete(dedupGroep)
      .where(inArray(dedupGroep.id, dedupGroepIds));
  }
  // The seeded run ids are fixed, so a rerun has to clear them first.
  // bron_health.active_run_id references scrape_run, and alert references bron.
  await database.delete(bronHealth).where(eq(bronHealth.bronId, HERO_BRON_ID));
  await database.delete(alert).where(eq(alert.bronId, HERO_BRON_ID));
  await database.delete(scrapeRun).where(eq(scrapeRun.bronId, HERO_BRON_ID));
  await database.delete(bron).where(eq(bron.id, HERO_BRON_ID));
};

const seedHeroBron = async (runtime: PollBronRuntime): Promise<void> => {
  const source = SOURCES.hero;
  const created = createBron({
    bronId: source.bronId,
    categorie: "msp_broker",
    crawlDelayMs: 0,
    interval: "*/15 * * * *",
    loginVereist: false,
    mappingRef: null,
    method: "json-ld",
    naam: source.naam,
    rateLimitPerMinute: 600,
    retentionDays: 30,
    secretRef: null,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  });
  if (!created.ok) {
    throw new Error(
      `Hero fixture bron is invalid: ${JSON.stringify(created.issues)}`
    );
  }
  await runtime.bronPersistence.create(created.record);
  await runtime.database
    .update(bron)
    .set({ actief: true })
    .where(eq(bron.id, HERO_BRON_ID));
};

/**
 * A completed poll that discovered nothing, written straight to the table.
 *
 * `runBronIngestPipeline` resumes a `succeeded` run from its row instead of
 * rerunning the connector, which is the production path a retried task takes.
 * It is also the only way to hand the pipeline a zero-found poll without a
 * fixture whose sole purpose is to be empty.
 *
 * The run has to own the source the way a real poll does: the floor's health
 * and failure writes are fenced, so the row starts `running`, claims
 * `bron_health.active_run_id` with its fence token, and only then flips to
 * `succeeded` — the same order `PostgresRunStore.start` uses.
 */
const seedZeroFoundRun = async (database: FloorDatabase): Promise<void> => {
  await database.insert(scrapeRun).values({
    aantalGevonden: 0,
    bronId: HERO_BRON_ID,
    fenceToken: FLOOR_FENCE_TOKEN,
    fouten: 0,
    gestart: new Date(),
    gewijzigd: 0,
    id: FLOOR_RUN_ID,
    nieuw: 0,
    rejected: 0,
    runKind: "poll",
    status: "running",
  });
  const telemetry = new PostgresPollerHealthTelemetryStore(database);
  const claimed = await telemetry.claimSourceOwnership({
    bronId: HERO_BRON_ID,
    fenceToken: FLOOR_FENCE_TOKEN,
    phase: "fetch",
    phaseStartedAt: new Date(),
    runId: FLOOR_RUN_ID,
  });
  if (!claimed) {
    throw new Error("seeded floor run could not claim source ownership");
  }
  await database
    .update(scrapeRun)
    .set({ geindigd: new Date(), status: "succeeded" })
    .where(eq(scrapeRun.id, FLOOR_RUN_ID));
};

const createFloorRuntime = () => {
  const client = createBronRuntimeClient(applicationUrl);
  const objectStore = new ReadGatedObjectStore();
  let baseline: RunBaselineSample[] = [];
  const runtime = {
    ...client,
    createConnector: ({
      bronId,
      knownHashes,
      runKind,
    }: Parameters<PollBronRuntime["createConnector"]>[0]) =>
      SOURCES.hero.createConnector({
        bronId,
        knownHashes,
        listingFixturePath: "hero/listing-page-0.json",
        live: false,
        runKind,
      }),
    curateStore: new PostgresCurateStore(client.database),
    loadBaseline: () => Promise.resolve(baseline),
    objectStore,
    // Same wiring as createPollBronRuntime: one transaction for the health row
    // and alert writes the floor and silence handlers make together.
    withSourceHealthTransaction: ((runOperation) =>
      client.database.transaction((transaction) =>
        runOperation({
          alerts: new PostgresAlertStore(transaction),
          bronHealth: new PostgresBronHealthStore(transaction),
          database: transaction,
        })
      )) satisfies PollBronRuntime["withSourceHealthTransaction"],
  } satisfies PollBronRuntime;
  return {
    collapse: (): void => {
      const anchor = new Date();
      baseline = [
        {
          at: new Date(anchor.getTime() - 15 * 60_000),
          changed: 0,
          found: 0,
          new: 0,
        },
        {
          at: new Date(anchor.getTime() - 30 * 60_000),
          changed: 0,
          found: 0,
          new: 0,
        },
        {
          at: new Date(anchor.getTime() - 86_400_000),
          changed: 0,
          found: 730,
          new: 0,
        },
      ];
    },
    objectStore,
    runtime,
  };
};

const readObservationStatuses = async (
  database: FloorDatabase
): Promise<string[]> => {
  const rows = await database
    .select({ status: aanvraagObservation.status })
    .from(aanvraagObservation)
    .where(eq(aanvraagObservation.bronId, HERO_BRON_ID));
  return rows.map((row) => row.status).toSorted();
};

describe
  .skipIf(!postgresAvailable)
  .serial("runBronIngestPipeline discovery floor wiring", () => {
    it("fails the poll on a persistent collapse and drains the backlog first", async () => {
      const fixture = createFloorRuntime();
      const { database } = fixture.runtime;
      try {
        await cleanHeroRows(database);
        await seedHeroBron(fixture.runtime);

        // An earlier poll whose curation could not read raw storage. Its two
        // observations are the backlog the breaching poll must still drain.
        await expect(
          runBronIngestPipeline(
            {
              bronId: HERO_BRON_ID,
              bronSlug: "hero",
              scrapeRunId: BACKLOG_RUN_ID,
            },
            fixture.runtime,
            "poll"
          )
        ).rejects.toThrow("Raw object read failed for");
        expect(await readObservationStatuses(database)).toEqual([
          "awaiting_curation",
          "awaiting_curation",
        ]);

        fixture.objectStore.enableReads();
        fixture.collapse();
        await seedZeroFoundRun(database);

        let thrown: unknown;
        try {
          await runBronIngestPipeline(
            {
              bronId: HERO_BRON_ID,
              bronSlug: "hero",
              scrapeRunId: FLOOR_RUN_ID,
            },
            fixture.runtime,
            "poll"
          );
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(DiscoveryFloorBreachedError);

        const [floorRun] = await database
          .select({
            error: scrapeRun.fouten,
            failureClass: scrapeRun.failureClass,
            failureCode: scrapeRun.failureCode,
            failureMessage: scrapeRun.failureMessage,
            failurePhase: scrapeRun.failurePhase,
            status: scrapeRun.status,
          })
          .from(scrapeRun)
          .where(eq(scrapeRun.id, FLOOR_RUN_ID));
        expect(floorRun).toEqual({
          error: 0,
          failureClass: "connector",
          failureCode: "DISCOVER_FAILED",
          failureMessage: "Connector discovery failed",
          failurePhase: "discover",
          status: "failed",
        });

        const alerts = await database
          .select({ kind: alert.kind, message: alert.message })
          .from(alert)
          .where(eq(alert.bronId, HERO_BRON_ID));
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.kind).toBe("bron.discovery_floor");
        expect(alerts[0]?.message).toContain("3 opeenvolgende polls");

        // The throw happens after curation, so the poll that failed still
        // drained what earlier polls left behind.
        expect(await readObservationStatuses(database)).toEqual([
          "curated",
          "curated",
        ]);
      } finally {
        await fixture.runtime.close();
        const cleanupClient = createBronRuntimeClient(applicationUrl);
        try {
          await cleanHeroRows(cleanupClient.database);
          await cleanupClient.database
            .delete(bronHealth)
            .where(eq(bronHealth.bronId, HERO_BRON_ID));
          await cleanupClient.database
            .delete(alert)
            .where(eq(alert.bronId, HERO_BRON_ID));
          await cleanupClient.database
            .delete(scrapeRun)
            .where(eq(scrapeRun.bronId, HERO_BRON_ID));
        } finally {
          await cleanupClient.close();
        }
      }
    });
    it("skips the inline pass when every curation slot is busy; the backlog drain curates instead", async () => {
      const fixture = createFloorRuntime();
      const { database } = fixture.runtime;
      const slots = createSlotLimit(1);
      const runtime = { ...fixture.runtime, withCurationSlot: slots };
      try {
        await cleanHeroRows(database);
        await seedHeroBron(fixture.runtime);
        fixture.objectStore.enableReads();

        // Another source's drain holds the only slot for the whole poll.
        const held = Promise.withResolvers<null>();
        const holder = slots(() => held.promise);
        const result = await runBronIngestPipeline(
          {
            bronId: HERO_BRON_ID,
            bronSlug: "hero",
            scrapeRunId: BACKLOG_RUN_ID,
          },
          runtime,
          "poll"
        );
        expect(result.curationDeferred).toBe(true);
        expect(result.curated).toBe(0);
        expect(await readObservationStatuses(database)).toEqual([
          "awaiting_curation",
          "awaiting_curation",
        ]);

        held.resolve(null);
        await holder;
        const { signal } = new AbortController();
        const drained = await drainBacklog(
          {
            backlogUnknown: result.curationDeferred === true,
            deadlineMs: Date.now() + 30_000,
            input: {
              bronId: result.bronId,
              bronSlug: result.bronSlug,
              database: runtime.database,
              objectStore: runtime.objectStore,
              scrapeRunId: result.scrapeRunId,
              signal,
            },
            signal,
            start: {
              curated: result.curated,
              failed: result.failed,
              quarantined: result.quarantined,
              remaining: result.remaining,
            },
          },
          (input) => slots(() => curateScrapeRun(input))
        );
        expect(drained).toMatchObject({ curated: 2, remaining: 0 });
        expect(await readObservationStatuses(database)).toEqual([
          "curated",
          "curated",
        ]);
      } finally {
        await fixture.runtime.close();
        const cleanupClient = createBronRuntimeClient(applicationUrl);
        try {
          await cleanHeroRows(cleanupClient.database);
        } finally {
          await cleanupClient.close();
        }
      }
    });
  });
