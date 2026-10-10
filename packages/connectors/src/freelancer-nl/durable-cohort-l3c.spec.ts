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

import type { FreelancerNlClient } from "./client";
import { createFreelancerNlConnector } from "./connector";
import type { FreelancerNlListingItem, FreelancerNlListingPage } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-639 L3c: Freelancer.nl is the ONE connector in this cohort with a real
 * page cursor — the difference from the sitemap/feed siblings is the point
 * of this spec, so it is asserted rather than assumed.
 *
 * `discover()` paginates `/opdrachten?page=N` and carries a checkpoint
 * `{ cursor: JSON.stringify(sorted seen bronReferenties), page: N+1 }`. A
 * durable retake therefore RESUMES mid-listing: pages before the checkpoint
 * are never re-read, and the cursor's seen-set dedupes items the cumulative
 * HTML re-serves. Consequences pinned below:
 *
 * - Persisted items from earlier pages are NOT re-fetched on a retake —
 *   exactly-once there is carried by the page cursor, not the replay key.
 * - A head insert or deletion on an already-read page is INVISIBLE to the
 *   retake (read-pages blind spot — the sitemap cohort has none). It
 *   self-heals on the next fresh (checkpoint-less) poll.
 * - A retaken run reports `completeness: { complete: false, reason:
 *   "resumed" }`, so missed-poll reconciliation skips that run — the
 *   deleted-earlier-page case can never be misread as a mass delisting.
 * - `listingHashCoversDetail: false`: the listing card is summary-only; the
 *   detail page (titel/beschrijving/status/skills) changes invisibly to the
 *   listing hash, so no known-hash short-circuit exists here at all.
 */

const BRON_ID = "bron-freelancer-nl-l3c";

interface ClientCalls {
  detail: string[];
  listing: number[];
}

const listingItem = (ref: string): FreelancerNlListingItem => ({
  bronReferentie: ref,
  geplaatst: "Geplaatst 1 dag geleden",
  locatie: "Remote",
  titel: `Opdracht ${ref}`,
  url: `https://freelancer.nl/opdrachten/categorie/opdracht-${ref}`,
});

/** Minimal detail page in the real shape: `parseFreelancerNlDetail` reads
 * `<h1>` for `titel` — the one required field fetch() rejects without. */
const detailHtmlFor = (ref: string, titel?: string): string =>
  `<html><body><h1>${titel ?? `Detail ${ref}`}</h1><div itemprop="description"><p>Omschrijving ${ref}.</p></div></body></html>`;

interface PageDef {
  hasNextPage: boolean;
  refs: string[];
}

/**
 * A paged listing served from `pages` (1-indexed) at call time, so mutating
 * a page between attempts reproduces a listing that shifted while the run
 * was down. `failOnPages` makes discover() throw for the scripted outage;
 * `killOn`/`abortOn` act inside one detail read; `detailBodies` overrides
 * per-ref detail HTML for the changed-payload case.
 */
const scriptedClient = (options: {
  abortOn?: { controller: AbortController; ref: string };
  calls: ClientCalls;
  detailBodies?: Map<string, string>;
  failOnPages?: Map<number, { current: number }>;
  killOn?: { once: { current: boolean }; ref: string };
  pages: PageDef[];
}): FreelancerNlClient => ({
  fetchDetailHtml: (item) => {
    options.calls.detail.push(item.bronReferentie);
    if (options.abortOn && item.bronReferentie === options.abortOn.ref) {
      options.abortOn.controller.abort();
    }
    if (
      options.killOn &&
      item.bronReferentie === options.killOn.ref &&
      options.killOn.once.current
    ) {
      options.killOn.once.current = false;
      return Promise.reject(new RunOwnershipLostError());
    }
    return Promise.resolve(
      options.detailBodies?.get(item.bronReferentie) ??
        detailHtmlFor(item.bronReferentie)
    );
  },
  fetchListing: (page) => {
    options.calls.listing.push(page);
    const failures = options.failOnPages?.get(page);
    if (failures && failures.current > 0) {
      failures.current -= 1;
      return Promise.reject(
        new Error(`scripted Freelancer.nl page-${page} outage`)
      );
    }
    const def = options.pages[page - 1];
    const listing: FreelancerNlListingPage = def
      ? {
          hasNextPage: def.hasNextPage,
          items: def.refs.map(listingItem),
        }
      : { hasNextPage: false, items: [] };
    return Promise.resolve(listing);
  },
});

const connectorFor = (client: FreelancerNlClient) =>
  createFreelancerNlConnector({ bronId: BRON_ID, client });

