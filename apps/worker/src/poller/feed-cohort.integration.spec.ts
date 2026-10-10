import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Connector } from "@ji/connectors";
import { createInhuurdeskConnector } from "@ji/connectors/inhuurdesk";
import type {
  InhuurdeskAssignment,
  InhuurdeskClient,
} from "@ji/connectors/inhuurdesk";
import {
  createTenderNedClient,
  createTenderNedConnector,
} from "@ji/connectors/tenderned";
import type {
  TenderNedClient,
  TenderNedListingItem,
} from "@ji/connectors/tenderned";
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
 * CTP-629 feed-cohort proof: TenderNed and Inhuurdesk on the durable ingest
 * path (`curated.durable_job` + `runDurableBronJobConsumer` +
 * `runBronIngestPipeline`) against real Postgres — fixture clients for the
 * registry path, scripted multi-page feeds for resume/abort evidence.
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
  INHUURDESK_LIVE: process.env.INHUURDESK_LIVE,
  RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
  SEARCH_PROJECTOR: process.env.SEARCH_PROJECTOR,
  TENDER_NED_LIVE: process.env.TENDER_NED_LIVE,
};
// poll-bron-run validates `DATABASE_URL` at import time; point it at the same
// database before the dynamic import below (mirrors abort-finalization).
process.env.DATABASE_URL ??= applicationUrl;
process.env.SEARCH_PROJECTOR = "onbox";
// Raw payloads land in a throwaway filesystem store, never the repo .data dir.
process.env.RAW_OBJECT_STORE_PATH ??= `${process.env.TMPDIR ?? "/tmp"}/ji-feed-cohort-raw-${process.pid}`;
// Both connectors must stay in fixture mode — no live egress from tests.
delete process.env.TENDER_NED_LIVE;
delete process.env.INHUURDESK_LIVE;

const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
};

const TENDERNED_ID = "00000000-0000-4000-8000-000000000001";
const INHUURDESK_ID = "00000000-0000-4000-8000-000000000002";

interface BronSpec {
  readonly bronId: string;
  readonly bronSlug: SliceABronSlug;
  readonly categorie: string;
  readonly naam: string;
}

