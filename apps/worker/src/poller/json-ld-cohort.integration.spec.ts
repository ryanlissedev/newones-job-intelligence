import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Connector } from "@ji/connectors";
import {
  bluetrailConfig,
  createJsonLdClient,
  createJsonLdConnector,
  heroConfig,
  proActConfig,
} from "@ji/connectors/json-ld";
import type {
  JsonLdClient,
  JsonLdConnectorConfig,
} from "@ji/connectors/json-ld";
import {
  aanvraag,
  alert,
  bron,
  bronHealth,
  scrapeRun,
} from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { aanvraagObservation, sourceRecord } from "@ji/db/schema/staging";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { eq } from "drizzle-orm";
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
 * CTP-630 JSON-LD-cohort proof: BlueTrail, Hero.eu and Pro-Act IT on the
 * durable ingest path (`curated.durable_job` + `runDurableBronJobConsumer` +
 * `runBronIngestPipeline`) against real Postgres — fixture clients for the
 * registry path, scripted whole-corpus feeds for retake/abort evidence.
 *
 * Unlike the feed cohort (CTP-629) these connectors have single-page
 * discovery: `discover()` returns every detail URL with `hasMore: false` and
 * an inert `checkpoint: {}`. A durable retake therefore re-enumerates the
 * WHOLE corpus and re-fetches every detail page; exactly-once is carried by
 * the observation replay key (scrapeRunId + bronReferentie + contentHash),
 * not by page-cursor resume. These specs assert that honestly.
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
  BLUETRAIL_LIVE: process.env.BLUETRAIL_LIVE,
  DATABASE_URL: process.env.DATABASE_URL,
  HERO_LIVE: process.env.HERO_LIVE,
  PROACT_LIVE: process.env.PROACT_LIVE,
  RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
  SEARCH_PROJECTOR: process.env.SEARCH_PROJECTOR,
};
// poll-bron-run validates `DATABASE_URL` at import time; point it at the same
// database before the dynamic import below (mirrors abort-finalization).
process.env.DATABASE_URL ??= applicationUrl;
process.env.SEARCH_PROJECTOR = "onbox";
// Raw payloads land in a throwaway filesystem store, never the repo .data dir.
process.env.RAW_OBJECT_STORE_PATH ??= `${process.env.TMPDIR ?? "/tmp"}/ji-jsonld-cohort-raw-${process.pid}`;
// All three connectors must stay in fixture mode — no live egress from tests.
delete process.env.BLUETRAIL_LIVE;
delete process.env.HERO_LIVE;
delete process.env.PROACT_LIVE;

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
  readonly bronId: string;
  readonly bronSlug: SliceABronSlug;
  readonly categorie: string;
  readonly config: JsonLdConnectorConfig;
  /** bronReferenties the committed listing fixture enumerates. */
  readonly fixtureReferenties: readonly string[];
  readonly naam: string;
}

const BLUETRAIL: BronSpec = {
  bronId: "00000000-0000-4000-8000-000000000006",
  bronSlug: "bluetrail",
  categorie: "msp_broker",
  config: bluetrailConfig,
  fixtureReferenties: [
    "opdrachten/Interim/adviseur-privacy-ibd",
    "opdrachten/Interim/ciam-tester",
    "opdrachten/Interim/systeembeheerder",
  ],
  naam: "BlueTrail",
};
const HERO: BronSpec = {
  bronId: "00000000-0000-4000-8000-000000000004",
  bronSlug: "hero",
  categorie: "msp_broker",
  config: heroConfig,
  fixtureReferenties: [
    "interim-opdrachten/devops-engineer-1f2fde9f",
    "interim-opdrachten/front-end-developer-9c99b237",
  ],
  naam: "Hero.eu",
};
const PRO_ACT: BronSpec = {
  bronId: "00000000-0000-4000-8000-000000000005",
  bronSlug: "pro-act",
  categorie: "msp_broker",
  config: proActConfig,
  fixtureReferenties: [
    "vacatures/iso-8783",
    "vacatures/senior-azure-operations-engineer-8793",
  ],
  naam: "Pro-Act IT",
};

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
 * A connector over the committed fixture corpus whose `fetchListing` can be
 * scripted to fail (`listingFailuresLeft` — must outlast the in-run retry
 * budget of 3 so the durable retake, not the retry, is what recovers) and
 * whose `fetchDetail` aborts the attempt's signal inside one item's read.
 * Detail reads always delegate to the real fixture client, so persisted
 * payloads stay real recordings.
 */