const runWithStore = (options: {
  client: FreelancerNlClient;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  signal?: AbortSignal;
  store: InMemoryRunLifecycleStore;
}): Promise<ConnectorRunResult> =>
  runConnector({
    bronId: BRON_ID,
    bronSlug: "freelancer-nl",
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

const cursorOf = (refs: string[]): string => JSON.stringify(refs.toSorted());

describe("freelancer-nl durable-cohort resume contract (CTP-639)", () => {
  it("paginates discovery with a real page+seen-set checkpoint — hasMore follows the listing, truncated only at the page cap", async () => {
    const calls: ClientCalls = { detail: [], listing: [] };
    const connector = connectorFor(
      scriptedClient({
        calls,
        pages: [
          { hasNextPage: true, refs: ["aaa00001", "bbb00002"] },
          { hasNextPage: false, refs: ["ccc00003"] },
        ],
      })
    );

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual([
      "aaa00001",
      "bbb00002",
    ]);
    // The checkpoint is REAL: next page plus every bronReferentie already
    // emitted — the cumulative HTML listing re-serves earlier items, so the
    // seen-set is what makes a resumed page read idempotent.
    expect(first.checkpoint).toEqual({
      cursor: cursorOf(["aaa00001", "bbb00002"]),
      page: 2,
    });
    expect(first.hasMore).toBe(true);
    // `truncated` is a real boolean on this connector (false while the
    // 20-page cap is far away) — absent only means "the connector never
    // reports truncation" on siblings that omit the field entirely.
    expect(first.truncated).toBe(false);

    const second = await connector.discover(first.checkpoint);
    // Page 1 is never re-read; the resumed call went straight to page 2.
    expect(calls.listing).toEqual([1, 2]);
    expect(second.items.map((item) => item.bronReferentie)).toEqual([
      "ccc00003",
    ]);
    expect(second.checkpoint).toEqual({
      cursor: cursorOf(["aaa00001", "bbb00002", "ccc00003"]),
      page: 3,
    });
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(false);
  });

  it("the seen-set dedupes items a resumed page re-serves", async () => {
    const calls: ClientCalls = { detail: [], listing: [] };
    const connector = connectorFor(
      scriptedClient({
        calls,
        pages: [
          { hasNextPage: true, refs: ["aaa00001"] },
          // The cumulative listing re-serves aaa00001 alongside the new item.
          { hasNextPage: false, refs: ["aaa00001", "bbb00002"] },
        ],
      })
    );

    const first = await connector.discover(null);
    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual([
      "bbb00002",
    ]);
  });

  it("a durable retake RESUMES at the committed page checkpoint — earlier pages are never re-read, and the run reports `resumed`", async () => {
    const scrapeRunId = "run-freelancer-resume";
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      killOn: { once: { current: true }, ref: "ccc00003" },
      pages: [
        { hasNextPage: true, refs: ["aaa00001", "bbb00002"] },
        { hasNextPage: true, refs: ["ccc00003", "ddd00004"] },
        { hasNextPage: false, refs: ["eee00005"] },
      ],
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // Attempt 1 persists page 1 (checkpoint {page:2} commits), then "dies"
    // inside page 2's first detail read.
    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(calls.listing).toEqual([1, 2]);
    expect(calls.detail).toEqual(["aaa00001", "bbb00002", "ccc00003"]);
    expect(await store.load({ bronId: BRON_ID, scrapeRunId })).toMatchObject({
      checkpoint: { cursor: cursorOf(["aaa00001", "bbb00002"]), page: 2 },
    });

    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    // The retake re-read ONLY page 2 onward — page 1 is behind the cursor.
    expect(calls.listing).toEqual([1, 2, 2, 3]);
    // Page-1 items are not re-fetched: exactly-once there is the cursor's
    // job, not the replay key's. ccc00003 was fetched but never persisted
    // (the kill landed inside its read), so it is fetched again.
    expect(calls.detail).toEqual([
      "aaa00001",
      "bbb00002",
      "ccc00003",
      "ccc00003",
      "ddd00004",
      "eee00005",
    ]);
    // The result's observed set is the retake's own enumeration — pages
    // behind the cursor are absent by design.
    expect(result.observedBronReferenties.toSorted()).toEqual(
      ["ccc00003", "ddd00004", "eee00005"].toSorted()
    );
    // A run that resumed from a checkpoint reports `resumed`: the
    // application layer's missed-poll reconcile must skip it — records on
    // the skipped page-1 territory are invisible to this enumeration.
    expect(result.completeness).toEqual({ complete: false, reason: "resumed" });
    // Five distinct persisted records total, one per bronReferentie.
    expect(recorder.records).toHaveLength(5);
    expect(recorder.observations).toHaveLength(5);
  });

  it("a head insert on an already-read page is invisible to the retake — the honest blind spot of a page cursor", async () => {
    const scrapeRunId = "run-freelancer-insert";
    const calls: ClientCalls = { detail: [], listing: [] };
    const pages: PageDef[] = [
      { hasNextPage: true, refs: ["aaa00001"] },
      { hasNextPage: false, refs: ["bbb00002"] },
    ];
    const client = scriptedClient({
      calls,
      killOn: { once: { current: true }, ref: "bbb00002" },
      pages,
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // A new item lands at the TOP of page 1 while the run is down. Unlike
    // the sitemap/feed cohort — whose retake re-reads everything — this
    // retake resumes at page 2 and never sees it.
    pages[0]?.refs.unshift("zzz99999");
    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties).toEqual(["bbb00002"]);
    expect(recorder.records).toHaveLength(2);
    expect(
      recorder.records.map((record) => record.bronReferentie).toSorted()
    ).toEqual(["aaa00001", "bbb00002"]);
    // The insert surfaces on the next FRESH poll (checkpoint null), which
    // re-reads page 1 — self-healing, never silently stale.
    const fresh = await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-fresh`,
      store: new InMemoryRunLifecycleStore(),
    });
    expect(fresh.observedBronReferenties.toSorted()).toEqual(
      ["aaa00001", "bbb00002", "zzz99999"].toSorted()
    );
    expect(recorder.records).toHaveLength(3);
  });

  it("a detail-only change lands a new observation — the listing summary stays identical", async () => {
    const scrapeRunId = "run-freelancer-change";
    const detailBodies = new Map([
      ["aaa00001", detailHtmlFor("aaa00001")],
      ["bbb00002", detailHtmlFor("bbb00002")],
    ]);
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      detailBodies,
      pages: [{ hasNextPage: false, refs: ["aaa00001", "bbb00002"] }],
    });
    const recorder = new InMemoryObservationRecorder();

    await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-1`,
      store: new InMemoryRunLifecycleStore(),
    });
    const before = recorder.records.find(
      (record) => record.bronReferentie === "bbb00002"
    );
    if (!before) {
      throw new Error("expected a persisted record for bbb00002");
    }

    // Only the DETAIL page changes: the listing card is byte-identical, so
    // the listing hash cannot see it — which is exactly why this source has
    // no known-hash short-circuit at all.
    detailBodies.set("bbb00002", detailHtmlFor("bbb00002", "Gewijzigd"));
    await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-2`,
      store: new InMemoryRunLifecycleStore(),
    });

    const after = recorder.records.find(
      (record) => record.bronReferentie === "bbb00002"
    );
    expect(after?.contentHash).not.toBe(before.contentHash);
    expect(recorder.records).toHaveLength(2);
    expect(recorder.observations).toHaveLength(4);
  });

  it("a failed page read closes the run `failed` (DISCOVER_FAILED) holding the last committed page checkpoint", async () => {
    const scrapeRunId = "run-freelancer-discoverfail";
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      failOnPages: new Map([[2, { current: 1 }]]),
      pages: [
        { hasNextPage: true, refs: ["aaa00001"] },
        { hasNextPage: false, refs: ["bbb00002"] },
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
    // Page 1 committed {page:2} before the outage: on Postgres the durable
    // retake reopens this row via `reopenFailed` (CTP-643) and resumes AT
    // page 2 — page 1 is never re-read — proven in
    // apps/worker/src/poller/l3c-cohort.integration.spec.ts. The in-memory
    // store cannot reopen a terminal row, so no retake is driven here.
    expect(failEvent.input.progress.checkpoint).toEqual({
      cursor: cursorOf(["aaa00001"]),
      page: 2,
    });
    expect(recorder.observations).toHaveLength(1);
  });

  it("an abort mid-item closes the run `failed` (RAW_STORE_WRITE_FAILED — persistence abort is never benign, CTP-490) at the pre-page checkpoint", async () => {
    const scrapeRunId = "run-freelancer-abort";
    const calls: ClientCalls = { detail: [], listing: [] };
    const controller = new AbortController();
    // Abort while the SECOND item's detail is being read: the fetch returns,
    // then the raw-store write sees the aborted signal and throws. Page 1 is
    // not complete, so no checkpoint ever commits.
    const client = scriptedClient({
      abortOn: { controller, ref: "bbb00002" },
      calls,
      pages: [
        { hasNextPage: true, refs: ["aaa00001", "bbb00002"] },
        { hasNextPage: false, refs: ["ccc00003"] },
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
    // re-reads page 1 — already-persisted items dedupe through the replay
    // key, not the cursor, because the cursor was never written. Proven on
    // real Postgres in the integration spec.
    expect(failEvent.input.progress.checkpoint).toBeNull();
    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]?.bronReferentie).toBe("aaa00001");
  });

  it("marks the run truncated — never silently complete — when the 20-page cap cuts the listing short", async () => {
    const calls: ClientCalls = { detail: [], listing: [] };
    const connector = connectorFor(
      scriptedClient({
        calls,
        // Page 20 still advertises a next page: the cap decides.
        pages: Array.from({ length: 20 }, (_value, index) => ({
          hasNextPage: true,
          refs: [`cap${String(index).padStart(6, "0")}`],
        })),
      })
    );

    // Walk the cap boundary: page 20 is the last discover the connector is
    // allowed to emit items for.
    let discovery = await connector.discover(null);
    for (let page = 2; page <= 20; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- page order is the contract under test
      discovery = await connector.discover(discovery.checkpoint);
    }
    expect(calls.listing).toHaveLength(20);
    expect(discovery.hasMore).toBe(false);
    expect(discovery.truncated).toBe(true);
  });
});
