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
import type { Connector, ConnectorRunResult } from "@ji/connectors";

import type { FlinterClient } from "./client";
import { createFlinterConnector } from "./connector";
import type { FlinterListingItem } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-639 L3c: Flinter's durable-resume contract looks like the sitemap
 * cohort's on the discovery side — `/opdrachten` is one unpaginated SSR
 * listing, so `discover()` always returns the whole corpus with
 * `hasMore: false` and an inert `checkpoint: {}` — but NOT on the fetch
 * side: every item triggers a real per-slug detail request
 * (`fetchUsesNetwork` is left network-backed).
 *
 * `listingHashCoversDetail: false` and `knownHashes` is DELIBERATELY not
 * forwarded by the source definition (RJC-357/RJC-401): the listing hash
 * cannot see detail-page fields (titel/beschrijving/tarief/uren, and the
 * permanent-vacancy rejection), so a listing-hash skip would freeze
 * detail-only changes. A durable retake therefore re-reads the listing AND
 * re-fetches every detail page; exactly-once comes from the observation
 * replay key (scrapeRunId + bronReferentie + contentHash), not from the
 * known-hash store. These specs pin that contract.
 */

const BRON_ID = "bron-flinter-l3c";

interface Corpus {
  entries: FlinterListingItem[];
}

interface ClientCalls {
  detail: string[];
  listing: number;
}

const listingItem = (slug: string): FlinterListingItem => ({
  locatiePlaats: "Ridderkerk",
  looptijdTekst: "6 mnd",
  looptijdValid: true,
  opdrachtgeverNaam: "Opdrachtgever B.V.",
  slug,
  titel: `Opdracht ${slug}`,
});

const corpusOf = (slugs: string[]): Corpus => ({
  entries: slugs.map(listingItem),
});

/**
 * Minimal SSR detail page in Flinter's real shape: `parseFlinterDetail`
 * reads the first `<h2>` after the `block-hero-content` marker for `titel`
 * and the two vacancy-show sections for `beschrijvingHtml`. Titles differ
 * per slug so a scripted "payload changed at the source" is a titel swap.
 */
const detailHtmlFor = (slug: string, titel?: string): string => `<html><body>
<div class="block-hero-content"><h2>${titel ?? `Detail ${slug}`}</h2></div>
<div class="vacancy-show-job-description"><p>Beschrijving ${slug}.</p></div>
<div class="vacancy-show-function-description"><p>Praktische zaken: 36 uur p/w.</p></div>
</body></html>`;

/**
 * The listing served from `corpus` at call time, so mutating the array
 * between attempts reproduces a page that shifted while the run was down.
 * `killOn` makes one detail read throw a `RunOwnershipLostError`, which
 * `runConnector` propagates without recording a failure — the shape a
 * killed worker leaves (`running` row, last committed checkpoint).
 * `abortOn` fires the attempt's signal inside one detail read so the
 * raw-store write that follows lands on an aborted signal. `detailBodies`
 * overrides per-slug detail HTML for the changed-payload case.
 */
const scriptedClient = (options: {
  abortOn?: { controller: AbortController; slug: string };
  calls: ClientCalls;
  corpus: Corpus;
  detailBodies?: Map<string, string>;
  killOn?: { once: { current: boolean }; slug: string };
  listingFailuresLeft?: { current: number };
}): FlinterClient => ({
  fetchDetailHtml: (slug) => {
    options.calls.detail.push(slug);
    if (options.abortOn && slug === options.abortOn.slug) {
      options.abortOn.controller.abort();
    }
    if (
      options.killOn &&
      slug === options.killOn.slug &&
      options.killOn.once.current
    ) {
      options.killOn.once.current = false;
      return Promise.reject(new RunOwnershipLostError());
    }
    return Promise.resolve(
      options.detailBodies?.get(slug) ?? detailHtmlFor(slug)
    );
  },
  fetchListing: () => {
    options.calls.listing += 1;
    if (
      options.listingFailuresLeft &&
      options.listingFailuresLeft.current > 0
    ) {
      options.listingFailuresLeft.current -= 1;
      return Promise.reject(new Error("scripted Flinter listing outage"));
    }
    return Promise.resolve([...options.corpus.entries]);
  },
});

const connectorFor = (client: FlinterClient): Connector =>
  createFlinterConnector({ bronId: BRON_ID, client });

