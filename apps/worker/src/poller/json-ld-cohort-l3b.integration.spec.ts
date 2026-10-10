import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Connector } from "@ji/connectors";
import {
  createJsonLdClient,
  createJsonLdConnector,
  datajobsConfig,
  unicaConfig,
  urlSlugBronReferentie,
  vattenfallConfig,
  volkerwesselsConfig,
  werkenVoorNederlandConfig,
} from "@ji/connectors/json-ld";
import type {
  JsonLdClient,
  JsonLdConnectorConfig,
  JsonLdDetailPayload,
} from "@ji/connectors/json-ld";
import {
  aanvraag,
  aanvraagVersie,
  alert,
  bron,
  bronHealth,
  outboxEvent,
  scrapeRun,
} from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { aanvraagObservation, sourceRecord } from "@ji/db/schema/staging";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { PollBronRuntime } from "../poll-bron-run";
import type { SliceABronSlug } from "../slice-a-bronnen";
import {
  BRON_INGEST_QUEUE,
  createBronIngestQueue,
  offerBronIngestJob,
  runDurableBronJobConsumer,
} from "./durable-jobs";
import type { BronIngestJob } from "./durable-jobs";

/**
 * CTP-638 L3b JSON-LD-cohort proof: DataJobs.nl, Unica, Vattenfall,
 * VolkerWessels and Werken voor Nederland on the durable ingest path
 * (`curated.durable_job` + `runDurableBronJobConsumer` +
 * `runBronIngestPipeline`) against real Postgres — the committed fixture
 * clients for detail reads, scripted whole-corpus listings for retake/abort
 * evidence.
 *
 * All five connectors share the L3a (CTP-637) single-page discovery shape:
 * `discover()` returns every detail URL with `hasMore: false` and an inert
 * `checkpoint: {}`. A durable retake therefore re-enumerates the WHOLE corpus
 * and re-fetches every detail page; exactly-once is carried by the
 * observation replay key (scrapeRunId + bronReferentie + contentHash), not by
 * page-cursor resume. These specs assert that honestly.
 *
 * Corpus scoping, stated plainly: the committed listing fixtures are the real
 * full sitemaps (datajobs 244 vacature-URLs, unica 558, vattenfall 20 NL,
 * volkerwessels 533, werken-voor-nederland ~1221), while detail coverage is
 * the fixture-backed subset recorded per bron (1–3 URLs).
 * `scopedFixtureConnector` therefore filters the REAL parsed listing to
 * `config.detailFixtures` keys — every persisted payload is a real recorded
 * fixture, and whole-corpus enumeration itself is pinned per bron in
 * `packages/connectors/src/json-ld/durable-cohort-l3b.spec.ts` and the
 * per-source specs (e.g. `unica.spec.ts` asserts 558 discovered URLs).
 * No recorded soft-404/reject fixture exists for any of these five bronnen,
 * so `rejectedReferenties` is empty throughout — the discovery-level
 * exclusion is already proven by the per-source listing specs.
 */
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

// The pipeline drains the search outbox only in "worker" mode; "onbox" defers
// to the projector, which does not exist in this spec. Env is saved and
// restored so module scope never leaks into sibling spec files.
const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATAJOBS_LIVE: process.env.DATAJOBS_LIVE,
  RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
  SEARCH_PROJECTOR: process.env.SEARCH_PROJECTOR,
  UNICA_LIVE: process.env.UNICA_LIVE,
  VATTENFALL_LIVE: process.env.VATTENFALL_LIVE,
  VOLKERWESSELS_LIVE: process.env.VOLKERWESSELS_LIVE,
  WERKEN_VOOR_NEDERLAND_LIVE: process.env.WERKEN_VOOR_NEDERLAND_LIVE,
};
// poll-bron-run validates `DATABASE_URL` at import time; point it at the same
// database before the dynamic import below (mirrors abort-finalization).
process.env.DATABASE_URL ??= applicationUrl;
process.env.SEARCH_PROJECTOR = "onbox";
// Raw payloads land in a throwaway filesystem store, never the repo .data dir.
process.env.RAW_OBJECT_STORE_PATH ??= `${process.env.TMPDIR ?? "/tmp"}/ji-jsonld-l3b-cohort-raw-${process.pid}`;
// All five connectors must stay in fixture mode — no live egress from tests.
delete process.env.DATAJOBS_LIVE;
delete process.env.UNICA_LIVE;
delete process.env.VATTENFALL_LIVE;
delete process.env.VOLKERWESSELS_LIVE;
delete process.env.WERKEN_VOOR_NEDERLAND_LIVE;

