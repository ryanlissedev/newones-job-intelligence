import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Connector } from "@ji/connectors";
import {
  createHarveyNashClient,
  createHarveyNashConnector,
} from "@ji/connectors/harveynash";
import type { HarveyNashClient } from "@ji/connectors/harveynash";
import {
  createJsonLdClient,
  createJsonLdConnector,
  haysConfig,
} from "@ji/connectors/json-ld";
import type { JsonLdClient } from "@ji/connectors/json-ld";
import {
  createNeedstaffingClient,
  createNeedstaffingConnector,
} from "@ji/connectors/needstaffing";
import type { NeedstaffingClient } from "@ji/connectors/needstaffing";
import {
  createOnefellowClient,
  createOnefellowConnector,
} from "@ji/connectors/onefellow";
import type { OnefellowClient } from "@ji/connectors/onefellow";
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
 * CTP-640 L3d MIXED-ADAPTER cohort proof: Harvey Nash (paged Bullhorn
 * search API + SSR detail), Hays (JSON-LD HTML listing + detail), Need
 * Staffing IT (paged HTML listing + detail) and Onefellow (single-call
 * private JSON API, no detail request) on the durable ingest path
 * (`curated.durable_job` + `runDurableBronJobConsumer` +
 * `runBronIngestPipeline`) against real Postgres — the committed fixture
 * clients for detail reads, scripted listing clients for retake/abort
 * evidence.
 *
 * The four connectors do NOT share one resume contract — the per-adapter
 * truth, asserted rather than assumed below:
 *
 * - harveynash: a REAL page cursor `{page, pageSize}` driven by the
 *   search API's `total_size` (cap 50, `truncated` at the cap). A failed
 *   run's retake RESUMES at the committed page. `knownHashes` is
 *   deliberately NOT forwarded (`listingHashCoversDetail: false`).
 * - hays: the L3a/L3b/L3e single-pass shape — one static listing page,
 *   `hasMore: false`, inert `checkpoint: {}`, whole-corpus re-enumeration
 *   on every retake.
 * - needstaffing: a REAL page cursor `{page}` driven by `hasNextPage`
 *   (cap 20, `truncated` at the cap); `knownHashes` deliberately not
 *   forwarded.
 * - onefellow: one unpaginated JSON call; `hasMore: false`, inert `{}`,
 *   `fetchUsesNetwork: false` (fetch re-serialises the listing job), and
 *   the registry DOES forward `knownHashes`
 *   (`listingHashCoversDetail: true`) — an unchanged repeat poll writes
 *   ZERO observations, the ctm-shaped dedupe-before-recorder contract.
 *
 * Fixture scoping, stated plainly: every persisted payload is a real
 * committed recording. harveynash's committed listing carries exactly one
 * recorded job (452d25a3-…), the only job with a recorded detail page —
 * the scripted client serves it on page 0 and an empty page 1 so the
 * committed checkpoint is a real `{page:2,pageSize:1}` cursor. needstaffing
 * gets a scripted two-page corpus built from the live listing fixture's
 * real items (15574 on page 0, 15601 on page 1), both detail-backed by
 * committed fixtures. onefellow's whole six-job response persists —
 * there is no detail read to scope. hays is the L3e shape: the real
 * parsed listing page filtered to `detailFixtures` keys. Geen opgenomen
 * reject-fixture for any of the four.
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
  HARVEYNASH_LIVE: process.env.HARVEYNASH_LIVE,
  HAYS_LIVE: process.env.HAYS_LIVE,
  NEEDSTAFFING_LIVE: process.env.NEEDSTAFFING_LIVE,
  ONEFELLOW_LIVE: process.env.ONEFELLOW_LIVE,
  RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
  SEARCH_PROJECTOR: process.env.SEARCH_PROJECTOR,
};
// poll-bron-run validates `DATABASE_URL` at import time; point it at the same
// database before the dynamic import below (mirrors abort-finalization).
process.env.DATABASE_URL ??= applicationUrl;
process.env.SEARCH_PROJECTOR = "onbox";
// Raw payloads land in a throwaway filesystem store, never the repo .data dir.
process.env.RAW_OBJECT_STORE_PATH ??= `${process.env.TMPDIR ?? "/tmp"}/ji-l3d-cohort-raw-${process.pid}`;
// All four connectors must stay in fixture mode — no live egress from tests.
delete process.env.HARVEYNASH_LIVE;
delete process.env.HAYS_LIVE;
delete process.env.NEEDSTAFFING_LIVE;
delete process.env.ONEFELLOW_LIVE;

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
   * Fetch-call index (1-based across the whole job, shared between attempts)
   * whose read aborts the attempt's signal. For onefellow this counts
   * connector `fetch()` invocations (there is no detail request); for the
   * others it counts detail reads. needstaffing aborts on its page-1 item
   * so the failed row keeps the committed `{page:1}` checkpoint — the
   * retake then resumes mid-listing instead of re-enumerating.
   */
  readonly abortOnItemFetch: number;
  readonly bronId: string;
  readonly bronSlug: SliceABronSlug;
  readonly categorie: string;
  /** The scrape_run.checkpoint value a succeeded run commits — asserted per adapter. */
  readonly committedCheckpoint: unknown;
  /** bronReferenties the corpus enumerates (incl. rejects). */
  readonly discoveredReferenties: readonly string[];
  /** bronReferenties that persist: observations, source_records, aanvragen. */
  readonly fixtureReferenties: readonly string[];
  readonly naam: string;
  /** bronReferenties that discover but reject without an observation. */
  readonly rejectedReferenties: readonly string[];
  /**
   * False only for onefellow: `listingHashCoversDetail: true` + the
   * production known-hash wiring means an unchanged repeat poll skips
   * every fetch and writes NO observations — dedupe sits before the
   * recorder, not inside it.
   */
  readonly repeatRunWritesObservations: boolean;
  /**
   * True for the two paged connectors (harveynash, needstaffing): their
   * listing outage is scripted on the SECOND page so page 0's checkpoint
   * commits first and the retake resumes mid-listing.
   */
  readonly pagedResume: boolean;
  /** Listing-call sequence a full successful job produces. */
  readonly listingCallsClean: readonly number[];
  /** Listing-call sequence across the failed+retaken job. */
  readonly listingCallsOnFail: readonly number[];
  /** Listing-call sequence across the aborted+retaken job. */
  readonly listingCallsOnAbort: readonly number[];
  /** The failed row's checkpoint at retake — real cursor for paged, null otherwise. */
  readonly failedCheckpointOnFail: unknown;
  readonly failedCheckpointOnAbort: unknown;
}