const scriptedConnector = (
  spec: BronSpec,
  options: {
    abortOnDetailCall?: number;
    attemptControllers?: AbortController[];
    detailCalls?: string[];
    listingCalls?: { count: number };
    listingFailuresLeft?: { current: number };
  }
): Connector => {
  const fixtureClient: JsonLdClient = createJsonLdClient({
    config: spec.config,
    liveEnabled: false,
  });
  const jsonLdClient: JsonLdClient = {
    fetchDetail: (url, signal) => {
      options.detailCalls?.push(url);
      // `detailCalls` is shared across attempts (the factory runs per take),
      // so the abort fires exactly once — on the run's Nth detail read ever —
      // never again on the retake.
      if (options.abortOnDetailCall === options.detailCalls?.length) {
        options.attemptControllers?.at(-1)?.abort();
      }
      return fixtureClient.fetchDetail(url, signal);
    },
    fetchListing: (signal) => {
      if (options.listingCalls) {
        options.listingCalls.count += 1;
      }
      const failures = options.listingFailuresLeft;
      if (failures && failures.current > 0) {
        failures.current -= 1;
        return Promise.reject(new Error("scripted listing failure"));
      }
      return fixtureClient.fetchListing(signal);
    },
  };
  return createJsonLdConnector({
    bronId: spec.bronId,
    client: jsonLdClient,
    config: spec.config,
  });
};

describe.serial("JSON-LD cohort on the durable ingest path (CTP-630)", () => {
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
    await seedBron(BLUETRAIL);
    await seedBron(HERO);
    await seedBron(PRO_ACT);
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
        .select({ outcome: aanvraagObservation.outcome })
        .from(aanvraagObservation)
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

  interface DriveOptions {
    /** Replaces the registry connector — failure injection + scripted feeds. */
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
    it(`runs ${spec.bronSlug} end-to-end through the durable queue into curated aanvragen`, async () => {
      if (!available) {
        expect(available).toBe(false);
        return;
      }
      // Registry-built connector: fixture mode (live env unset), real client.
      const { job, takes } = await driveJob(spec);

      const row = await jobRow(job.scrapeRunId);
      expect(row).toMatchObject({ attempts: 1, completed: true });
      expect(row?.last_failure).toBeNull();
      expect(takes).toBe(1);

      const [run] = await runState(job.scrapeRunId);
      expect(run?.status).toBe("succeeded");
      expect(run?.fenceToken).toBe(1);
      // Single-page discovery committed its inert empty checkpoint.
      expect(run?.checkpoint).toEqual({});

      const counts = await runRows(job.scrapeRunId);
      const expected = spec.fixtureReferenties.length;
      expect(counts.observations).toHaveLength(expected);
      expect(
        counts.sourceRecords.map((r) => r.bronReferentie).toSorted()
      ).toEqual(spec.fixtureReferenties.toSorted());
      expect(counts.aanvragen).toEqual(spec.fixtureReferenties.toSorted());
      // No tombstone bookkeeping on a complete first run.
      expect(
        counts.sourceRecords.every((record) => record.missedPolls === 0)
      ).toBe(true);
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
          scriptedConnector(spec, {
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
      expect(detailCalls).toHaveLength(spec.fixtureReferenties.length);

      const counts = await runRows(job.scrapeRunId);
      // Exactly-once across the retake: each bronReferentie has one source
      // record and one committed observation under this scrapeRunId.
      expect(counts.observations).toHaveLength(spec.fixtureReferenties.length);
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
          scriptedConnector(spec, {
            abortOnDetailCall: 2,
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
      // re-enumerates the whole corpus: the sitemap/listing is read again and
      // every detail is re-fetched; already-persisted items dedupe through
      // the observation replay key (scrapeRunId + bronReferentie +
      // contentHash). No loss, exactly-once.
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
      expect(detailCalls.length).toBe(2 + spec.fixtureReferenties.length);

      const counts = await runRows(job.scrapeRunId);
      // Every listing item lands exactly once despite the full re-read: the
      // attempt-1 item was absorbed by the observation replay dedupe.
      expect(counts.observations).toHaveLength(spec.fixtureReferenties.length);
      expect(
        counts.sourceRecords.map((record) => record.bronReferentie).toSorted()
      ).toEqual(spec.fixtureReferenties.toSorted());
    }, 30_000);
  };

  for (const spec of [BLUETRAIL, HERO, PRO_ACT]) {
    registerSpecs(spec);
  }
});