const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
};

interface BronSpec {
  /**
   * Detail call index (1-based across the whole job, shared between attempts)
   * whose fetchDetail aborts the attempt's signal. Chosen so that at least
   * one observation is persisted before the abort where the corpus allows it;
   * werken-voor-nederland has a single fixture-backed URL (nothing can
   * persist first — the retake writes it fresh).
   */
  readonly abortOnDetailCall: number;
  readonly bronId: string;
  readonly bronSlug: SliceABronSlug;
  readonly categorie: string;
  readonly config: JsonLdConnectorConfig;
  /** bronReferenties the fixture-backed corpus enumerates (incl. rejects). */
  readonly discoveredReferenties: readonly string[];
  /** bronReferenties that persist: observations, source_records, aanvragen. */
  readonly fixtureReferenties: readonly string[];
  /** bronReferenties that discover but reject without an observation. */
  readonly rejectedReferenties: readonly string[];
  readonly naam: string;
}

const DATAJOBS: BronSpec = {
  abortOnDetailCall: 2,
  bronId: "00000000-0000-4000-8000-000000000018",
  bronSlug: "datajobs",
  categorie: "jobboard",
  config: datajobsConfig,
  discoveredReferenties: [
    "vacatures/aiml-engineer-bij-ilionx",
    "vacatures/data-engineer-bij-verpact",
    "vacatures/privacy-officer-bij-gemeente-altena",
  ],
  fixtureReferenties: [
    "vacatures/aiml-engineer-bij-ilionx",
    "vacatures/data-engineer-bij-verpact",
    "vacatures/privacy-officer-bij-gemeente-altena",
  ],
  naam: "DataJobs.nl",
  rejectedReferenties: [],
};
/** bronReferenties of every committed detail fixture for `config` — the
 * replay-scoped corpus the wrapper client enumerates. Derived from
 * `config.detailFixtures` so a new capture widens the expected corpus
 * instead of breaking the spec (CTP-647). */
const detailBackedReferenties = (
  config: JsonLdConnectorConfig
): readonly string[] =>
  Object.keys(config.detailFixtures ?? {}).map(urlSlugBronReferentie);

const UNICA_DISCOVERED = detailBackedReferenties(unicaConfig);

const UNICA: BronSpec = {
  abortOnDetailCall: 2,
  bronId: "00000000-0000-4000-8000-00000000001f",
  bronSlug: "unica",
  categorie: "werkgever",
  config: unicaConfig,
  discoveredReferenties: UNICA_DISCOVERED,
  fixtureReferenties: UNICA_DISCOVERED,
  naam: "Unica",
  rejectedReferenties: [],
};
const VATTENFALL: BronSpec = {
  abortOnDetailCall: 2,
  bronId: "00000000-0000-4000-8000-00000000001d",
  bronSlug: "vattenfall",
  categorie: "werkgever",
  config: vattenfallConfig,
  discoveredReferenties: [
    "global/job/analytics-engineer-in-amsterdam-jid-50838",
    "global/job/monteur-stadswarmte-in-arnhem-jid-51914",
    "global/job/service-technician-onshore-wind-turbines-in-slootdorp-jid-48727",
  ],
  fixtureReferenties: [
    "global/job/analytics-engineer-in-amsterdam-jid-50838",
    "global/job/monteur-stadswarmte-in-arnhem-jid-51914",
    "global/job/service-technician-onshore-wind-turbines-in-slootdorp-jid-48727",
  ],
  naam: "Vattenfall",
  rejectedReferenties: [],
};
const VOLKERWESSELS_DISCOVERED = detailBackedReferenties(volkerwesselsConfig);

