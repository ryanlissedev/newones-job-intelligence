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

import type { HarveyNashClient } from "./client";
import { createHarveyNashConnector } from "./connector";
import type {
  HarveyNashDetailFragment,
  HarveyNashSearchItem,
  HarveyNashSearchResponse,
} from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-640 L3d: Harvey Nash is one of the two cohort members with a REAL
 * page cursor — the Bullhorn search API pages by `page * pageSize` against
 * `total_size`, and `discover()` carries a `{page, pageSize}` checkpoint.
 * A durable retake therefore RESUMES at the committed page: pages already
 * committed are never re-read, and there is no seen-set — the cursor is a
 * bare page number, so items that shift between pages across attempts are
 * the replay key's problem, not the cursor's. Consequences pinned below:
 *
 * - Persisted items behind the cursor are NOT re-fetched on a retake —
 *   exactly-once there is carried by the page checkpoint.
 * - A head insert or deletion on an already-read page is INVISIBLE to the
 *   retake (read-pages blind spot — the sitemap cohort has none). It
 *   self-heals on the next fresh (checkpoint-less) poll.
 * - A retaken run reports `completeness: { complete: false, reason:
 *   "resumed" }`, so missed-poll reconciliation skips that run.
 * - `listingHashCoversDetail: false`: the search row is summary-only and
 *   `knownHashes` is DELIBERATELY not forwarded by the source definition
 *   (RJC-357/RJC-401) — a listing-hash skip would freeze detail-only
 *   changes (facts/jsonLd on the SSR detail page).
 * - `HARVEYNASH_MAX_DISCOVER_PAGES` (50) bounds the loop against a stale
 *   `total_size`; hitting it marks the run `truncated`, never silently
 *   complete.
 */

const BRON_ID = "bron-harveynash-l3d";

interface ClientCalls {
  detail: string[];
  listing: number[];
}

const listingItem = (id: string, title?: string): HarveyNashSearchItem => ({
  external_reference: `BBBH${id}`,
  id,
  salary_package: "Tarief in overleg",
  title: title ?? `Opdracht ${id}`,
  url_slug: `opdracht-${id}`,
});

interface PageDef {
  ids: string[];
  /** Force the API's reported total — the driver of `hasMore`. */
  totalSize?: number;
}

const detailFragmentFor = (
  id: string,
  richttarief?: string
): HarveyNashDetailFragment => ({
  facts: { richttarief: richttarief ?? "Tarief in overleg" },
  jsonLd: { title: `Detail ${id}` },
});

/**
 * A paged listing served from `pages` (0-indexed, matching the API's
 * `offset = page * pageSize`) at call time, so mutating a page between
 * attempts reproduces a listing that shifted while the run was down.
 * `failOnPages` scripts a search-API outage; `killOn`/`abortOn` act inside
 * one detail read; `detailBodies` overrides per-id detail fragments for
 * the changed-payload case.
 */
const scriptedClient = (options: {
  abortOn?: { controller: AbortController; id: string };
  calls: ClientCalls;
  detailBodies?: Map<string, HarveyNashDetailFragment>;
  failOnPages?: Map<number, { current: number }>;
  killOn?: { once: { current: boolean }; id: string };
  pages: PageDef[];
}): HarveyNashClient => ({
  fetchDetail: (jobId) => {
    options.calls.detail.push(jobId);
    if (options.abortOn && jobId === options.abortOn.id) {
      options.abortOn.controller.abort();
    }
    if (
      options.killOn &&
      jobId === options.killOn.id &&
      options.killOn.once.current
    ) {
      options.killOn.once.current = false;
      return Promise.reject(new RunOwnershipLostError());
    }
    return Promise.resolve(
      options.detailBodies?.get(jobId) ?? detailFragmentFor(jobId)
    );
  },
  fetchListing: (page) => {
    options.calls.listing.push(page);
    const failures = options.failOnPages?.get(page);
    if (failures && failures.current > 0) {
      failures.current -= 1;
      return Promise.reject(
        new Error(`scripted Harvey Nash page-${page} outage`)
      );
    }
    const def = options.pages[page];
    const listing: HarveyNashSearchResponse = def
      ? {
          results: def.ids.map((id) => ({ job: listingItem(id) })),
          total_size: def.totalSize ?? def.ids.length,
        }
      : { results: [], total_size: 0 };
    return Promise.resolve(listing);
  },
});

const connectorFor = (client: HarveyNashClient) =>
  createHarveyNashConnector({ bronId: BRON_ID, client });

