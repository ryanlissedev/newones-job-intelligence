import { describe, expect, it } from "bun:test";

import {
  ConnectorRunFailure,
  CrawlDelayLimiter,
  InMemoryObservationRecorder,
  InMemoryObjectStore,
  InMemoryRunLifecycleStore,
  runConnector,
  RunOwnershipLostError,
} from "@ji/connectors";
import type { ConnectorRunResult } from "@ji/connectors";

import type { NeedstaffingClient } from "./client";
import { createNeedstaffingConnector } from "./connector";
import type { NeedstaffingListingItem } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-640 L3d: Need Staffing IT is one of the two cohort members with a
 * REAL page cursor — `/Opdrachten?PageNumber=N+1` paginates server-side and
 * `discover()` carries a `{page}` checkpoint. A durable retake therefore
 * RESUMES at the committed page: pages already committed are never
 * re-read, and there is no seen-set — the cursor is a bare page number, so
 * items that shift between pages across attempts are the replay key's
 * problem, not the cursor's. Consequences pinned below:
 *
 * - Persisted items behind the cursor are NOT re-fetched on a retake —
 *   exactly-once there is carried by the page checkpoint.
 * - A head insert or deletion on an already-read page is INVISIBLE to the
 *   retake (read-pages blind spot — the sitemap cohort has none). It
 *   self-heals on the next fresh (checkpoint-less) poll.
 * - A retaken run reports `completeness: { complete: false, reason:
 *   "resumed" }`, so missed-poll reconciliation skips that run.
 * - `listingHashCoversDetail: false` (RJC-357/RJC-401): the listing card
 *   carries id + summary fields only and `knownHashes` is DELIBERATELY not
 *   forwarded — a listing-hash skip would freeze detail-only changes
 *   (titel/beschrijving on `/Opdrachten/{id}`).
 * - `NEEDSTAFFING_MAX_LISTING_PAGES` (20) bounds the walk; hitting it while
 *   the site still reports a next page marks the run `truncated`, never
 *   silently complete.
 */

const BRON_ID = "bron-needstaffing-l3d";

interface ClientCalls {
  detail: string[];
  listing: number[];
}

const listingItem = (id: string, titel?: string): NeedstaffingListingItem => ({
  id,
  titel: titel ?? `Opdracht ${id}`,
});

interface PageDef {
  hasNextPage: boolean;
  ids: string[];
}

/** Minimal detail page in Needstaffing's real shape: the parser reads
 * `.page-header-vacancy h1` for `titel` — the one required field fetch()
 * rejects without. */
const detailHtmlFor = (id: string, titel?: string): string =>
  `<html><body><div class="page-header-vacancy"><h1>${titel ?? `Detail ${id}`}</h1></div><div class="vacancy-body"><p>Omschrijving ${id}.</p></div></body></html>`;

/**
 * A paged listing served from `pages` (0-indexed; the live URL maps it to
 * `PageNumber=page+1`) at call time, so mutating a page between attempts
 * reproduces a listing that shifted while the run was down. `failOnPages`
 * scripts a listing outage; `killOn`/`abortOn` act inside one detail read;
 * `detailBodies` overrides per-id detail HTML for the changed-payload case.
 */
const scriptedClient = (options: {
  abortOn?: { controller: AbortController; id: string };
  calls: ClientCalls;
  detailBodies?: Map<string, string>;
  failOnPages?: Map<number, { current: number }>;
  killOn?: { once: { current: boolean }; id: string };
  pages: PageDef[];
}): NeedstaffingClient => ({
  fetchDetailHtml: (id) => {
    options.calls.detail.push(id);
    if (options.abortOn && id === options.abortOn.id) {
      options.abortOn.controller.abort();
    }
    if (
      options.killOn &&
      id === options.killOn.id &&
      options.killOn.once.current
    ) {
      options.killOn.once.current = false;
      return Promise.reject(new RunOwnershipLostError());
    }
    return Promise.resolve(options.detailBodies?.get(id) ?? detailHtmlFor(id));
  },
  fetchListing: (page) => {
    options.calls.listing.push(page);
    const failures = options.failOnPages?.get(page);
    if (failures && failures.current > 0) {
      failures.current -= 1;
      return Promise.reject(
        new Error(`scripted Needstaffing page-${page} outage`)
      );
    }
    const def = options.pages[page];
    return Promise.resolve(
      def
        ? {
            hasNextPage: def.hasNextPage,
            items: def.ids.map((id) => listingItem(id)),
          }
        : { hasNextPage: false, items: [] }
    );
  },
});

const connectorFor = (client: NeedstaffingClient) =>
  createNeedstaffingConnector({ bronId: BRON_ID, client });

