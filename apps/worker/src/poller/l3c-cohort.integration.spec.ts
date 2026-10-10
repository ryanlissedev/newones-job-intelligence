import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Connector } from "@ji/connectors";
import { createCtmClient, createCtmConnector } from "@ji/connectors/ctm";
import type { CtmClient } from "@ji/connectors/ctm";
import {
  createFlinterClient,
  createFlinterConnector,
} from "@ji/connectors/flinter";
import type { FlinterClient } from "@ji/connectors/flinter";
import {
  createFreelancerNlClient,
  createFreelancerNlConnector,
} from "@ji/connectors/freelancer-nl";
import type { FreelancerNlClient } from "@ji/connectors/freelancer-nl";
import {
  createJsonLdClient,
  createJsonLdConnector,
  haertConfig,
} from "@ji/connectors/json-ld";
import type { JsonLdClient } from "@ji/connectors/json-ld";
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
 * CTP-639 L3c MIXED-ADAPTER cohort proof: CTM (Atom feed), Flinter and
 * Freelancer.nl (HTML listing + detail) and Haert (JSON-LD sitemap) on the
 * durable ingest path (`curated.durable_job` + `runDurableBronJobConsumer` +
 * `runBronIngestPipeline`) against real Postgres — the committed fixture
 * clients for detail reads, scripted listing clients for retake/abort
 * evidence.
 *
 * The four connectors do NOT share one resume contract — the per-adapter
 * truth, asserted rather than assumed below:
 *
 * - ctm: one ungapped `days=30` Atom window; `hasMore: false` with a
 *   populated-but-inert `{cursor: <feed updatedAt>}` checkpoint. `fetch()`
 *   re-serialises the feed entry — no detail request — so
 *   `listingHashCoversDetail: true` and the production `knownHashes` store
 *   skips unchanged items BEFORE any persistence: a repeat poll writes ZERO
 *   observations. The change vector is the feed entry itself.
 * - flinter: one unpaginated listing (`hasMore: false`, inert `{}`), but
 *   every item costs a real detail fetch and `knownHashes` is DELIBERATELY
 *   not forwarded (a listing-hash skip would freeze detail-only changes).
 *   `bedrijfsjurist` rejects as a permanent vacancy — the one rejected item
 *   in this cohort.
 * - freelancer-nl: the ONLY connector here with a real page cursor —
 *   `{cursor: JSON.stringify(seen refs), page}` — so a failed run's retake
 *   RESUMES mid-listing at the committed page instead of re-enumerating.
 * - haert: the L3a/L3b sitemap shape — `hasMore: false`, inert `{}`,
 *   whole-corpus re-enumeration on every retake.
 *
 * Fixture scoping, stated plainly: every persisted payload is a real
 * committed recording. freelancer-nl's fixture listing has three cards but
 * only `cfc3ced1` has a recorded detail page, so its scripted two-page
 * corpus serves `cfc3ced1` on page 1 and the REAL `56ca9f6b` listing card
 * on page 2, detail-read through the recorded `detail-cfc3ced1.json` (the
 * same recorded-body-per-item pattern the CTP-629 feed cohort used for
 * TenderNed). Flinter's two listing cards are both detail-backed, but
 * `bedrijfsjurist` is a recorded permanent-employment vacancy and rejects —
 * asserted, not scoped away.
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
  CTM_LIVE: process.env.CTM_LIVE,
  DATABASE_URL: process.env.DATABASE_URL,
  FLINTER_LIVE: process.env.FLINTER_LIVE,
  FREELANCER_NL_LIVE: process.env.FREELANCER_NL_LIVE,
  HAERT_LIVE: process.env.HAERT_LIVE,
  RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
  SEARCH_PROJECTOR: process.env.SEARCH_PROJECTOR,
};
// poll-bron-run validates `DATABASE_URL` at import time; point it at the same
// database before the dynamic import below (mirrors abort-finalization).
process.env.DATABASE_URL ??= applicationUrl;
process.env.SEARCH_PROJECTOR = "onbox";
// Raw payloads land in a throwaway filesystem store, never the repo .data dir.
process.env.RAW_OBJECT_STORE_PATH ??= `${process.env.TMPDIR ?? "/tmp"}/ji-l3c-cohort-raw-${process.pid}`;
// All four connectors must stay in fixture mode — no live egress from tests.
delete process.env.CTM_LIVE;
delete process.env.FLINTER_LIVE;
delete process.env.FREELANCER_NL_LIVE;
delete process.env.HAERT_LIVE;

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
   * whose read aborts the attempt's signal. For ctm this counts connector
   * `fetch()` invocations (there is no detail request); for the others it
   * counts detail reads. freelancer-nl aborts on its page-2 item so the
   * failed row keeps the committed `{page:2}` checkpoint — the retake then
   * resumes mid-listing instead of re-enumerating.
   */
  readonly abortOnItemFetch: number;
  /**
   * Aborts on attempt 1's read of this referentie instead of a call index.
   * Fetch order follows `source_record.last_fetched_at`, so a source with a
   * never-stored reject (flinter) reads it first once its persisting item
   * has history: an index would land on a different item per test order.
   */
  readonly abortOnReferentie?: string;
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
   * False only for ctm: `listingHashCoversDetail: true` + the production
   * known-hash wiring means an unchanged repeat poll skips every fetch and
   * writes NO observations — dedupe sits before the recorder, not inside it.
   */
  readonly repeatRunWritesObservations: boolean;
}

