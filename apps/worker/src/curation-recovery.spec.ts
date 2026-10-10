import { afterAll, describe, expect, it } from "bun:test";

import { createBron } from "@ji/application/bronnen";
import { SOURCES } from "@ji/application/sources";
import { InMemoryObjectStore } from "@ji/connectors";
import type { ObjectStore, StoredObject } from "@ji/connectors";
import { and, eq, inArray } from "drizzle-orm";
import postgres from "postgres";

import type { PollBronRuntime } from "./poll-bron-run";

const HERO_BRON_ID = "00000000-0000-4000-8000-000000000004";
const SAME_TASK_RUN_ID = "00000000-0000-4000-8000-00000000a431";
const DELAYED_POLL_RUN_ID = "00000000-0000-4000-8000-00000000a432";
const CHAIN_RUN_IDS = [
  "00000000-0000-4000-8000-00000000a433",
  "00000000-0000-4000-8000-00000000a434",
  "00000000-0000-4000-8000-00000000a435",
] as const;
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

const {
  createBronRuntimeClient,
  PostgresCurateStore,
  PostgresAlertStore,
  PostgresBronHealthStore,
} = await import("@ji/db");
const { aanvraag, aanvraagVersie, bron, dedupGroep, outboxEvent, scrapeRun } =
  await import("@ji/db/schema/index");