const runWithStore = (options: {
  client: HarveyNashClient;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  signal?: AbortSignal;
  store: InMemoryRunLifecycleStore;
}): Promise<ConnectorRunResult> =>
  runConnector({
    bronId: BRON_ID,
    bronSlug: "harveynash",
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

describe("harveynash durable-cohort resume contract (CTP-640)", () => {
  it("paginates discovery with a real {page, pageSize} checkpoint — hasMore follows total_size, truncated only at the page cap", async () => {
    const calls: ClientCalls = { detail: [], listing: [] };
    const connector = connectorFor(
      scriptedClient({
        calls,
        pages: [
          { ids: ["aaa00001", "bbb00002"], totalSize: 3 },
          { ids: ["ccc00003"], totalSize: 3 },
        ],
      })
    );

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual([
      "aaa00001",
      "bbb00002",
    ]);
    // The checkpoint is REAL: the next page offset plus the page size the
    // first response implied — resume arithmetic needs both.
    expect(first.checkpoint).toEqual({ page: 1, pageSize: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.truncated).toBe(false);

    const second = await connector.discover(first.checkpoint);
    // Page 0 is never re-read; the resumed call went straight to page 1.
    expect(calls.listing).toEqual([0, 1]);
    expect(second.items.map((item) => item.bronReferentie)).toEqual([
      "ccc00003",
    ]);
    expect(second.checkpoint).toEqual({ page: 2, pageSize: 2 });
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(false);
  });

  it("a durable retake RESUMES at the committed page checkpoint — earlier pages are never re-read, and the run reports `resumed`", async () => {
    const scrapeRunId = "run-harveynash-resume";
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      killOn: { id: "ccc00003", once: { current: true } },
      pages: [
        { ids: ["aaa00001", "bbb00002"], totalSize: 5 },
        { ids: ["ccc00003", "ddd00004"], totalSize: 5 },
        { ids: ["eee00005"], totalSize: 5 },
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
    expect(calls.detail).toEqual(["aaa00001", "bbb00002", "ccc00003"]);
    expect(await store.load({ bronId: BRON_ID, scrapeRunId })).toMatchObject({
      checkpoint: { page: 1, pageSize: 2 },
    });

    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    // The retake re-read ONLY page 1 onward — page 0 is behind the cursor.
    expect(calls.listing).toEqual([0, 1, 1, 2]);
    // Page-0 items are not re-fetched: exactly-once there is the cursor's
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
    expect(result.observedBronReferenties.toSorted()).toEqual(
      ["ccc00003", "ddd00004", "eee00005"].toSorted()
    );
    // A run that resumed from a checkpoint reports `resumed`: the
    // application layer's missed-poll reconcile must skip it.
    expect(result.completeness).toEqual({ complete: false, reason: "resumed" });
    expect(recorder.records).toHaveLength(5);
    expect(recorder.observations).toHaveLength(5);
  });

  it("a head insert on an already-read page is invisible to the retake — the honest blind spot of a page cursor", async () => {
    const scrapeRunId = "run-harveynash-insert";
    const calls: ClientCalls = { detail: [], listing: [] };
    const pages: PageDef[] = [
      { ids: ["aaa00001"], totalSize: 2 },
      { ids: ["bbb00002"], totalSize: 2 },
    ];
    const client = scriptedClient({
      calls,
      killOn: { id: "bbb00002", once: { current: true } },
      pages,
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // A new item lands on page 0 while the run is down — the retake resumes
    // at page 1 and never sees it. The API's total grows with it so the
    // fresh poll still walks both pages.
    pages[0]?.ids.unshift("zzz99999");
    for (const page of pages) {
      page.totalSize = 3;
    }
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
    // re-reads page 0 — self-healing, never silently stale.
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

  it("a detail-only change lands a new observation — the listing row stays identical, which is exactly why knownHashes must stay unforwarded", async () => {
    const scrapeRunId = "run-harveynash-change";
    const detailBodies = new Map(
      ["aaa00001", "bbb00002"].map((id) => [id, detailFragmentFor(id)])
    );
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      detailBodies,
      pages: [{ ids: ["aaa00001", "bbb00002"], totalSize: 2 }],
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

    // Only the DETAIL payload changes (richttarief): the search row is
    // byte-identical, so hashHarveyNashListingItem returns the same listing
    // hash — had the registry forwarded knownHashes, this change would be
    // invisible forever.
    detailBodies.set(
      "bbb00002",
      detailFragmentFor("bbb00002", "Max tarief 110 euro")
    );
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
    const scrapeRunId = "run-harveynash-discoverfail";
    const calls: ClientCalls = { detail: [], listing: [] };
    const client = scriptedClient({
      calls,
      failOnPages: new Map([[1, { current: 1 }]]),
      pages: [
        { ids: ["aaa00001"], totalSize: 2 },
        { ids: ["bbb00002"], totalSize: 2 },
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
    expect(failEvent.input.progress.checkpoint).toEqual({
      page: 1,
      pageSize: 1,
    });
    expect(recorder.observations).toHaveLength(1);
  });

  it("an abort mid-item closes the run `failed` (RAW_STORE_WRITE_FAILED — persistence abort is never benign, CTP-490) at the pre-page checkpoint", async () => {
    const scrapeRunId = "run-harveynash-abort";
    const calls: ClientCalls = { detail: [], listing: [] };
    const controller = new AbortController();
    // Abort while the SECOND item's detail is being read: the fetch returns,
    // then the raw-store write sees the aborted signal and throws. Page 0 is
    // not complete, so no checkpoint ever commits.
    const client = scriptedClient({
      abortOn: { controller, id: "bbb00002" },
      calls,
      pages: [
        { ids: ["aaa00001", "bbb00002"], totalSize: 3 },
        { ids: ["ccc00003"], totalSize: 3 },
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
    expect(recorder.observations[0]?.bronReferentie).toBe("aaa00001");
  });

  it("marks the run truncated — never silently complete — when the 50-page cap cuts the listing short", async () => {
    const calls: ClientCalls = { detail: [], listing: [] };
    const connector = connectorFor(
      scriptedClient({
        calls,
        // Every page reports total_size far ahead: the cap decides.
        pages: Array.from({ length: 50 }, (_value, index) => ({
          ids: [`cap${String(index).padStart(6, "0")}`],
          totalSize: 100,
        })),
      })
    );

    // Walk the cap boundary: page 49 is the last discover the connector is
    // allowed to emit items for.
    let discovery = await connector.discover(null);
    for (let page = 1; page <= 49; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- page order is the contract under test
      discovery = await connector.discover(discovery.checkpoint);
    }
    expect(calls.listing).toHaveLength(50);
    expect(discovery.hasMore).toBe(false);
    expect(discovery.truncated).toBe(true);
  });
});