const CTM: BronSpec = {
  abortOnItemFetch: 2,
  bronId: "00000000-0000-4000-8000-00000000000b",
  bronSlug: "ctm",
  categorie: "overheidsportaal",
  // The committed feed fixture's <updated> timestamp — a populated but inert
  // cursor, NOT the sitemap cohort's `{}`.
  committedCheckpoint: { cursor: "2026-08-30T22:04:57Z" },
  discoveredReferenties: ["459469", "459876", "459877", "460057", "460060"],
  fixtureReferenties: ["459469", "459876", "459877", "460057", "460060"],
  naam: "CTM",
  rejectedReferenties: [],
  repeatRunWritesObservations: false,
};
const FLINTER: BronSpec = {
  // vergunningverlener-agrarisch is the only persisting item: the abort
  // lands inside its raw-store write, so nothing persists before it — the
  // retake writes it fresh. Replay absorption for flinter is pinned in the
  // connector spec with a scripted 3-item corpus.
  abortOnItemFetch: 1,
  abortOnReferentie: "vergunningverlener-agrarisch",
  bronId: "00000000-0000-4000-8000-00000000000a",
  bronSlug: "flinter",
  categorie: "overheidsportaal",
  committedCheckpoint: {},
  discoveredReferenties: ["bedrijfsjurist", "vergunningverlener-agrarisch"],
  fixtureReferenties: ["vergunningverlener-agrarisch"],
  naam: "Flinter",
  // Recorded permanent-employment vacancy (dienstverband + bruto salaris) —
  // the connector rejects it by design, no observation lands.
  rejectedReferenties: ["bedrijfsjurist"],
  repeatRunWritesObservations: true,
};
const FREELANCER_NL: BronSpec = {
  // Detail call 2 is the page-2 item (56ca9f6b): page 1's checkpoint has
  // already committed when the abort lands, so the failed row holds a REAL
  // resume cursor.
  abortOnItemFetch: 2,
  bronId: "00000000-0000-4000-8000-000000000012",
  bronSlug: "freelancer-nl",
  categorie: "overheidsportaal",
  // Page 2 reports hasNextPage:false, so discovery ends there — no trailing
  // empty page is read and the last committed checkpoint carries the NEXT
  // page number (3).
  committedCheckpoint: {
    cursor: '["56ca9f6b","cfc3ced1"]',
    page: 3,
  },
  discoveredReferenties: ["56ca9f6b", "cfc3ced1"],
  fixtureReferenties: ["56ca9f6b", "cfc3ced1"],
  naam: "Freelancer.nl",
  rejectedReferenties: [],
  repeatRunWritesObservations: true,
};
const HAERT: BronSpec = {
  abortOnItemFetch: 2,
  bronId: "00000000-0000-4000-8000-00000000003f",
  bronSlug: "haert",
  categorie: "overheidsportaal",
  committedCheckpoint: {},
  discoveredReferenties: [
    "opdrachten/hr-adviseur-39565",
    "opdrachten/projectleider-energietransitie-98858",
    "opdrachten/zwemonderwijzer-13184",
  ],
  fixtureReferenties: [
    "opdrachten/hr-adviseur-39565",
    "opdrachten/projectleider-energietransitie-98858",
    "opdrachten/zwemonderwijzer-13184",
  ],
  naam: "Haert",
  rejectedReferenties: [],
  repeatRunWritesObservations: true,
};