const { aanvraagObservation } = await import("@ji/db/schema/staging");
const { runBronIngestPipeline } = await import("./poll-bron-run");

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

  disableReads(): void {
    this.readsEnabled = false;
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

type RecoveryDatabase = ReturnType<typeof createBronRuntimeClient>["database"];

const cleanHeroRows = async (database: RecoveryDatabase): Promise<void> => {
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

const createRecoveryRuntime = () => {
  const client = createBronRuntimeClient(applicationUrl);
  const objectStore = new ReadGatedObjectStore();
  let connectorEnabled = true;
  let connectorInvocations = 0;
  const runtime = {
    ...client,
    createConnector: ({
      bronId,
      knownHashes,
      runKind,
    }: Parameters<PollBronRuntime["createConnector"]>[0]) => {
      if (!connectorEnabled) {
        throw new Error(
          "completed scrape run must bypass connector construction"
        );
      }
      connectorInvocations += 1;
      return SOURCES.hero.createConnector({
        bronId,
        knownHashes,
        listingFixturePath: "hero/listing-page-0.json",
        live: false,
        runKind,
      });
    },
    curateStore: new PostgresCurateStore(client.database),
    loadBaseline: () => Promise.resolve([]),
    objectStore,
    withSourceHealthTransaction: (runOperation) =>
      client.database.transaction((tx) =>
        runOperation({
          alerts: new PostgresAlertStore(tx),
          bronHealth: new PostgresBronHealthStore(tx),
          database: tx,
        })
      ),
  } satisfies PollBronRuntime;
  return {
    get connectorInvocations(): number {
      return connectorInvocations;
    },
    disableConnector: (): void => {
      connectorEnabled = false;
    },
    objectStore,
    runtime,
  };
};

const readDurableState = async (database: RecoveryDatabase) => {
  const requests = await database
    .select({
      bronReferentie: aanvraag.bronReferentie,
      id: aanvraag.id,
      versie: aanvraag.versie,
    })
    .from(aanvraag)
    .where(eq(aanvraag.bronId, HERO_BRON_ID));
  const requestIds = requests.map((request) => request.id);
  const versions =
    requestIds.length === 0
      ? []
      : await database
          .select({
            aanvraagId: aanvraagVersie.aanvraagId,
            versie: aanvraagVersie.versie,
          })
          .from(aanvraagVersie)
          .where(inArray(aanvraagVersie.aanvraagId, requestIds));
  const outbox =
    requestIds.length === 0
      ? []
      : await database
          .select({
            aggregateId: outboxEvent.aggregateId,
            eventType: outboxEvent.eventType,
          })
          .from(outboxEvent)
          .where(inArray(outboxEvent.aggregateId, requestIds));
  const observations = await database
    .select({
      id: aanvraagObservation.id,
      outcome: aanvraagObservation.outcome,
      scrapeRunId: aanvraagObservation.scrapeRunId,
      status: aanvraagObservation.status,
    })
    .from(aanvraagObservation)
    .where(eq(aanvraagObservation.bronId, HERO_BRON_ID));
  return { observations, outbox, requests, versions };
};

const expectExactlyOneNewVersionPerIdentity = async (
  database: RecoveryDatabase
): Promise<void> => {
  const state = await readDurableState(database);
  expect(state.requests).toHaveLength(2);
  expect(
    new Set(state.requests.map((request) => request.bronReferentie)).size
  ).toBe(2);
  expect(state.requests.every((request) => request.versie === 1)).toBe(true);
  expect(state.versions).toHaveLength(2);
  expect(state.versions.every((version) => version.versie === 1)).toBe(true);
  expect(new Set(state.versions.map((version) => version.aanvraagId))).toEqual(
    new Set(state.requests.map((request) => request.id))
  );
  // Exactly one create event per identity. A later poll of unchanged content
  // adds its own `aanvraag.gewijzigd` (CTP-498: laatst_gezien_op is a projected
  // field), so the create events are counted rather than the whole outbox.
  const created = state.outbox.filter(
    (event) => event.eventType === "aanvraag.nieuw"
  );
  expect(created).toHaveLength(2);
  expect(new Set(created.map((event) => event.aggregateId))).toEqual(
    new Set(state.requests.map((request) => request.id))
  );
  expect(
    state.outbox.every(
      (event) =>
        event.eventType === "aanvraag.nieuw" ||
        event.eventType === "aanvraag.gewijzigd"
    )
  ).toBe(true);
};

/**
 * An unreachable object store still aborts the pass, and this is deliberate.
 *
 * CTP-499 stopped `curateScrapeRun` rethrowing per-candidate errors, because a
 * single row Postgres refused was holding an entire source hostage. A store
 * that will not answer is the opposite case: it says nothing about any row, and
 * every status the pass could write for it -- terminal `curation_failed` or
 * deferred `deferred_missing_raw` -- needs an operator to clear by hand. So the
 * pass aborts untouched and the next poll retries the whole backlog, which is
 * what the rows below assert by staying `awaiting_curation`.
 */
const expectInjectedReadFailure = async (
  operation: Promise<unknown>
): Promise<void> => {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) {
    throw new Error("Expected curation to reject with an Error");
  }
  expect(caught.name).toBe("RawReadError");
  expect(caught.message).toContain("Raw object read failed for");
  expect(caught.cause).toBeInstanceOf(Error);
  if (!(caught.cause instanceof Error)) {
    throw new Error("Expected the read failure to retain its storage cause");
  }
  expect(caught.cause.message).toBe("injected raw object read failure");
};

describe
  .skipIf(!postgresAvailable)
  .serial("worker curation recovery (RJC-433)", () => {
    it("resumes a succeeded task without rerunning its connector or duplicating durable rows", async () => {
      const fixture = createRecoveryRuntime();
      const payload = {
        bronId: HERO_BRON_ID,
        bronSlug: "hero" as const,
        scrapeRunId: SAME_TASK_RUN_ID,
      };
      try {
        await cleanHeroRows(fixture.runtime.database);
        await seedHeroBron(fixture.runtime);
        await expectInjectedReadFailure(
          runBronIngestPipeline(payload, fixture.runtime, "poll")
        );
        expect(fixture.connectorInvocations).toBe(1);
        const staged = await readDurableState(fixture.runtime.database);
        expect(staged.requests).toHaveLength(0);
        expect(staged.observations).toHaveLength(2);
        expect(
          staged.observations.every(
            (observation) => observation.status === "awaiting_curation"
          )
        ).toBe(true);
        const [completedBeforeRetry] = await fixture.runtime.database
          .select({
            changed: scrapeRun.gewijzigd,
            error: scrapeRun.fouten,
            found: scrapeRun.aantalGevonden,
            new: scrapeRun.nieuw,
            rejected: scrapeRun.rejected,
            status: scrapeRun.status,
          })
          .from(scrapeRun)
          .where(eq(scrapeRun.id, SAME_TASK_RUN_ID));
        expect(completedBeforeRetry).toEqual({
          changed: 0,
          error: 0,
          found: 2,
          new: 2,
          rejected: 0,
          status: "succeeded",
        });

        fixture.objectStore.enableReads();
        fixture.disableConnector();
        const resumed = await runBronIngestPipeline(
          payload,
          fixture.runtime,
          "poll"
        );
        expect(resumed.curated).toBe(2);
        expect(resumed.pending).toBe(0);
        expect(resumed.remaining).toBe(0);
        expect(fixture.connectorInvocations).toBe(1);

        const replay = await runBronIngestPipeline(
          payload,
          fixture.runtime,
          "poll"
        );
        expect(replay.curated).toBe(0);
        expect(replay.remaining).toBe(0);
        expect(fixture.connectorInvocations).toBe(1);
        await expectExactlyOneNewVersionPerIdentity(fixture.runtime.database);

        const state = await readDurableState(fixture.runtime.database);
        expect(state.observations).toHaveLength(2);
        expect(
          state.observations.every(
            (observation) => observation.status === "curated"
          )
        ).toBe(true);
        const [run] = await fixture.runtime.database
          .select({ status: scrapeRun.status })
          .from(scrapeRun)
          .where(eq(scrapeRun.id, SAME_TASK_RUN_ID));
        expect(run?.status).toBe("succeeded");

        await expect(
          runBronIngestPipeline(payload, fixture.runtime, "test")
        ).rejects.toThrow("Cannot resume mismatched scrape run");
        await expect(
          runBronIngestPipeline(
            { ...payload, bronId: "00000000-0000-4000-8000-000000000010" },
            fixture.runtime,
            "poll"
          )
        ).rejects.toThrow("Cannot resume mismatched scrape run");
        await expect(
          runBronIngestPipeline(
            { ...payload, bronSlug: "tenderned" },
            fixture.runtime,
            "poll"
          )
        ).rejects.toThrow("Poll source slug does not match bronId");
        expect(fixture.connectorInvocations).toBe(1);
        await expectExactlyOneNewVersionPerIdentity(fixture.runtime.database);
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

    it("drains an earlier backlog during a later unchanged poll and keeps its retry idempotent", async () => {
      const fixture = createRecoveryRuntime();
      const firstPayload = {
        bronId: HERO_BRON_ID,
        bronSlug: "hero" as const,
        scrapeRunId: SAME_TASK_RUN_ID,
      };
      const laterPayload = {
        bronId: HERO_BRON_ID,
        bronSlug: "hero" as const,
        scrapeRunId: DELAYED_POLL_RUN_ID,
      };
      try {
        await cleanHeroRows(fixture.runtime.database);
        await seedHeroBron(fixture.runtime);
        await expectInjectedReadFailure(
          runBronIngestPipeline(firstPayload, fixture.runtime, "poll")
        );
        expect(fixture.connectorInvocations).toBe(1);
        const staged = await readDurableState(fixture.runtime.database);
        const priorObservationIds = staged.observations.map(
          (observation) => observation.id
        );
        expect(priorObservationIds).toHaveLength(2);
        expect(
          staged.observations.every(
            (observation) => observation.status === "awaiting_curation"
          )
        ).toBe(true);
        const [completedBeforeLaterPoll] = await fixture.runtime.database
          .select({
            changed: scrapeRun.gewijzigd,
            error: scrapeRun.fouten,
            found: scrapeRun.aantalGevonden,
            new: scrapeRun.nieuw,
            rejected: scrapeRun.rejected,
            status: scrapeRun.status,
          })
          .from(scrapeRun)
          .where(eq(scrapeRun.id, SAME_TASK_RUN_ID));
        expect(completedBeforeLaterPoll).toEqual({
          changed: 0,
          error: 0,
          found: 2,
          new: 2,
          rejected: 0,
          status: "succeeded",
        });

        fixture.objectStore.enableReads();
        const later = await runBronIngestPipeline(
          laterPayload,
          fixture.runtime,
          "poll"
        );
        expect(later.metrics).toEqual({
          changed: 0,
          closed: 0,
          error: 0,
          found: 2,
          new: 0,
          rejected: 0,
          unchanged: 2,
        });
        expect(later.curated).toBe(2);
        expect(later.unchanged).toBe(2);
        expect(later.remaining).toBe(0);
        expect(fixture.connectorInvocations).toBe(2);

        // CTP-498: the later poll bumped laatst_gezien_op on both identities,
        // so each carries one seen event on top of its create event.
        const beforeReplay = await readDurableState(fixture.runtime.database);
        expect(beforeReplay.outbox).toHaveLength(4);

        fixture.disableConnector();
        const replay = await runBronIngestPipeline(
          laterPayload,
          fixture.runtime,
          "poll"
        );
        expect(replay.metrics.unchanged).toBe(2);
        expect(replay.remaining).toBe(0);
        expect(fixture.connectorInvocations).toBe(2);
        await expectExactlyOneNewVersionPerIdentity(fixture.runtime.database);
        // The retry observes the same payload at the same instant, so it moves
        // no field and enqueues nothing: the seen event is not a per-poll tax.
        const afterReplay = await readDurableState(fixture.runtime.database);
        expect(afterReplay.outbox).toHaveLength(4);

        const state = await readDurableState(fixture.runtime.database);
        expect(state.observations).toHaveLength(4);
        expect(
          state.observations
            .filter((observation) =>
              priorObservationIds.includes(observation.id)
            )
            .every((observation) => observation.status === "curated")
        ).toBe(true);
        expect(
          state.observations.filter(
            (observation) => observation.status === "curated"
          )
        ).toHaveLength(2);
        expect(
          state.observations.filter(
            (observation) => observation.status === "unchanged"
          )
        ).toHaveLength(2);
        expect(
          state.observations.some((observation) =>
            ["awaiting_curation", "blocked_ordering", "pending"].includes(
              observation.status
            )
          )
        ).toBe(false);
        const runs = await fixture.runtime.database
          .select({ id: scrapeRun.id, status: scrapeRun.status })
          .from(scrapeRun)
          .where(
            and(
              eq(scrapeRun.bronId, HERO_BRON_ID),
              inArray(scrapeRun.id, [SAME_TASK_RUN_ID, DELAYED_POLL_RUN_ID])
            )
          );
        expect(runs).toHaveLength(2);
        expect(runs.every((run) => run.status === "succeeded")).toBe(true);
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

    it("drains a chain of unchanged re-observations through its newest link in one pass, losing nothing", async () => {
      const fixture = createRecoveryRuntime();
      const firstPayload = {
        bronId: HERO_BRON_ID,
        bronSlug: "hero" as const,
        scrapeRunId: SAME_TASK_RUN_ID,
      };
      try {
        await cleanHeroRows(fixture.runtime.database);
        await seedHeroBron(fixture.runtime);
        fixture.objectStore.enableReads();
        const first = await runBronIngestPipeline(
          firstPayload,
          fixture.runtime,
          "poll"
        );
        expect(first.curated).toBe(2);
        fixture.objectStore.disableReads();

        // Three later polls see the same two vacancies unchanged while the
        // store will not answer: each curation pass aborts on its raw read,
        // which is how prod piled up one `unchanged` row per identity per run.
        for (const scrapeRunId of CHAIN_RUN_IDS) {
          // oxlint-disable-next-line no-await-in-loop -- polls are sequential by construction
          await expectInjectedReadFailure(
            runBronIngestPipeline(
              { ...firstPayload, scrapeRunId },
              fixture.runtime,
              "poll"
            )
          );
        }
        const statusByRun = async () => {
          const state = await readDurableState(fixture.runtime.database);
          return Object.fromEntries(
            [SAME_TASK_RUN_ID, ...CHAIN_RUN_IDS].map((runId) => [
              runId,
              state.observations
                .filter((observation) => observation.scrapeRunId === runId)
                .map((observation) => observation.status)
                .toSorted(),
            ])
          );
        };
        fixture.objectStore.enableReads();
        fixture.disableConnector();
        const drained = await runBronIngestPipeline(
          { ...firstPayload, scrapeRunId: CHAIN_RUN_IDS[2] },
          fixture.runtime,
          "poll"
        );
        expect(drained.unchanged).toBe(2);
        expect(drained.remaining).toBe(0);
        const afterDrain = await statusByRun();
        // The head applied, and every older link is superseded behind it.
        expect(afterDrain).toEqual({
          [SAME_TASK_RUN_ID]: ["curated", "curated"],
          [CHAIN_RUN_IDS[0]]: ["superseded", "superseded"],
          [CHAIN_RUN_IDS[1]]: ["superseded", "superseded"],
          [CHAIN_RUN_IDS[2]]: ["unchanged", "unchanged"],
        });
        // Content never changed, so the drain wrote no version.
        await expectExactlyOneNewVersionPerIdentity(fixture.runtime.database);
        const [newestRun] = await fixture.runtime.database
          .select({ gestart: scrapeRun.gestart })
          .from(scrapeRun)
          .where(eq(scrapeRun.id, CHAIN_RUN_IDS[2]));
        const requests = await fixture.runtime.database
          .select({ laatstGezienOp: aanvraag.laatstGezienOp })
          .from(aanvraag)
          .where(eq(aanvraag.bronId, HERO_BRON_ID));
        // last-seen comes from the newest link, so nothing was lost.
        expect(
          requests.every(
            (request) =>
              newestRun !== undefined &&
              request.laatstGezienOp.getTime() >= newestRun.gestart.getTime()
          )
        ).toBe(true);
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