const runWithStore = (options: {
  client: NeedstaffingClient;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  signal?: AbortSignal;
  store: InMemoryRunLifecycleStore;
}): Promise<ConnectorRunResult> =>
  runConnector({
    bronId: BRON_ID,
    bronSlug: "needstaffing",
    connector: connectorFor(options.client),
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: options.recorder ?? new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    retryPolicy,
    runKind: "test",
    runLifecycleStore: options.store,
    scrapeRunId: options.scrapeRunId,
    signal: options.signal,
  });

describe("needstaffing durable-cohort resume contract (CTP-640)", () => {
  it("paginates discovery with a real {page} checkpoint — hasMore follows hasNextPage, truncated only at the page cap", async () => {
    const calls: ClientCalls = { detail: [], listing: [] };
    const connector = connectorFor(
      scriptedClient({
        calls,
        pages: [
          { hasNextPage: true, ids: ["15574", "15601"] },
          { hasNextPage: false, ids: ["15600"] },
        ],
      })
    );

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual([
      "15574",
      "15601",
    ]);
    // The checkpoint is REAL: the next page index — no seen-set.
    expect(first.checkpoint).toEqual({ page: 1 });
    expect(first.hasMore).toBe(true);
    expect(first.truncated).toBe(false);

    const second = await connector.discover(first.checkpoint);
    // Page 0 is never re-read; the resumed call went straight to page 1.
    expect(calls.listing).toEqual([0, 1]);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(["15600"]);
    expect(second.checkpoint).toEqual({ page: 2 });
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(false);
  });

  it("a durable retake RESUMES at the committed page checkpoint — earlier pages are never re-read, and the run reports `resumed`", async () => {
    const scrapeRunId = "run-needstaffing-resume";
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      killOn: { id: "15600", once: { current: true } },
      pages: [
        { hasNextPage: true, ids: ["15574", "15601"] },
        { hasNextPage: true, ids: ["15600", "15599"] },
        { hasNextPage: false, ids: ["15598"] },
      ],
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // Attempt 1 persists page 0 (checkpoint {page:1} commits), then "dies"
    // inside page 1's first detail read.
    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(calls.listing).toEqual([0, 1]);
    expect(calls.detail).toEqual(["15574", "15601", "15600"]);
    expect(await store.load({ bronId: BRON_ID, scrapeRunId })).toMatchObject({
      checkpoint: { page: 1 },
    });

    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    // The retake re-read ONLY page 1 onward — page 0 is behind the cursor.
    expect(calls.listing).toEqual([0, 1, 1, 2]);
    expect(calls.detail).toEqual([
      "15574",
      "15601",
      "15600",
      "15600",
      "15599",
      "15598",
    ]);
    expect(result.observedBronReferenties.toSorted()).toEqual(
      ["15598", "15599", "15600"].toSorted()
    );
    expect(result.completeness).toEqual({ complete: false, reason: "resumed" });
    expect(recorder.records).toHaveLength(5);
    expect(recorder.observations).toHaveLength(5);
  });

  it("a head insert on an already-read page is invisible to the retake — the honest blind spot of a page cursor", async () => {
    const scrapeRunId = "run-needstaffing-insert";
    const calls: ClientCalls = { detail: [], listing: [] };
    const pages: PageDef[] = [
      { hasNextPage: true, ids: ["15574"] },
      { hasNextPage: false, ids: ["15601"] },
    ];
    const client = scriptedClient({
      calls,
      killOn: { id: "15601", once: { current: true } },
      pages,
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // A new item lands at the TOP of page 0 while the run is down — the
    // retake resumes at page 1 and never sees it.
    pages[0]?.ids.unshift("15999");
    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties).toEqual(["15601"]);
    expect(recorder.records).toHaveLength(2);
    expect(
      recorder.records.map((record) => record.bronReferentie).toSorted()
    ).toEqual(["15574", "15601"]);
    // The insert surfaces on the next FRESH poll (checkpoint null), which
    // re-reads page 0 — self-healing, never silently stale.
    const fresh = await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-fresh`,
      store: new InMemoryRunLifecycleStore(),
    });
    expect(fresh.observedBronReferenties.toSorted()).toEqual(
      ["15574", "15601", "15999"].toSorted()
    );
    expect(recorder.records).toHaveLength(3);
  });

  it("a detail-only change lands a new observation — the listing card stays identical, which is exactly why knownHashes must stay unforwarded", async () => {
    const scrapeRunId = "run-needstaffing-change";
    const detailBodies = new Map(
      ["15574", "15601"].map((id) => [id, detailHtmlFor(id)])
    );
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      detailBodies,
      pages: [{ hasNextPage: false, ids: ["15574", "15601"] }],
    });
    const recorder = new InMemoryObservationRecorder();

    await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-1`,
      store: new InMemoryRunLifecycleStore(),
    });
    const before = recorder.records.find(
      (record) => record.bronReferentie === "15601"
    );
    if (!before) {
      throw new Error("expected a persisted record for 15601");
    }

    // Only the DETAIL page changes (titel in .page-header-vacancy h1): the
    // listing card is byte-identical, so hashNeedstaffingListingItem returns
    // the same listing hash — had the registry forwarded knownHashes, this
    // change would be invisible forever.
    detailBodies.set("15601", detailHtmlFor("15601", "Gewijzigde 15601"));
    await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-2`,
      store: new InMemoryRunLifecycleStore(),
    });

    const after = recorder.records.find(
      (record) => record.bronReferentie === "15601"
    );
    expect(after?.contentHash).not.toBe(before.contentHash);
    expect(recorder.records).toHaveLength(2);
    expect(recorder.observations).toHaveLength(4);
  });

  it("a failed page read closes the run `failed` (DISCOVER_FAILED) holding the last committed page checkpoint", async () => {
    const scrapeRunId = "run-needstaffing-discoverfail";
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      failOnPages: new Map([[1, { current: 1 }]]),
      pages: [
        { hasNextPage: true, ids: ["15574"] },
        { hasNextPage: false, ids: ["15601"] },
      ],
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(ConnectorRunFailure);

    const failEvent = store.events.findLast((event) => event.type === "fail");
    expect(failEvent?.type).toBe("fail");
    if (failEvent?.type !== "fail") {
      throw new Error("expected the run to record a fail event");
    }
    expect(failEvent.input.failure).toMatchObject({
      class: "connector",
      code: "DISCOVER_FAILED",
      phase: "discover",
    });
    // Page 0 committed {page:1} before the outage: on Postgres the durable
    // retake reopens this row via `reopenFailed` (CTP-643) and resumes AT
    // page 1 — page 0 is never re-read — proven in
    // apps/worker/src/poller/l3d-cohort.integration.spec.ts.
    expect(failEvent.input.progress.checkpoint).toEqual({ page: 1 });
    expect(recorder.observations).toHaveLength(1);
  });

  it("an abort mid-item closes the run `failed` (RAW_STORE_WRITE_FAILED — persistence abort is never benign, CTP-490) at the pre-page checkpoint", async () => {
    const scrapeRunId = "run-needstaffing-abort";
    const calls: ClientCalls = { detail: [], listing: [] };
    const controller = new AbortController();
    // Abort while the SECOND item's detail is being read: the fetch returns,
    // then the raw-store write sees the aborted signal and throws. Page 0 is
    // not complete, so no checkpoint ever commits.
    const client = scriptedClient({
      abortOn: { controller, id: "15601" },
      calls,
      pages: [
        { hasNextPage: true, ids: ["15574", "15601"] },
        { hasNextPage: false, ids: ["15600"] },
      ],
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({
        client,
        recorder,
        scrapeRunId,
        signal: controller.signal,
        store,
      })
    ).rejects.toBeInstanceOf(ConnectorRunFailure);

    const failEvent = store.events.findLast((event) => event.type === "fail");
    expect(failEvent?.type).toBe("fail");
    if (failEvent?.type !== "fail") {
      throw new Error("expected the aborted run to record a fail event");
    }
    expect(failEvent.input.failure).toMatchObject({
      class: "storage",
      code: "RAW_STORE_WRITE_FAILED",
      phase: "raw-store",
    });
    // The failed row holds the pre-page (null) checkpoint: the retake
    // re-reads page 0 — already-persisted items dedupe through the replay
    // key, not the cursor, because the cursor was never written. Proven on
    // real Postgres in the integration spec.
    expect(failEvent.input.progress.checkpoint).toBeNull();
    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]?.bronReferentie).toBe("15574");
  });

  it("marks the run truncated — never silently complete — when the 20-page cap cuts the listing short", async () => {
    const calls: ClientCalls = { detail: [], listing: [] };
    const connector = connectorFor(
      scriptedClient({
        calls,
        // Page 19 still advertises a next page: the cap decides.
        pages: Array.from({ length: 20 }, (_value, index) => ({
          hasNextPage: true,
          ids: [`cap${String(index).padStart(5, "0")}`],
        })),
      })
    );

    let discovery = await connector.discover(null);
    for (let page = 1; page <= 19; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- page order is the contract under test
      discovery = await connector.discover(discovery.checkpoint);
    }
    expect(calls.listing).toHaveLength(20);
    expect(discovery.hasMore).toBe(false);
    expect(discovery.truncated).toBe(true);
  });
});