const SPECS: readonly BronSpec[] = [CTM, FLINTER, FREELANCER_NL, HAERT];

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
  /** See `BronSpec.abortOnReferentie`; replaces the call index when set. */
  readonly abortOnReferentie?: string;
  readonly attemptControllers?: AbortController[];
  /** Per-adapter call log: connector fetches (ctm) or detail reads (others). */
  readonly detailCalls?: string[];
  /** Page numbers read per listing call — [1] repeated for single-page sources. */
  readonly listingCalls?: number[];
  /**
   * Scripted outage: fails this many listing reads before succeeding — must
   * outlast the in-run retry budget (3) so the durable retake, not the
   * retry, is what recovers. `listingFailurePage` scopes the outage to one
   * page for freelancer-nl's mid-listing resume test.
   */
  readonly listingFailuresLeft?: { current: number };
  readonly listingFailurePage?: number;
  /** bronReferentie whose persisted payload mutates at the source. */
  readonly mutateReferentie?: string;
  readonly mutatedTitle?: string;
  /**
   * ctm only: build the connector WITHOUT the production `knownHashes`
   * store. Used by the two failure-injection tests — the durable contract
   * under test there is the observation replay key + `reopenFailed` retake,
   * while the known-hash early-exit (which would legitimately shrink, never
   * duplicate, the retake's observation set — and would couple this test to
   * accumulated cross-run state) is pinned separately by the repeat-run
   * spec. Every other ctm test wires the store exactly as the registry does.
   */
  readonly omitKnownHashes?: boolean;
}

const MUTATED_SUFFIX = " (CTP-639 gewijzigd)";