const HARVEYNASH: BronSpec = {
  // The committed listing fixture carries exactly one recorded job; the
  // abort lands inside its only detail read — nothing persists, the failed
  // row holds the null checkpoint, the retake re-reads both pages.
  abortOnItemFetch: 1,
  bronId: "00000000-0000-4000-8000-000000000007",
  bronSlug: "harveynash",
  categorie: "intermediair",
  // Page 0 served the one recorded result (total_size 31 → hasMore), page 1
  // answered empty — the last committed checkpoint is the real cursor.
  committedCheckpoint: { page: 2, pageSize: 1 },
  discoveredReferenties: ["452d25a3-ae7d-4ee6-9ceb-3c696332799f"],
  failedCheckpointOnAbort: null,
  // The listing outage is scoped to page 1: page 0's real cursor
  // {page:1,pageSize:1} commits first, so the retake RESUMES at page 1.
  failedCheckpointOnFail: { page: 1, pageSize: 1 },
  fixtureReferenties: ["452d25a3-ae7d-4ee6-9ceb-3c696332799f"],
  listingCallsClean: [0, 1],
  // The abort lands inside page 0's only detail read — page 1 is never
  // reached on attempt 1; the retake re-reads both pages.
  listingCallsOnAbort: [0, 0, 1],
  listingCallsOnFail: [0, 1, 1, 1, 1],
  naam: "Harvey Nash",
  pagedResume: true,
  rejectedReferenties: [],
  repeatRunWritesObservations: true,
};
const HAYS: BronSpec = {
  abortOnItemFetch: 2,
  bronId: "00000000-0000-4000-8000-00000000001a",
  bronSlug: "hays",
  categorie: "intermediair",
  committedCheckpoint: {},
  discoveredReferenties: [
    "vacature-details/buyer-sports-and-outdoor-amsterdam_1050471",
    "vacature-details/finance-business-partner-rotterdam_1050462",
    "vacature-details/scrum-master-provincie-utrecht_1049921",
  ],
  failedCheckpointOnAbort: null,
  failedCheckpointOnFail: null,
  fixtureReferenties: [
    "vacature-details/buyer-sports-and-outdoor-amsterdam_1050471",
    "vacature-details/finance-business-partner-rotterdam_1050462",
    "vacature-details/scrum-master-provincie-utrecht_1049921",
  ],
  listingCallsClean: [1],
  listingCallsOnAbort: [1, 1],
  listingCallsOnFail: [1, 1, 1, 1],
  naam: "Hays",
  pagedResume: false,
  rejectedReferenties: [],
  repeatRunWritesObservations: true,
};
const NEEDSTAFFING: BronSpec = {
  // Detail call 2 is the page-1 item (15601): page 0's checkpoint has
  // already committed when the abort lands, so the failed row holds a REAL
  // resume cursor.
  abortOnItemFetch: 2,
  bronId: "00000000-0000-4000-8000-000000000003",
  bronSlug: "needstaffing",
  categorie: "intermediair",
  // Page 1 reports hasNextPage:false, so discovery ends there — the last
  // committed checkpoint carries the NEXT page index (2).
  committedCheckpoint: { page: 2 },
  discoveredReferenties: ["15574", "15601"],
  failedCheckpointOnAbort: { page: 1 },
  failedCheckpointOnFail: { page: 1 },
  fixtureReferenties: ["15574", "15601"],
  listingCallsClean: [0, 1],
  listingCallsOnAbort: [0, 1, 1],
  listingCallsOnFail: [0, 1, 1, 1, 1],
  naam: "Need Staffing IT",
  pagedResume: true,
  rejectedReferenties: [],
  repeatRunWritesObservations: true,
};
const ONEFELLOW: BronSpec = {
  abortOnItemFetch: 2,
  bronId: "00000000-0000-4000-8000-000000000009",
  bronSlug: "onefellow",
  categorie: "intermediair",
  committedCheckpoint: {},
  discoveredReferenties: ["920", "1029", "1030", "1032", "944", "1006"],
  failedCheckpointOnAbort: null,
  failedCheckpointOnFail: null,
  fixtureReferenties: ["920", "1029", "1030", "1032", "944", "1006"],
  listingCallsClean: [1],
  listingCallsOnAbort: [1, 1],
  listingCallsOnFail: [1, 1, 1, 1],
  naam: "Onefellow",
  pagedResume: false,
  rejectedReferenties: [],
  repeatRunWritesObservations: false,
};