const VOLKERWESSELS: BronSpec = {
  abortOnDetailCall: 2,
  bronId: "00000000-0000-4000-8000-000000000014",
  bronSlug: "volkerwessels",
  categorie: "werkgever",
  config: volkerwesselsConfig,
  discoveredReferenties: VOLKERWESSELS_DISCOVERED,
  fixtureReferenties: VOLKERWESSELS_DISCOVERED,
  naam: "VolkerWessels",
  rejectedReferenties: [],
};
const WERKEN_VOOR_NEDERLAND: BronSpec = {
  // Single fixture-backed URL: the abort lands on the first detail read, so
  // nothing persists before it — the retake writes the item fresh. Replay
  // absorption for this bron is pinned in the connector spec with a scripted
  // corpus (same shape as the L3a asml case).
  abortOnDetailCall: 1,
  bronId: "00000000-0000-4000-8000-00000000000e",
  bronSlug: "werken-voor-nederland",
  categorie: "overheidsportaal",
  config: werkenVoorNederlandConfig,
  discoveredReferenties: [
    "vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570",
  ],
  fixtureReferenties: [
    "vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570",
  ],
  naam: "Werken voor Nederland",
  rejectedReferenties: [],
};

const SPECS: readonly BronSpec[] = [
  DATAJOBS,
  UNICA,
  VATTENFALL,
  VOLKERWESSELS,
  WERKEN_VOOR_NEDERLAND,
];

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(applicationUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const waitFor = async (
  condition: () => boolean | Promise<boolean>
): Promise<void> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling is the point of the helper
    if (await condition()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- timers have no promise API
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

interface JobRow {
  readonly attempts: number;
  readonly completed: boolean;
  readonly id: string;
  readonly last_failure: string | null;
}

/**
 * A connector over the committed fixture corpus whose `fetchListing` serves
 * the REAL parsed listing filtered to `config.detailFixtures` keys (the
 * fixture-backed corpus — see the file docblock) and can be scripted to fail
 * (`listingFailuresLeft` — must outlast the in-run retry budget of 3 so the
 * durable retake, not the retry, is what recovers) and whose `fetchDetail`
 * aborts the attempt's signal inside one item's read or swaps one recorded
 * payload for a changed body (`mutateDetail`). Detail reads always delegate
 * to the real fixture client, so persisted payloads stay real recordings.
 */
const scopedFixtureConnector = (
  spec: BronSpec,
  options: {
    abortOnDetailCall?: number;
    attemptControllers?: AbortController[];
    detailCalls?: string[];
    listingCalls?: { count: number };
    listingFailuresLeft?: { current: number };
    mutateDetail?: {
      mutate: (payload: JsonLdDetailPayload) => JsonLdDetailPayload;
      url: string;
    };
  }
): Connector => {
  const fixtureClient: JsonLdClient = createJsonLdClient({
    config: spec.config,
    liveEnabled: false,
  });
  const detailBacked = new Set(Object.keys(spec.config.detailFixtures ?? {}));
  const jsonLdClient: JsonLdClient = {
    fetchDetail: async (url, signal) => {
      options.detailCalls?.push(url);
      // `detailCalls` is shared across attempts (the factory runs per take),
      // so the abort fires exactly once — on the run's Nth detail read ever —
      // never again on the retake.
      if (options.abortOnDetailCall === options.detailCalls?.length) {
        options.attemptControllers?.at(-1)?.abort();
      }
      const payload = await fixtureClient.fetchDetail(url, signal);
      if (options.mutateDetail && url === options.mutateDetail.url) {
        return options.mutateDetail.mutate(payload);
      }
      return payload;
    },
    fetchListing: async (signal) => {
      if (options.listingCalls) {
        options.listingCalls.count += 1;
      }
      const failures = options.listingFailuresLeft;
      if (failures && failures.current > 0) {
        failures.current -= 1;
        throw new Error("scripted listing failure");
      }
      const discovered = await fixtureClient.fetchListing(signal);
      return discovered.filter((entry) => detailBacked.has(entry.url));
    },
  };
  return createJsonLdConnector({
    bronId: spec.bronId,
    client: jsonLdClient,
    config: spec.config,
  });
};

describe.serial(
  "L3b JSON-LD cohort on the durable ingest path (CTP-638)",
  () => {
    let available = false;
    let client: ReturnType<typeof postgres> | null = null;
    let database: PostgresJsDatabase<typeof schema> | null = null;
    let runtime: PollBronRuntime | null = null;
    const seededBronnen: BronSpec[] = [];

    const db = (): PostgresJsDatabase<typeof schema> => {
      if (!database) {
        throw new Error("Postgres fixture is unavailable");
      }
      return database;
    };

    const sqlClient = (): ReturnType<typeof postgres> => {
      if (!client) {
        throw new Error("Postgres fixture is unavailable");
      }
      return client;
    };

    const seedBron = async (spec: BronSpec): Promise<void> => {
      const [existing] = await db()
        .select({ id: bron.id })
        .from(bron)
        .where(eq(bron.id, spec.bronId));
      if (existing) {
        return;
      }
      await db().insert(bron).values({
        actief: true,
        categorie: spec.categorie,
        crawlDelayMs: 5,
        id: spec.bronId,
        interval: "*/15 * * * *",
        naam: spec.naam,
        rateLimitPerMinute: 600,
        retentionDays: 90,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      seededBronnen.push(spec);
    };

    const cleanupBron = async (spec: BronSpec): Promise<void> => {
      const { bronId } = spec;
      await sqlClient()`
      DELETE FROM curated.aanvraag_versie
      WHERE aanvraag_id IN (SELECT id FROM curated.aanvraag WHERE bron_id = ${bronId})`;
      await sqlClient()`
      DELETE FROM curated.aanvraag_bron_link WHERE bron_id = ${bronId}`;
      await sqlClient()`
      DELETE FROM curated.outbox_event
      WHERE aggregate_id IN (SELECT id FROM curated.aanvraag WHERE bron_id = ${bronId})`;
      await db().delete(aanvraag).where(eq(aanvraag.bronId, bronId));
      await db()
        .delete(aanvraagObservation)
        .where(eq(aanvraagObservation.bronId, bronId));
      await db().delete(sourceRecord).where(eq(sourceRecord.bronId, bronId));
      await db().delete(scrapeRun).where(eq(scrapeRun.bronId, bronId));
      await db().delete(alert).where(eq(alert.bronId, bronId));
      await db().delete(bronHealth).where(eq(bronHealth.bronId, bronId));
      await db().delete(bron).where(eq(bron.id, bronId));
    };

    beforeAll(async () => {
      available = await isPostgresAvailable();
      if (!available) {
        if (testDatabaseRequired) {
          throw new Error("Required test database is unavailable");
        }
        return;
      }
      client = postgres(applicationUrl, { max: 4 });
      database = drizzle(client, { schema });
      const { createPollBronRuntime } = await import("../poll-bron-run");
      runtime = createPollBronRuntime(applicationUrl);
      for (const spec of SPECS) {
        // oxlint-disable-next-line no-await-in-loop -- serialized seed order per bron
        await seedBron(spec);
      }
    });

    afterAll(async () => {
      if (client && database) {
        await client`DELETE FROM curated.durable_job WHERE queue_name = ${BRON_INGEST_QUEUE}`;
        for (const spec of seededBronnen) {
          // oxlint-disable-next-line no-await-in-loop -- FK-safe teardown order per bron
          await cleanupBron(spec);
        }
      }
      await runtime?.close();
      await client?.end({ timeout: 5 });
      restoreEnv();
    });

    const jobRow = async (id: string): Promise<JobRow | undefined> => {
      const rows = await sqlClient()<JobRow[]>`
      SELECT id, completed, attempts, last_failure
      FROM curated.durable_job
      WHERE queue_name = ${BRON_INGEST_QUEUE} AND id = ${id}
    `;
      return rows[0];
    };

    const runState = (scrapeRunId: string) =>
      db()
        .select({
          checkpoint: scrapeRun.checkpoint,
          failureCode: scrapeRun.failureCode,
          failurePhase: scrapeRun.failurePhase,
          fenceToken: scrapeRun.fenceToken,
          found: scrapeRun.aantalGevonden,
          status: scrapeRun.status,
        })
        .from(scrapeRun)
        .where(eq(scrapeRun.id, scrapeRunId));

    /** Rows written by ONE run — the bron accumulates rows across tests. */
    const runRows = async (scrapeRunId: string) => {
      const [observations, records, aanvragen] = await Promise.all([
        db()
          .select({
            bronReferentie: sourceRecord.bronReferentie,
            outcome: aanvraagObservation.outcome,
          })
          .from(aanvraagObservation)
          .innerJoin(
            sourceRecord,
            eq(aanvraagObservation.sourceRecordId, sourceRecord.id)
          )
          .where(eq(aanvraagObservation.scrapeRunId, scrapeRunId)),
        db()
          .select({
            bronReferentie: sourceRecord.bronReferentie,
            missedPolls: sourceRecord.missedPolls,
          })
          .from(sourceRecord)
          .where(eq(sourceRecord.scrapeRunId, scrapeRunId)),
        db()
          .select({ bronReferentie: aanvraag.bronReferentie })
          .from(aanvraag)
          .where(eq(aanvraag.scrapeRunId, scrapeRunId)),
      ]);
      return {
        aanvragen: aanvragen.map((row) => row.bronReferentie).toSorted(),
        observations,
        sourceRecords: records,
      };
    };

    /** All curated rows for the bron — accumulates across runs. */
    const bronRows = async (bronId: string) => {
      const aanvragen = await db()
        .select({
          bronReferentie: aanvraag.bronReferentie,
          id: aanvraag.id,
          titel: aanvraag.titel,
          versie: aanvraag.versie,
        })
        .from(aanvraag)
        .where(eq(aanvraag.bronId, bronId));
      const ids = aanvragen.map((row) => row.id);
      const [versies, outbox] = await Promise.all([
        ids.length === 0
          ? Promise.resolve([])
          : db()
              .select({
                aanvraagId: aanvraagVersie.aanvraagId,
                versie: aanvraagVersie.versie,
              })
              .from(aanvraagVersie)
              .where(inArray(aanvraagVersie.aanvraagId, ids)),
        ids.length === 0
          ? Promise.resolve([])
          : db()
              .select({ aggregateId: outboxEvent.aggregateId })
              .from(outboxEvent)
              .where(
                and(
                  inArray(outboxEvent.aggregateId, ids),
                  eq(outboxEvent.aggregateType, "aanvraag")
                )
              ),
      ]);
      return { aanvragen, outbox, versies };
    };

    interface DriveOptions {
      /** Replaces the registry connector — failure injection + scoped feeds. */
      readonly connector?: () => Connector;
      /** Observes the scrape_run row at the start of each take (1-based). */
      readonly onAttempt?: (
        attempt: number,
        scrapeRunId: string
      ) => Promise<void>;
      /** Signal factory per queue take (attempt index is 1-based). */
      readonly signalFor?: (attempt: number) => AbortSignal | undefined;
    }

    /**
     * Offers one durable job and runs the consumer until the row closes —
     * `processJob` is exactly what `main.ts` wires: `runBronIngestPipeline`
     * with the job's scrapeRunId.
     */
    const driveJob = async (
      spec: BronSpec,
      options: DriveOptions = {}
    ): Promise<{ readonly job: BronIngestJob; readonly takes: number }> => {
      const activeRuntime = runtime;
      if (!activeRuntime) {
        throw new Error("Postgres fixture is unavailable");
      }
      const factory = options.connector;
      const wiredRuntime: PollBronRuntime = factory
        ? { ...activeRuntime, createConnector: () => factory() }
        : activeRuntime;
      const job: BronIngestJob = {
        bronId: spec.bronId,
        bronSlug: spec.bronSlug,
        scrapeRunId: crypto.randomUUID(),
      };
      let takes = 0;
      const controller = new AbortController();
      const queue = await createBronIngestQueue(applicationUrl, {
        lockExpiration: "1 seconds",
        lockRefreshInterval: "50 millis",
        pollInterval: "20 millis",
      });
      try {
        await offerBronIngestJob(queue.queue, job);
        const { runBronIngestPipeline } = await import("../poll-bron-run");
        const consumerDone = runDurableBronJobConsumer({
          maxAttempts: 5,
          processJob: async (runningJob, _attempts) => {
            takes += 1;
            // `attempts` from the queue is the row's pre-take count (0-based);
            // `takes` is this spec's own 1-based take counter.
            await options.onAttempt?.(takes, runningJob.scrapeRunId);
            await runBronIngestPipeline(
              {
                // SAFETY: the job was offered by driveJob with the seeded bronId.
                bronId: runningJob.bronId as BronId,
                // SAFETY: literal Slice-A slug offered with the job above.
                bronSlug: runningJob.bronSlug as SliceABronSlug,
                // SAFETY: the scrapeRunId generated for this job's run row.
                scrapeRunId: runningJob.scrapeRunId as ScrapeRunId,
              },
              wiredRuntime,
              "poll",
              { signal: options.signalFor?.(takes) }
            );
          },
          queue: queue.queue,
          signal: controller.signal,
        });
        await waitFor(async () => {
          const row = await jobRow(job.scrapeRunId);
          return row?.completed === true;
        });
        controller.abort();
        await consumerDone;
      } finally {
        await queue.close();
      }
      return { job, takes };
    };

    const registerSpecs = (spec: BronSpec): void => {
      it(`runs ${spec.bronSlug} end-to-end through the durable queue into curated aanvragen and the search outbox`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        // Fixture-mode client (live env unset) scoped to the fixture-backed
        // corpus; detail reads are the real recorded fixtures.
        const { job, takes } = await driveJob(spec, {
          connector: () => scopedFixtureConnector(spec, {}),
        });

        const row = await jobRow(job.scrapeRunId);
        expect(row).toMatchObject({ attempts: 1, completed: true });
        expect(row?.last_failure).toBeNull();
        expect(takes).toBe(1);

        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");
        expect(run?.fenceToken).toBe(1);
        // Single-page discovery committed its inert empty checkpoint.
        expect(run?.checkpoint).toEqual({});
        expect(run?.found).toBe(spec.discoveredReferenties.length);

        const counts = await runRows(job.scrapeRunId);
        const expected = spec.fixtureReferenties.length;
        expect(counts.observations).toHaveLength(expected);
        expect(
          counts.observations.every(
            (observation) => observation.outcome === "new"
          )
        ).toBe(true);
        expect(
          counts.sourceRecords.map((r) => r.bronReferentie).toSorted()
        ).toEqual(spec.fixtureReferenties.toSorted());
        expect(counts.aanvragen).toEqual(spec.fixtureReferenties.toSorted());
        // Rejected items leave no rows at all — none exist for this cohort,
        // but keep the honest assertion for the day one is recorded.
        for (const rejected of spec.rejectedReferenties) {
          expect(
            counts.sourceRecords.map((r) => r.bronReferentie)
          ).not.toContain(rejected);
        }
        // No tombstone bookkeeping on a complete first run.
        expect(
          counts.sourceRecords.every((record) => record.missedPolls === 0)
        ).toBe(true);

        // Curation reached the search outbox: one aanvraag-aggregate event per
        // curated row, parked unprocessed (SEARCH_PROJECTOR=onbox defers the
        // drain to the projector, which this spec does not run).
        const curatedRows = await bronRows(spec.bronId);
        expect(curatedRows.aanvragen).toHaveLength(expected);
        expect(curatedRows.outbox.length).toBeGreaterThanOrEqual(expected);
      }, 30_000);

      it(`a repeat ${spec.bronSlug} run re-observes the same corpus as unchanged — dedupe, no duplicate aanvragen or versions`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        const { job, takes } = await driveJob(spec, {
          connector: () => scopedFixtureConnector(spec, {}),
        });

        const row = await jobRow(job.scrapeRunId);
        expect(row).toMatchObject({ attempts: 1, completed: true });
        expect(takes).toBe(1);

        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");

        const counts = await runRows(job.scrapeRunId);
        const expected = spec.fixtureReferenties.length;
        // Every re-observation dedupes on contentHash: outcome `unchanged`,
        // never a second `new`/`changed` version of the same payload.
        expect(counts.observations).toHaveLength(expected);
        expect(
          counts.observations.every(
            (observation) => observation.outcome === "unchanged"
          )
        ).toBe(true);
        // source_record rows move to this run id but stay one per referentie.
        expect(
          counts.sourceRecords.map((r) => r.bronReferentie).toSorted()
        ).toEqual(spec.fixtureReferenties.toSorted());

        // No duplicate curated rows and no new versions: the aanvraag set is
        // exactly the fixture corpus and every row is still versie 1.
        const curatedRows = await bronRows(spec.bronId);
        expect(
          curatedRows.aanvragen
            .map((aanvraagRow) => aanvraagRow.bronReferentie)
            .toSorted()
        ).toEqual(spec.fixtureReferenties.toSorted());
        expect(
          curatedRows.aanvragen.every((aanvraagRow) => aanvraagRow.versie === 1)
        ).toBe(true);
        expect(curatedRows.versies).toHaveLength(expected);
        // A repeat run writes no fresh outbox work for unchanged rows.
        expect(counts.aanvragen).toHaveLength(0);
      }, 30_000);

      it(`a changed ${spec.bronSlug} detail payload produces a new observation, a new aanvraag_versie and an updated curated row`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        const [targetRef] = spec.fixtureReferenties;
        if (!targetRef) {
          throw new Error(`${spec.bronSlug} has no fixture referenties`);
        }
        const targetUrl = Object.keys(spec.config.detailFixtures ?? {}).find(
          (url) =>
            new URL(url).pathname.replaceAll(/^\/+|\/+$/gu, "") === targetRef
        );
        if (!targetUrl) {
          throw new Error(`no detail fixture for ${targetRef}`);
        }
        const before = await bronRows(spec.bronId);
        const targetBefore = before.aanvragen.find(
          (row) => row.bronReferentie === targetRef
        );
        if (!targetBefore) {
          throw new Error(`no curated aanvraag for ${targetRef}`);
        }

        // One recorded detail body changes at the source (title bump — a real
        // field the normaliser reads into `titel`), so its contentHash changes
        // and the observation is `changed`, not `unchanged`.
        const mutatedTitle = `${targetBefore.titel} (CTP-638 gewijzigd)`;
        const { job, takes } = await driveJob(spec, {
          connector: () =>
            scopedFixtureConnector(spec, {
              mutateDetail: {
                mutate: (payload) => ({
                  ...payload,
                  jobPosting: payload.jobPosting
                    ? { ...payload.jobPosting, title: mutatedTitle }
                    : payload.jobPosting,
                }),
                url: targetUrl,
              },
            }),
        });

        const row = await jobRow(job.scrapeRunId);
        expect(row).toMatchObject({ attempts: 1, completed: true });
        expect(takes).toBe(1);

        const counts = await runRows(job.scrapeRunId);
        const expected = spec.fixtureReferenties.length;
        expect(counts.observations).toHaveLength(expected);
        const byOutcome = (outcome: string) =>
          counts.observations
            .filter((observation) => observation.outcome === outcome)
            .map((observation) => observation.bronReferentie);
        expect(byOutcome("changed")).toEqual([targetRef]);
        expect(byOutcome("unchanged").toSorted()).toEqual(
          spec.fixtureReferenties.filter((ref) => ref !== targetRef).toSorted()
        );

        // Readback: the curated row moved to the new payload — versie bumped,
        // titel updated, and a second aanvraag_versie row exists.
        const after = await bronRows(spec.bronId);
        const targetAfter = after.aanvragen.find(
          (aanvraagRow) => aanvraagRow.id === targetBefore.id
        );
        expect(targetAfter).toMatchObject({
          titel: mutatedTitle,
          versie: targetBefore.versie + 1,
        });
        const targetVersies = after.versies.filter(
          (versie) => versie.aanvraagId === targetBefore.id
        );
        expect(targetVersies.map((versie) => versie.versie).toSorted()).toEqual(
          Array.from(
            { length: targetBefore.versie + 1 },
            (_value, index) => index + 1
          )
        );
        // Still exactly one aanvraag per referentie — change is a version, not
        // a duplicate.
        expect(after.aanvragen).toHaveLength(expected);
      }, 30_000);

      it(`a failed ${spec.bronSlug} listing read closes the run failed; the durable retake re-enumerates the whole corpus exactly once`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        const listingCalls = { count: 0 };
        const detailCalls: string[] = [];
        // The request layer retries a failed discover up to its maxAttempts
        // budget (3 calls) inside one run; the scripted outage must outlast
        // exactly that budget so the durable queue's retake — not the in-run
        // retry — is the thing under test.
        const listingFailuresLeft = { current: 3 };
        const statusAtAttempt2: (string | undefined)[] = [];

        const { job, takes } = await driveJob(spec, {
          connector: () =>
            scopedFixtureConnector(spec, {
              detailCalls,
              listingCalls,
              listingFailuresLeft,
            }),
          onAttempt: async (attempt, scrapeRunId) => {
            if (attempt === 2) {
              const [run] = await runState(scrapeRunId);
              statusAtAttempt2.push(run?.status);
            }
          },
        });

        const row = await jobRow(job.scrapeRunId);
        expect(row).toMatchObject({ completed: true });
        expect(row?.last_failure).toBeNull();
        expect(takes).toBe(2);

        // Attempt 2 found the run row `failed` (DISCOVER_FAILED) and reopened
        // it under a new fence (reopenFailed, CTP-643).
        expect(statusAtAttempt2).toEqual(["failed"]);
        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");
        expect(run?.fenceToken).toBe(2);
        expect(run?.checkpoint).toEqual({});

        // Whole-corpus re-enumeration: the retake reads the listing again and
        // re-fetches every detail — there is no page cursor to resume from.
        expect(listingCalls.count).toBe(4);
        expect(detailCalls).toHaveLength(spec.discoveredReferenties.length);

        const counts = await runRows(job.scrapeRunId);
        // Exactly-once across the retake: each persisted bronReferentie has one
        // source record and one committed observation under this scrapeRunId.
        expect(counts.observations).toHaveLength(
          spec.fixtureReferenties.length
        );
        expect(
          counts.sourceRecords.map((record) => record.bronReferentie).toSorted()
        ).toEqual(spec.fixtureReferenties.toSorted());
      }, 30_000);

      it(`an aborted ${spec.bronSlug} run closes failed mid-item; the retake re-enumerates and absorbs persisted items via the replay key`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        const listingCalls = { count: 0 };
        const detailCalls: string[] = [];
        const attemptControllers: AbortController[] = [];
        const runAtAttempt2: (
          | {
              failureCode: string | null;
              failurePhase: string | null;
              status: string;
            }
          | undefined
        )[] = [];

        const { job, takes } = await driveJob(spec, {
          connector: () =>
            scopedFixtureConnector(spec, {
              abortOnDetailCall: spec.abortOnDetailCall,
              attemptControllers,
              detailCalls,
              listingCalls,
            }),
          onAttempt: async (attempt, scrapeRunId) => {
            if (attempt === 2) {
              const [run] = await runState(scrapeRunId);
              runAtAttempt2.push(run);
            }
          },
          signalFor: () => {
            const attemptController = new AbortController();
            attemptControllers.push(attemptController);
            return attemptController.signal;
          },
        });

        const row = await jobRow(job.scrapeRunId);
        expect(row).toMatchObject({ completed: true });
        expect(row?.last_failure).toBeNull();
        // Attempt 1 dies mid-item on the abort; attempt 2 retakes the job.
        expect(takes).toBe(2);

        // CTP-490 semantics, observed: the abort lands inside the persisted
        // item's raw-store write, which is never a "benign run abort" — the row
        // closes `failed` (RAW_STORE_WRITE_FAILED). With no page committed
        // there is no checkpoint to resume from, so the retake's reopenFailed
        // re-enumerates the whole corpus: the sitemap is read again and every
        // detail is re-fetched; already-persisted items dedupe through the
        // observation replay key (scrapeRunId + bronReferentie + contentHash).
        // No loss, exactly-once.
        expect(runAtAttempt2).toHaveLength(1);
        expect(runAtAttempt2[0]).toMatchObject({
          failureCode: "RAW_STORE_WRITE_FAILED",
          failurePhase: "raw-store",
          status: "failed",
        });

        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");
        expect(run?.fenceToken).toBe(2);
        expect(run?.checkpoint).toEqual({});

        // Both attempts read the listing once; details are fetched once per
        // attempt — the retake re-reads every detail the corpus still lists.
        expect(listingCalls.count).toBe(2);
        expect(detailCalls.length).toBe(
          spec.abortOnDetailCall + spec.discoveredReferenties.length
        );

        const counts = await runRows(job.scrapeRunId);
        // Every persisted listing item lands exactly once despite the full
        // re-read: anything attempt 1 stored was absorbed by the observation
        // replay dedupe.
        expect(counts.observations).toHaveLength(
          spec.fixtureReferenties.length
        );
        expect(
          counts.sourceRecords.map((record) => record.bronReferentie).toSorted()
        ).toEqual(spec.fixtureReferenties.toSorted());
      }, 30_000);
    };

    for (const spec of SPECS) {
      registerSpecs(spec);
    }
  }
);