describe.serial(
  "L3c mixed-adapter cohort on the durable ingest path (CTP-639)",
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
     * ctm: real fixture feed via `createCtmClient`; the outage mutates the
     * feed itself (the change vector IS the entry). `fetchUsesNetwork:
     * false` means the connector's fetch does no upstream I/O, so abort/call
     * scripting wraps the CONNECTOR. `knownHashes` is forwarded — the exact
     * registry wiring (`listingHashCoversDetail: true`).
     */
    const scopedCtmConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: CtmClient = createCtmClient({
        liveEnabled: false,
      });
      const ctmClient: CtmClient = {
        fetchListing: async () => {
          options.listingCalls?.push(1);
          const failures = options.listingFailuresLeft;
          if (failures && failures.current > 0) {
            failures.current -= 1;
            throw new Error("scripted listing failure");
          }
          const listing = await fixtureClient.fetchListing();
          const target = options.mutateReferentie;
          if (!(target && options.mutatedTitle)) {
            return listing;
          }
          return {
            ...listing,
            entries: listing.entries.map((entry) =>
              entry.aanvraagnummer === target
                ? { ...entry, titel: options.mutatedTitle ?? entry.titel }
                : entry
            ),
          };
        },
      };
      const inner = createCtmConnector({
        bronId: CTM.bronId,
        client: ctmClient,
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

    /**
     * flinter: real fixture client — both listing cards have detail
     * fixtures, `bedrijfsjurist` rejects inside fetch() as a recorded
     * permanent vacancy. NO `knownHashes` (registry wiring preserved: a
     * listing-hash skip would freeze detail-only changes).
     */
    const scopedFlinterConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: FlinterClient = createFlinterClient({
        liveEnabled: false,
      });
      const flinterClient: FlinterClient = {
        fetchDetailHtml: async (slug) => {
          options.detailCalls?.push(slug);
          const abortHere =
            options.abortOnReferentie === undefined
              ? options.abortOnItemFetch === options.detailCalls?.length
              : options.abortOnReferentie === slug &&
                options.attemptControllers?.length === 1;
          if (abortHere) {
            options.attemptControllers?.at(-1)?.abort();
          }
          const html = await fixtureClient.fetchDetailHtml(slug);
          if (options.mutateReferentie !== slug || !options.mutatedTitle) {
            return html;
          }
          // Swap the hero `<h2>` the detail parser reads for `titel`.
          const marker = '<div class="block-hero-content">';
          const markerIndex = html.indexOf(marker);
          if (markerIndex === -1) {
            throw new Error("flinter detail fixture missing hero block");
          }
          const rest = html
            .slice(markerIndex)
            .replace(/<h2>[\s\S]*?<\/h2>/u, `<h2>${options.mutatedTitle}</h2>`);
          return html.slice(0, markerIndex) + rest;
        },
        fetchListing: () => {
          options.listingCalls?.push(1);
          const failures = options.listingFailuresLeft;
          if (failures && failures.current > 0) {
            failures.current -= 1;
            throw new Error("scripted listing failure");
          }
          return fixtureClient.fetchListing();
        },
      };
      return createFlinterConnector({
        bronId: FLINTER.bronId,
        client: flinterClient,
      });
    };

    /**
     * freelancer-nl: the ONLY paged connector in the cohort. Page 1 serves
     * the real fixture card `cfc3ced1`; page 2 serves the real fixture card
     * `56ca9f6b` (a committed listing item whose detail was never recorded —
     * detail-read through the recorded `detail-cfc3ced1.json`, per the file
     * docblock); later pages are empty, like the fixture client itself.
     */
    const scopedFreelancerNlConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: FreelancerNlClient = createFreelancerNlClient({
        detailFixtures: {
          "56ca9f6b": "freelancer-nl/detail-cfc3ced1.json",
          cfc3ced1: "freelancer-nl/detail-cfc3ced1.json",
        },
        liveEnabled: false,
      });
      const freelancerNlClient: FreelancerNlClient = {
        fetchDetailHtml: async (item) => {
          options.detailCalls?.push(item.bronReferentie);
          if (options.abortOnItemFetch === options.detailCalls?.length) {
            options.attemptControllers?.at(-1)?.abort();
          }
          const html = await fixtureClient.fetchDetailHtml(item);
          if (
            options.mutateReferentie !== item.bronReferentie ||
            !options.mutatedTitle
          ) {
            return html;
          }
          // Swap the `<h1>` the detail parser reads for `titel`.
          return html.replace(
            /<h1\b[^>]*>[\s\S]*?<\/h1>/u,
            `<h1 itemprop="title">${options.mutatedTitle}</h1>`
          );
        },
        fetchListing: async (page) => {
          options.listingCalls?.push(page);
          const failures = options.listingFailuresLeft;
          const failurePage = options.listingFailurePage ?? 1;
          if (failures && failures.current > 0 && page === failurePage) {
            failures.current -= 1;
            throw new Error(`scripted listing page-${page} failure`);
          }
          // The real parsed fixture page 1 holds all three recorded cards.
          const real = await fixtureClient.fetchListing(1);
          if (page === 1) {
            return {
              hasNextPage: true,
              items: real.items.filter(
                (item) => item.bronReferentie === "cfc3ced1"
              ),
            };
          }
          if (page === 2) {
            return {
              hasNextPage: false,
              items: real.items.filter(
                (item) => item.bronReferentie === "56ca9f6b"
              ),
            };
          }
          return { hasNextPage: false, items: [] };
        },
      };
      return createFreelancerNlConnector({
        bronId: FREELANCER_NL.bronId,
        client: freelancerNlClient,
      });
    };

    /**
     * haert: the L3b scoped-fixture shape — the real parsed sitemap filtered
     * to `detailFixtures` keys; detail reads stay real recorded fixtures.
     */
    const scopedHaertConnector = (options: ScriptOptions): Connector => {
      const fixtureClient: JsonLdClient = createJsonLdClient({
        config: haertConfig,
        liveEnabled: false,
      });
      const detailBacked = new Set(
        Object.keys(haertConfig.detailFixtures ?? {})
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
        bronId: HAERT.bronId,
        client: jsonLdClient,
        config: haertConfig,
      });
    };

    const scopedFixtureConnector = (
      spec: BronSpec,
      options: ScriptOptions
    ): Connector => {
      switch (spec.bronSlug) {
        case "ctm": {
          return scopedCtmConnector(options);
        }
        case "flinter": {
          return scopedFlinterConnector(options);
        }
        case "freelancer-nl": {
          return scopedFreelancerNlConnector(options);
        }
        case "haert": {
          return scopedHaertConnector(options);
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
        // The per-adapter checkpoint shape, asserted honestly: ctm commits a
        // populated-but-inert feed cursor, freelancer-nl a real page+seen-set
        // cursor, flinter/haert the inert empty object.
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
        // Rejected items leave no rows at all — flinter's recorded permanent
        // vacancy is the one honest reject in this cohort.
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
          // flinter / freelancer-nl / haert: every item re-fetches and the
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
          // ctm ONLY: listingHashCoversDetail + production known-hash wiring
          // means every unchanged entry short-circuits inside fetch() —
          // the run writes ZERO observations and still reports the whole
          // window as observed (no missed-poll counting).
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
        // field the normaliser reads into `titel`): the ctm feed entry
        // itself, the flinter/freelancer-nl detail page, the haert
        // JobPosting. The persisted contentHash changes, so the observation
        // is `changed`, not `unchanged`.
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
          // ctm: the unchanged entries never reached the recorder — the
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
        // retry — is the thing under test. freelancer-nl's outage is scoped
        // to PAGE 2 so page 1's checkpoint commits first: that is the only
        // connector here whose retake can resume mid-listing.
        const listingFailuresLeft = { current: 3 };
        const page2 = spec.bronSlug === "freelancer-nl" ? 2 : 1;
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
              listingFailurePage: page2,
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
        if (spec.bronSlug === "freelancer-nl") {
          // Page 1 committed {page:2} before the outage — the retake resumes
          // AT page 2, it does not re-enumerate.
          expect(stateAtAttempt2[0]?.checkpoint).toEqual({
            cursor: '["cfc3ced1"]',
            page: 2,
          });
        }

        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");
        expect(run?.fenceToken).toBe(2);
        expect(run?.checkpoint).toEqual(spec.committedCheckpoint);

        if (spec.bronSlug === "freelancer-nl") {
          // Attempt 1: page 1 ok, page 2 fails ×3 (retry budget). Attempt 2:
          // resumes AT page 2 — page 1 is never re-read, and page 2's
          // hasNextPage:false ends the run without a trailing empty read.
          expect(listingCalls).toEqual([1, 2, 2, 2, 2]);
        } else {
          // Whole-corpus sources: 3 failed reads inside attempt 1's retry
          // budget, one successful re-read on the retake.
          expect(listingCalls).toEqual([1, 1, 1, 1]);
        }
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
              abortOnReferentie: spec.abortOnReferentie,
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
        // row closes `failed` (RAW_STORE_WRITE_FAILED). freelancer-nl is the
        // one case where that failed row still holds a REAL page cursor
        // ({page:2} committed after page 1): its retake resumes mid-listing.
        // The single-page sources hold the null checkpoint and re-enumerate
        // the whole corpus; already-persisted items dedupe through the
        // observation replay key (scrapeRunId + bronReferentie + contentHash)
        // — for ctm additionally through the known-hash skip.
        expect(runAtAttempt2).toHaveLength(1);
        expect(runAtAttempt2[0]).toMatchObject({
          failureCode: "RAW_STORE_WRITE_FAILED",
          failurePhase: "raw-store",
          status: "failed",
        });
        if (spec.bronSlug === "freelancer-nl") {
          expect(runAtAttempt2[0]?.checkpoint).toEqual({
            cursor: '["cfc3ced1"]',
            page: 2,
          });
        } else {
          expect(runAtAttempt2[0]?.checkpoint).toBeNull();
        }

        const [run] = await runState(job.scrapeRunId);
        expect(run?.status).toBe("succeeded");
        expect(run?.fenceToken).toBe(2);
        expect(run?.checkpoint).toEqual(spec.committedCheckpoint);

        if (spec.bronSlug === "freelancer-nl") {
          // Attempt 1: page 1 + page 2 (aborted mid-item). Attempt 2:
          // resumes AT page 2 — the page-1 item is never re-read.
          expect(listingCalls).toEqual([1, 2, 2]);
          expect(detailCalls).toEqual(["cfc3ced1", "56ca9f6b", "56ca9f6b"]);
        } else {
          // Both attempts read the single-page listing once; item fetches
          // ran up to the abort index plus the full corpus on the retake.
          expect(listingCalls).toEqual([1, 1]);
          const retake = spec.discoveredReferenties.length;
          if (spec.abortOnReferentie === undefined) {
            expect(detailCalls.length).toBe(spec.abortOnItemFetch + retake);
          } else {
            // Attempt 1 stopped on the scripted item; attempt 2 read all.
            expect(detailCalls.at(-retake - 1)).toBe(spec.abortOnReferentie);
            expect(detailCalls.slice(-retake).toSorted()).toEqual(
              spec.discoveredReferenties.toSorted()
            );
          }
        }

        const counts = await runRows(job.scrapeRunId);
        // Every persisted listing item lands exactly once despite the
        // re-read: anything attempt 1 stored was absorbed by the replay
        // key — or, for ctm, by the earlier known-hash skip.
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