const SPECS: readonly BronSpec[] = [HARVEYNASH, HAYS, NEEDSTAFFING, ONEFELLOW];
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

interface ScriptOptions {
  /**
   * Fetch-call index whose read aborts the attempt's signal (see
   * `BronSpec.abortOnItemFetch`).
   */
  readonly abortOnItemFetch?: number;
  readonly attemptControllers?: AbortController[];
  /** Per-adapter call log: connector fetches (onefellow) or detail reads (others). */
  readonly detailCalls?: string[];
  /** Page numbers read per listing call — [1] repeated for single-page sources. */
  readonly listingCalls?: number[];
  /**
   * Scripted outage: fails this many listing reads before succeeding — must
   * outlast the in-run retry budget (3) so the durable retake, not the
   * retry, is what recovers. `listingFailurePage` scopes the outage to one
   * page — the paged connectors (harveynash, needstaffing) fail on their
   * SECOND page so page 0's checkpoint commits first.
   */
  readonly listingFailuresLeft?: { current: number };
  readonly listingFailurePage?: number;
  /** bronReferentie whose persisted payload mutates at the source. */
  readonly mutateReferentie?: string;
  readonly mutatedTitle?: string;
  /**
   * onefellow only: build the connector WITHOUT the production
   * `knownHashes` store. Used by the two failure-injection tests — the
   * durable contract under test there is the observation replay key +
   * `reopenFailed` retake, while the known-hash early-exit (which would
   * legitimately shrink, never duplicate, the retake's observation set —
   * and would couple this test to accumulated cross-run state) is pinned
   * separately by the repeat-run spec. Every other onefellow test wires
   * the store exactly as the registry does.
   */
  readonly omitKnownHashes?: boolean;
}