const runWithStore = (options: {
  client: FlinterClient;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  signal?: AbortSignal;
  store: InMemoryRunLifecycleStore;
}): Promise<ConnectorRunResult> =>
  runConnector({
    bronId: BRON_ID,
    bronSlug: "flinter",
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

const SLUGS = ["alpha-1", "beta-2", "gamma-3"];

describe("flinter durable-cohort resume contract (CTP-639)", () => {
  it("enumerates the whole listing in one discover call — hasMore: false, inert empty checkpoint, never truncated", async () => {
    const corpus = corpusOf(SLUGS);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const connector = connectorFor(scriptedClient({ calls, corpus }));

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual(SLUGS);
    // Single-page discovery: no cursor exists. The checkpoint is `{}` —
    // present only because the contract requires an object — and a "resumed"
    // discover ignores it and re-reads the same whole listing.
    expect(first.checkpoint).toEqual({});
    expect(first.hasMore).toBe(false);
    expect(first.truncated).toBeUndefined();

    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(SLUGS);
    expect(second.hasMore).toBe(false);
    expect(calls.listing).toBe(2);
  });

  it("a durable retake of a killed run re-enumerates the listing AND re-fetches every detail; the replay key absorbs persisted items", async () => {
    const scrapeRunId = "run-flinter-resume";
    const corpus = corpusOf(SLUGS);
    const calls: ClientCalls = { detail: [], listing: 0 };
    // Attempt 1 persists the first item, then the process "dies" inside the
    // second item's detail read: RunOwnershipLostError propagates without
    // closing the row.
    const client = scriptedClient({
      calls,
      corpus,
      killOn: { once: { current: true }, slug: "beta-2" },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(calls).toEqual({ detail: ["alpha-1", "beta-2"], listing: 1 });
    expect(await store.load({ bronId: BRON_ID, scrapeRunId })).toMatchObject({
      checkpoint: null,
    });

    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    // The retake re-read the listing AND every detail page — because
    // knownHashes is deliberately not forwarded, nothing short-circuits the
    // detail reads. Exactly-once is the replay key's job here.
    expect(calls.listing).toBe(2);
    expect(calls.detail).toHaveLength(2 + SLUGS.length);
    expect(result.observedBronReferenties.toSorted()).toEqual(SLUGS.toSorted());
    expect(result.completeness).toEqual({ complete: true });
    expect(recorder.records).toHaveLength(SLUGS.length);
    expect(recorder.observations).toHaveLength(SLUGS.length);
  });

  it("a detail-only change lands a new observation — the listing hash stays identical, which is exactly why knownHashes must stay unforwarded", async () => {
    const scrapeRunId = "run-flinter-detail-change";
    const corpus = corpusOf(SLUGS);
    const detailBodies = new Map(
      SLUGS.map((slug) => [slug, detailHtmlFor(slug)])
    );
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({ calls, corpus, detailBodies });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-1`,
      store,
    });
    const before = recorder.records.find(
      (record) => record.bronReferentie === "beta-2"
    );
    if (!before) {
      throw new Error("expected a persisted record for beta-2");
    }

    // Only the DETAIL body changes (titel swap): the listing row is
    // byte-identical, so `hashFlinterListingItem` returns the same listing
    // hash — had the registry forwarded knownHashes, this change would be
    // invisible forever. The fetch still happens (no skip), the payload hash
    // differs, and the observation is appended.
    detailBodies.set("beta-2", detailHtmlFor("beta-2", "Gewijzigde beta-2"));
    await runWithStore({
      client,
      recorder,
      scrapeRunId: `${scrapeRunId}-2`,
      store: new InMemoryRunLifecycleStore(),
    });

    const after = recorder.records.find(
      (record) => record.bronReferentie === "beta-2"
    );
    expect(after?.contentHash).not.toBe(before.contentHash);
    // One new observation for the changed item; the unchanged two replayed
    // as `unchanged` without new rows... under a fresh scrapeRunId the
    // recorder appends every fetch's observation — dedupe is by record key,
    // and records stay one per bronReferentie.
    expect(recorder.observations).toHaveLength(SLUGS.length * 2);
    expect(recorder.records).toHaveLength(SLUGS.length);
  });

  it("picks up a head insert on the retake itself — there is no read-pages blind spot", async () => {
    const scrapeRunId = "run-flinter-insert";
    const corpus = corpusOf(SLUGS);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({
      calls,
      corpus,
      killOn: { once: { current: true }, slug: "beta-2" },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    corpus.entries.unshift(listingItem("nieuw-0"));
    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties.toSorted()).toEqual(
      [...SLUGS, "nieuw-0"].toSorted()
    );
    expect(recorder.records).toHaveLength(SLUGS.length + 1);
  });

  it("a failed listing read closes the run `failed` (DISCOVER_FAILED) with no committed checkpoint", async () => {
    const scrapeRunId = "run-flinter-discoverfail";
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({
      calls,
      corpus: corpusOf(SLUGS),
      listingFailuresLeft: { current: 1 },
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
    // Terminal `failed` at the null checkpoint: on Postgres the durable
    // retake reopens it via `reopenFailed` (CTP-643) and re-enumerates the
    // whole listing — proven in
    // apps/worker/src/poller/l3c-cohort.integration.spec.ts.
    expect(recorder.observations).toHaveLength(0);
  });

  it("an abort mid-item closes the run `failed` (RAW_STORE_WRITE_FAILED — persistence abort is never benign, CTP-490), with no committed checkpoint", async () => {
    const scrapeRunId = "run-flinter-abort";
    const calls: ClientCalls = { detail: [], listing: 0 };
    const controller = new AbortController();
    // Abort while the SECOND item's detail is being read: the fetch returns,
    // then the raw-store write sees the aborted signal and throws.
    const client = scriptedClient({
      abortOn: { controller, slug: "beta-2" },
      calls,
      corpus: corpusOf(SLUGS),
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
    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]?.bronReferentie).toBe("alpha-1");
  });
});