const TENDERNED: BronSpec = {
  bronId: TENDERNED_ID,
  bronSlug: "tenderned",
  categorie: "overheidsportaal",
  naam: "TenderNed",
};
const INHUURDESK: BronSpec = {
  bronId: INHUURDESK_ID,
  bronSlug: "inhuurdesk",
  categorie: "msp_broker",
  naam: "Inhuurdesk",
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

const tnItem = (
  kenmerk: string,
  publicatieId: string
): TenderNedListingItem => ({
  aanbestedingNaam: `Aanbesteding ${kenmerk}`,
  aankondigingCode: { code: "AAO" },
  kenmerk,
  numberOfDaysBeforeAanmeldenInschrijven: 10,
  publicatieDatum: "2026-09-19",
  publicatieId,
});

/** One item per page; details resolve to the committed real fixture. */
const pagedTenderNedClient = (
  calls: number[],
  corpus: TenderNedListingItem[]
): TenderNedClient => {
  const fixtureDetails = createTenderNedClient({ liveEnabled: false });
  return {
    fetchDetail: () => fixtureDetails.fetchDetail("fixture-pub-001"),
    fetchListing: (page) => {
      calls.push(page);
      return Promise.resolve({
        content: corpus.slice(page, page + 1),
        first: page === 0,
        last: page >= corpus.length - 1,
        number: page,
        size: 1,
        totalElements: corpus.length,
        totalPages: corpus.length,
      });
    },
  };
};

const ihAssignment = (id: string, suffix: string): InhuurdeskAssignment => ({
  clientName: "Gemeente Test",
  closingDateClient: "2026-10-01T12:00:00",
  content: `<p>Beschrijving ${suffix}</p>`,
  id,
  location: "Utrecht",
  publishedDate: "2026-09-19T10:00:00",
  referenceCode: `SRQ-${suffix}`,
  title: `Opdracht ${suffix}`,
});

const IH_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

/** Two items per page, 1-indexed and total-bounded like the live API. */
const pagedInhuurdeskClient = (calls: number[]): InhuurdeskClient => {
  const corpus = IH_IDS.map((id, index) => ihAssignment(id, `IH-${index}`));
  return {
    fetchListing: (page) => {
      calls.push(page);
      return Promise.resolve({
        data: corpus.slice((page - 1) * 2, page * 2),
        total: corpus.length,
      });
    },
  };
};

interface JobRow {
  readonly attempts: number;
  readonly completed: boolean;
  readonly id: string;
  readonly last_failure: string | null;
}

describe.serial("feed cohort on the durable ingest path (CTP-629)", () => {
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
    await seedBron(TENDERNED);
    await seedBron(INHUURDESK);
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
    /** Signal factory per queue take (attempt index is 1-based). */
    readonly signalFor?: (attempt: number) => AbortSignal | undefined;
    /** Replaces the registry connector — failure injection + paged feeds. */
    readonly connector?: () => Connector;
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
        processJob: async (runningJob, attempts) => {
          takes += 1;
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
            { signal: options.signalFor?.(attempts) }
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

  const pagedConnector = (spec: BronSpec, calls: number[]): Connector => {
    if (spec.bronSlug === "tenderned") {
      return createTenderNedConnector({
        // SAFETY: spec.bronId is the literal seeded for this spec's bron row.
        bronId: spec.bronId as BronId,
        client: pagedTenderNedClient(calls, [
          tnItem("TN-DURABLE-A", "pub-durable-a"),
          tnItem("TN-DURABLE-B", "pub-durable-b"),
          tnItem("TN-DURABLE-C", "pub-durable-c"),
        ]),
      });
    }
    return createInhuurdeskConnector({
      // SAFETY: spec.bronId is the literal seeded for this spec's bron row.
      bronId: spec.bronId as BronId,
      client: pagedInhuurdeskClient(calls),
    });
  };

  const expectedReferenties = (spec: BronSpec): string[] =>
    spec.bronSlug === "tenderned"
      ? ["TN-DURABLE-A", "TN-DURABLE-B", "TN-DURABLE-C"].toSorted()
      : [...IH_IDS].toSorted();

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

      const counts = await runRows(job.scrapeRunId);
      // Fixture corpora: tenderned 1 record, inhuurdesk 4 records.
      const expected = spec.bronSlug === "tenderned" ? 1 : 4;
      expect(counts.observations).toHaveLength(expected);
      expect(counts.sourceRecords).toHaveLength(expected);
      expect(counts.aanvragen).toHaveLength(expected);
      // No tombstone bookkeeping on a complete first run.
      expect(
        counts.sourceRecords.every((record) => record.missedPolls === 0)
      ).toBe(true);
    }, 30_000);

    it(`resumes ${spec.bronSlug} from the persisted page checkpoint after a connector failure`, async () => {
      if (!available) {
        expect(available).toBe(false);
        return;
      }
      const calls: number[] = [];
      // The request layer retries a failed discover up to its maxAttempts
      // budget (3 calls) inside one run; a transient listing outage must
      // outlast exactly that budget so the durable queue's retake — not the
      // in-run retry — is the thing under test.
      let failuresLeft = 3;
      const resumePage = spec.bronSlug === "tenderned" ? 1 : 2;
      const connector = (): Connector => {
        const paged = pagedConnector(spec, calls);
        return {
          bronId: paged.bronId,
          discover: (checkpoint, signal) => {
            if (checkpoint?.page === resumePage && failuresLeft > 0) {
              failuresLeft -= 1;
              return Promise.reject(new Error("scripted listing-page failure"));
            }
            return paged.discover(checkpoint, signal);
          },
          fetch: (item, signal) => paged.fetch(item, signal),
        };
      };

      const { job, takes } = await driveJob(spec, { connector });

      const row = await jobRow(job.scrapeRunId);
      expect(row).toMatchObject({ completed: true });
      expect(row?.last_failure).toBeNull();
      expect(takes).toBe(2);

      const [run] = await runState(job.scrapeRunId);
      // One run row, reopened on the retake (fence 2), finished once.
      expect(run?.status).toBe("succeeded");
      expect(run?.fenceToken).toBe(2);

      // The failed listing call threw before the client saw it; the retake
      // re-read only the failed page and the tail — earlier pages are never
      // re-fetched.
      const expectedCalls = spec.bronSlug === "tenderned" ? [0, 1, 2] : [1, 2];
      expect(calls).toEqual(expectedCalls);

      const counts = await runRows(job.scrapeRunId);
      // Exactly-once across the retake: each bronReferentie one source
      // record and one committed observation. The scripted minimal payloads
      // do not satisfy the aanvraag projection — curated output is proven by
      // the fixture-backed end-to-end test above.
      expect(
        counts.sourceRecords.map((record) => record.bronReferentie).toSorted()
      ).toEqual(expectedReferenties(spec));
      expect(counts.observations).toHaveLength(
        expectedReferenties(spec).length
      );
    }, 30_000);

    it(`an aborted ${spec.bronSlug} run closes with its checkpoint; the retake replays it and the job finishes`, async () => {
      if (!available) {
        expect(available).toBe(false);
        return;
      }
      const calls: number[] = [];
      const attemptControllers: AbortController[] = [];
      let itemsFetched = 0;
      const connector = (): Connector => {
        const paged = pagedConnector(spec, calls);
        return {
          bronId: paged.bronId,
          discover: (checkpoint, signal) => paged.discover(checkpoint, signal),
          fetch: (item, signal) => {
            // Abort the attempt while persisting the second item: the run
            // loop stops at the next page boundary and closes `aborted`.
            itemsFetched += 1;
            if (itemsFetched === 2) {
              attemptControllers.at(-1)?.abort();
            }
            return paged.fetch(item, signal);
          },
        };
      };

      const { job, takes } = await driveJob(spec, {
        connector,
        signalFor: () => {
          const attemptController = new AbortController();
          attemptControllers.push(attemptController);
          return attemptController.signal;
        },
      });

      const row = await jobRow(job.scrapeRunId);
      expect(row).toMatchObject({ completed: true });
      expect(row?.last_failure).toBeNull();
      // Attempt 1 dies mid-fetch on the abort; attempt 2 resumes it.
      expect(takes).toBe(2);

      const [run] = await runState(job.scrapeRunId);
      // CTP-490 semantics, observed: the abort lands inside the persisted
      // item's raw-store write, which is never a "benign run abort" — the
      // row closes `failed` at its last committed page checkpoint. The
      // durable retake then RESUMES from that checkpoint (reopenFailed):
      // the aborted page is re-read (already-persisted items dedupe through
      // the observation replay check) and the listing tail is fetched. The
      // retake's result carries completeness `resumed`, not `aborted`, so
      // the pipeline curates and finishes the job.
      expect(run?.status).toBe("succeeded");
      expect(run?.fenceToken).toBe(2);
      expect(run?.checkpoint).toEqual(
        spec.bronSlug === "tenderned" ? { page: 3 } : { page: 3, pageSize: 2 }
      );
      // The retake re-read only the aborted page and the tail — earlier
      // committed pages are never re-fetched.
      const expectedCalls =
        spec.bronSlug === "tenderned" ? [0, 1, 1, 2] : [1, 1, 2];
      expect(calls).toEqual(expectedCalls);

      const counts = await runRows(job.scrapeRunId);
      // Every listing item lands exactly once despite the re-read page; the
      // re-fetched item is absorbed by the observation replay dedupe.
      expect(counts.observations).toHaveLength(
        expectedReferenties(spec).length
      );
      expect(
        counts.sourceRecords.map((record) => record.bronReferentie).toSorted()
      ).toEqual(expectedReferenties(spec));
    }, 30_000);
  };

  for (const spec of [TENDERNED, INHUURDESK]) {
    registerSpecs(spec);
  }
});