const MUTATED_SUFFIX = " (CTP-640 gewijzigd)";

describe.serial(
  "L3d mixed-adapter cohort on the durable ingest path (CTP-640)",
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
          rejected: scrapeRun.rejected,
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

    /**
     * harveynash: the committed listing fixture holds exactly one recorded
     * job (452d25a3-…, the only job with a recorded detail page), served on
     * page 0; page 1 answers empty — the real cursor {page:2,pageSize:1}
     * commits. The page-0 outage scripts the DISCOVER_FAILED retake.
     */
    const scopedHarveynashConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: HarveyNashClient = createHarveyNashClient({
        liveEnabled: false,
      });
      const harveynashClient: HarveyNashClient = {
        fetchDetail: async (jobId, detailUrl) => {
          options.detailCalls?.push(jobId);
          if (options.abortOnItemFetch === options.detailCalls?.length) {
            options.attemptControllers?.at(-1)?.abort();
          }
          const fragment = await fixtureClient.fetchDetail(jobId, detailUrl);
          if (options.mutateReferentie !== jobId || !options.mutatedTitle) {
            return fragment;
          }
          // Swap the JobPosting JSON-LD title — the normaliser reads titel
          // from `detail.jsonLd.title` first.
          return {
            ...fragment,
            jsonLd: { ...fragment.jsonLd, title: options.mutatedTitle },
          };
        },
        fetchListing: (page) => {
          options.listingCalls?.push(page);
          const failures = options.listingFailuresLeft;
          const failurePage = options.listingFailurePage ?? 0;
          if (failures && failures.current > 0 && page === failurePage) {
            failures.current -= 1;
            throw new Error(`scripted listing page-${page} failure`);
          }
          if (page === 0) {
            return fixtureClient.fetchListing(0);
          }
          return Promise.resolve({ results: [], total_size: 1 });
        },
      };
      // Mutating the recorded job's title moves BOTH the listing hash and
      // the payload's detail.title (the connector copies it) — the titel
      // readback assertion below depends on that.
      return createHarveyNashConnector({
        bronId: HARVEYNASH.bronId,
        client: harveynashClient,
      });
    };

    /**
     * hays: the L3e scoped-fixture shape — the real parsed listing page
     * filtered to `detailFixtures` keys; detail reads stay real recorded
     * fixtures.
     */
    const scopedHaysConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: JsonLdClient = createJsonLdClient({
        config: haysConfig,
        liveEnabled: false,
      });
      const detailBacked = new Set(
        Object.keys(haysConfig.detailFixtures ?? {})
      );
      const jsonLdClient: JsonLdClient = {
        fetchDetail: async (url, signal) => {
          options.detailCalls?.push(url);
          if (options.abortOnItemFetch === options.detailCalls?.length) {
            options.attemptControllers?.at(-1)?.abort();
          }
          const payload = await fixtureClient.fetchDetail(url, signal);
          if (options.mutatedTitle) {
            const referentie = new URL(url).pathname.replaceAll(
              /^\/+|\/+$/gu,
              ""
            );
            if (referentie === options.mutateReferentie) {
              return {
                ...payload,
                jobPosting: payload.jobPosting
                  ? { ...payload.jobPosting, title: options.mutatedTitle }
                  : payload.jobPosting,
              };
            }
          }
          return payload;
        },
        fetchListing: async (signal) => {
          options.listingCalls?.push(1);
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
        bronId: HAYS.bronId,
        client: jsonLdClient,
        config: haysConfig,
      });
    };

    /**
     * needstaffing: one of the two paged connectors. The scripted corpus
     * serves the live listing fixture's REAL items — 15574 on page 0 and
     * 15601 on page 1, both detail-backed by committed fixtures — so the
     * {page:1} checkpoint that commits between them drives an observable
     * mid-listing resume on the retake.
     */
    const scopedNeedstaffingConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: NeedstaffingClient = createNeedstaffingClient({
        listingFixturePath: "needstaffing/listing-live-2026-09-16.json",
        liveEnabled: false,
      });
      const needstaffingClient: NeedstaffingClient = {
        fetchDetailHtml: async (id) => {
          options.detailCalls?.push(id);
          if (options.abortOnItemFetch === options.detailCalls?.length) {
            options.attemptControllers?.at(-1)?.abort();
          }
          const html = await fixtureClient.fetchDetailHtml(id);
          if (options.mutateReferentie !== id || !options.mutatedTitle) {
            return html;
          }
          // Swap the `.page-header-vacancy h1` the detail parser reads for
          // `titel`.
          return html.replace(
            /(?<header><div[^>]*class="[^"]*page-header-vacancy[^"]*"[^>]*>[\s\S]*?<h1[^>]*>)[\s\S]*?(?<close><\/h1>)/u,
            `$<header>${options.mutatedTitle}$<close>`
          );
        },
        fetchListing: async (page) => {
          options.listingCalls?.push(page);
          const failures = options.listingFailuresLeft;
          const failurePage = options.listingFailurePage ?? 0;
          if (failures && failures.current > 0 && page === failurePage) {
            failures.current -= 1;
            throw new Error(`scripted listing page-${page} failure`);
          }
          // The real parsed live-listing fixture holds all 20 recorded
          // cards; this spec's two-page corpus serves the first two.
          const real = await fixtureClient.fetchListing(0);
          const at = (id: string) =>
            real.items.filter((item) => item.id === id);
          if (page === 0) {
            return { hasNextPage: true, items: at("15574") };
          }
          if (page === 1) {
            return { hasNextPage: false, items: at("15601") };
          }
          return { hasNextPage: false, items: [] };
        },
      };
      return createNeedstaffingConnector({
        bronId: NEEDSTAFFING.bronId,
        client: needstaffingClient,
      });
    };

    /**
     * onefellow: the ctm-shaped member — `fetchUsesNetwork: false` means
     * the connector's fetch does no upstream I/O, so abort/call scripting
     * wraps the CONNECTOR. `knownHashes` is forwarded — the exact registry
     * wiring (`listingHashCoversDetail: true`); the change vector is the
     * listing job itself (`title` mutates inside fetchListing).
     */
    const scopedOnefellowConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: OnefellowClient = createOnefellowClient({
        liveEnabled: false,
      });
      const onefellowClient: OnefellowClient = {
        fetchListing: async () => {
          options.listingCalls?.push(1);
          const failures = options.listingFailuresLeft;
          if (failures && failures.current > 0) {
            failures.current -= 1;
            throw new Error("scripted listing failure");
          }
          const jobs = await fixtureClient.fetchListing();
          const target = options.mutateReferentie;
          if (!(target && options.mutatedTitle)) {
            return jobs;
          }
          return jobs.map((listedJob) =>
            String(listedJob.joborder_id) === target
              ? { ...listedJob, title: options.mutatedTitle ?? listedJob.title }
              : listedJob
          );
        },
      };
      const inner = createOnefellowConnector({
        bronId: ONEFELLOW.bronId,
        client: onefellowClient,
        knownHashes: options.omitKnownHashes
          ? undefined
          : runtime?.knownHashStore,
      });
      return {
        bronId: inner.bronId,
        discover: (checkpoint, signal) => inner.discover(checkpoint, signal),
        fetch: (item, signal) => {
          options.detailCalls?.push(item.bronReferentie);
          if (options.abortOnItemFetch === options.detailCalls?.length) {
            options.attemptControllers?.at(-1)?.abort();
          }
          return inner.fetch(item, signal);
        },
        fetchUsesNetwork: inner.fetchUsesNetwork,
      };
    };

    const scopedFixtureConnector = (
      spec: BronSpec,
      options: ScriptOptions
    ): Connector => {
      switch (spec.bronSlug) {
        case "harveynash": {
          return scopedHarveynashConnector(options);
        }
        case "hays": {
          return scopedHaysConnector(options);
        }
        case "needstaffing": {
          return scopedNeedstaffingConnector(options);
        }
        case "onefellow": {
          return scopedOnefellowConnector(options);
        }
        default: {
          throw new Error(`no scoped connector for ${spec.bronSlug}`);
        }
      }
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
        // The per-adapter checkpoint shape, asserted honestly: harveynash a
        // real {page,pageSize} cursor, needstaffing a real {page} cursor,
        // hays/onefellow the inert empty object.
        expect(run?.checkpoint).toEqual(spec.committedCheckpoint);
        expect(run?.found).toBe(spec.discoveredReferenties.length);
        expect(run?.rejected).toBe(spec.rejectedReferenties.length);

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
        // Rejected items leave no rows at all — this cohort has geen
        // opgenomen reject-fixture, so the list is empty per bron.
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

      it(`a repeat ${spec.bronSlug} run produces no duplicates or new versions`, async () => {
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
        if (spec.repeatRunWritesObservations) {
          // harveynash / hays / needstaffing: every item re-fetches and the
          // recorder dedupes on contentHash — outcome `unchanged`, never a
          // second `new`/`changed` version of the same payload.
          expect(counts.observations).toHaveLength(expected);
          expect(
            counts.observations.every(
              (observation) => observation.outcome === "unchanged"
            )
          ).toBe(true);
          expect(
            counts.sourceRecords.map((r) => r.bronReferentie).toSorted()
          ).toEqual(spec.fixtureReferenties.toSorted());
        } else {
          // onefellow ONLY: listingHashCoversDetail + production known-hash
          // wiring means every unchanged job short-circuits inside fetch() —
          // the run writes ZERO observations and still reports the whole
          // response as observed (no missed-poll counting).
          expect(counts.observations).toHaveLength(0);
          expect(counts.sourceRecords).toHaveLength(0);
        }

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

      it(`a changed ${spec.bronSlug} payload produces a new observation, a new aanvraag_versie and an updated curated row`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        const [targetRef] = spec.fixtureReferenties;
        if (!targetRef) {
          throw new Error(`${spec.bronSlug} has no fixture referenties`);
        }
        const before = await bronRows(spec.bronId);
        const targetBefore = before.aanvragen.find(
          (row) => row.bronReferentie === targetRef
        );
        if (!targetBefore) {
          throw new Error(`no curated aanvraag for ${targetRef}`);
        }

        // One recorded payload changes at the source (titel bump — a real
        // field the normaliser reads into `titel`): the onefellow listing
        // job itself, the needstaffing detail `<h1>`, the hays JobPosting.
        // harveynash mutates the recorded search row's `title`, which the
        // connector copies into the payload's `detail.title`. The persisted
        // contentHash changes, so the observation is `changed`, not
        // `unchanged`.
        const mutatedTitle = `${targetBefore.titel}${MUTATED_SUFFIX}`;
        const { job, takes } = await driveJob(spec, {
          connector: () =>
            scopedFixtureConnector(spec, {
              mutateReferentie: targetRef,
              mutatedTitle,
            }),
        });

        const row = await jobRow(job.scrapeRunId);
        expect(row).toMatchObject({ attempts: 1, completed: true });
        expect(takes).toBe(1);

        const counts = await runRows(job.scrapeRunId);
        const byOutcome = (outcome: string) =>
          counts.observations
            .filter((observation) => observation.outcome === outcome)
            .map((observation) => observation.bronReferentie);
        expect(byOutcome("changed")).toEqual([targetRef]);
        if (spec.repeatRunWritesObservations) {
          expect(counts.observations).toHaveLength(
            spec.fixtureReferenties.length
          );
          expect(byOutcome("unchanged").toSorted()).toEqual(
            spec.fixtureReferenties
              .filter((ref) => ref !== targetRef)
              .toSorted()
          );
        } else {
          // onefellow: the unchanged jobs never reached the recorder — the
          // known-hash skip absorbed them inside fetch().
          expect(counts.observations).toHaveLength(1);
        }

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
        expect(after.aanvragen).toHaveLength(spec.fixtureReferenties.length);
      }, 30_000);

      it(`a failed ${spec.bronSlug} listing read closes the run failed; the durable retake recovers exactly once`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        const listingCalls: number[] = [];
        const detailCalls: string[] = [];
        // The request layer retries a failed discover up to its maxAttempts
        // budget (3 calls) inside one run; the scripted outage must outlast
        // exactly that budget so the durable queue's retake — not the in-run
        // retry — is the thing under test. The paged connectors' outage is
        // scoped to their SECOND listing page so the first page's checkpoint
        // commits first: those are the connectors whose retake resumes
        // mid-listing.
        const listingFailuresLeft = { current: 3 };
        const failurePage = spec.pagedResume ? 1 : 0;
        const stateAtAttempt2: (
          | {
              checkpoint: unknown;
              failureCode: string | null;
              status: string;
            }
          | undefined
        )[] = [];

        const { job, takes } = await driveJob(spec, {
          connector: () =>
            scopedFixtureConnector(spec, {
              detailCalls,
              listingCalls,
              listingFailurePage: failurePage,
              listingFailuresLeft,
              // See ScriptOptions.omitKnownHashes — the retake's replay-key
              // exactly-once is the contract under test here.
              omitKnownHashes: true,
            }),
          onAttempt: async (attempt, scrapeRunId) => {
            if (attempt === 2) {
              const [run] = await runState(scrapeRunId);
              stateAtAttempt2.push(
                run && {
                  checkpoint: run.checkpoint,
                  failureCode: run.failureCode,
                  status: run.status,
                }
              );
            }
          },
        });

        const row = await jobRow(job.scrapeRunId);
        expect(row).toMatchObject({ completed: true });
        expect(row?.last_failure).toBeNull();
        expect(takes).toBe(2);

        // Attempt 2 found the run row `failed` (DISCOVER_FAILED) and reopened
        // it under a new fence (reopenFailed, CTP-643).
        expect(stateAtAttempt2).toHaveLength(1);
        expect(stateAtAttempt2[0]).toMatchObject({
          failureCode: "DISCOVER_FAILED",
          status: "failed",
        });
        // The paged connectors committed their page-0 cursor before the
        // outage — the retake resumes AT the second page, it does not
        // re-enumerate. Single-pass connectors hold the null checkpoint.
        expect(stateAtAttempt2[0]?.checkpoint).toEqual(
          spec.failedCheckpointOnFail
        );

        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");
        expect(run?.fenceToken).toBe(2);
        expect(run?.checkpoint).toEqual(spec.committedCheckpoint);

        // The per-adapter call sequence — paged sources resume at the
        // failed page, single-page sources re-read after the retry budget.
        expect(listingCalls).toEqual([...spec.listingCallsOnFail]);
        // Every discovered item's fetch ran exactly once across both
        // attempts (the listing outage preceded any item work).
        expect(detailCalls).toHaveLength(spec.discoveredReferenties.length);

        const counts = await runRows(job.scrapeRunId);
        // Exactly-once across the retake: each persisted bronReferentie has
        // one source record and one committed observation under this
        // scrapeRunId.
        expect(counts.observations).toHaveLength(
          spec.fixtureReferenties.length
        );
        expect(
          counts.sourceRecords.map((record) => record.bronReferentie).toSorted()
        ).toEqual(spec.fixtureReferenties.toSorted());
      }, 30_000);

      it(`an aborted ${spec.bronSlug} run closes failed mid-item; the retake finishes with no loss and no duplicates`, async () => {
        if (!available) {
          expect(available).toBe(false);
          return;
        }
        const listingCalls: number[] = [];
        const detailCalls: string[] = [];
        const attemptControllers: AbortController[] = [];
        const runAtAttempt2: (
          | {
              checkpoint: unknown;
              failureCode: string | null;
              failurePhase: string | null;
              status: string;
            }
          | undefined
        )[] = [];

        const { job, takes } = await driveJob(spec, {
          connector: () =>
            scopedFixtureConnector(spec, {
              abortOnItemFetch: spec.abortOnItemFetch,
              attemptControllers,
              detailCalls,
              listingCalls,
              // See ScriptOptions.omitKnownHashes — the retake's replay-key
              // exactly-once is the contract under test here.
              omitKnownHashes: true,
            }),
          onAttempt: async (attempt, scrapeRunId) => {
            if (attempt === 2) {
              const [run] = await runState(scrapeRunId);
              runAtAttempt2.push(
                run && {
                  checkpoint: run.checkpoint,
                  failureCode: run.failureCode,
                  failurePhase: run.failurePhase,
                  status: run.status,
                }
              );
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
        // item's raw-store write, which is never a "benign run abort" — the
        // row closes `failed` (RAW_STORE_WRITE_FAILED). needstaffing is the
        // one case where that failed row still holds a REAL page cursor
        // ({page:1} committed after page 0): its retake resumes mid-listing.
        // The others hold the null checkpoint and re-enumerate the whole
        // corpus; already-persisted items dedupe through the observation
        // replay key (scrapeRunId + bronReferentie + contentHash) — for
        // onefellow additionally through the known-hash skip.
        expect(runAtAttempt2).toHaveLength(1);
        expect(runAtAttempt2[0]).toMatchObject({
          failureCode: "RAW_STORE_WRITE_FAILED",
          failurePhase: "raw-store",
          status: "failed",
        });
        expect(runAtAttempt2[0]?.checkpoint).toEqual(
          spec.failedCheckpointOnAbort
        );

        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");
        expect(run?.fenceToken).toBe(2);
        expect(run?.checkpoint).toEqual(spec.committedCheckpoint);

        // The per-adapter call sequence. Item fetches ran up to the abort
        // index plus the full corpus on the retake — for needstaffing the
        // retake only re-read page 1, so its call count is smaller.
        expect(listingCalls).toEqual([...spec.listingCallsOnAbort]);
        if (spec.bronSlug === "needstaffing") {
          // Page-0's item persisted before the abort; the retake resumes at
          // page 1 and re-fetches only the item the abort interrupted.
          expect(detailCalls).toEqual(["15574", "15601", "15601"]);
        } else {
          expect(detailCalls.length).toBe(
            spec.abortOnItemFetch + spec.discoveredReferenties.length
          );
        }

        const counts = await runRows(job.scrapeRunId);
        // Every persisted listing item lands exactly once despite the
        // re-read: anything attempt 1 stored was absorbed by the replay
        // key — or, for onefellow, by the earlier known-hash skip.
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
