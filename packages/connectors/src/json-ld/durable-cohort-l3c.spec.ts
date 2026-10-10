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

import type { JsonLdClient, JsonLdDetailPayload } from "./client";
import { haertConfig } from "./configs/haert";
import { createJsonLdConnector } from "./connector";
import type { JsonLdDiscoveryUrl } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-639: Haert is the L3c cohort's JSON-LD bron and shares the CTP-630
 * resume contract the L3a/L3b cohorts already proved — there IS no page
 * cursor. `discovery.kind` is "sitemap", so `discover()` always returns the
 * whole filtered corpus with `hasMore: false` and an inert
 * `checkpoint: {}`. A durable retake therefore re-enumerates EVERY detail
 * URL and re-fetches every detail page; exactly-once comes from the
 * observation replay key (scrapeRunId + bronReferentie + contentHash), not
 * from resuming mid-listing. Unlike the L3c feed siblings, `knownHashes` IS
 * forwarded by the registry wiring — but the sitemap only carries
 * URL+lastmod (`listingHashCoversDetail: false`), so a matching listing hash
 * skips the detail fetch, the same optimisation the L3b bronnen run with.
 *
 * This file exists next to `durable-cohort-l3a.spec.ts`/
 * `durable-cohort-l3b.spec.ts` rather than inside either: L3c is a mixed
 * cohort tracked as one deliverable, and Haert is its only JSON-LD member —
 * a separate file keeps the cohort boundary readable.
 */

interface Corpus {
  entries: JsonLdDiscoveryUrl[];
}

interface ClientCalls {
  detail: string[];
  listing: number;
}

const BRON_ID = "bron-haert-l3c";

const detailPayload = (url: string): JsonLdDetailPayload => ({
  jobPosting: {
    "@type": "JobPosting",
    hiringOrganization: { "@type": "Organization", name: "Haert" },
    title: `Vacature ${url}`,
  },
  labelBlock: {},
  url,
});

const urlFor = (slug: string): string =>
  `https://www.haert.nl/opdrachten/${slug}-99999`;

const referentieFor = (slug: string): string =>
  new URL(urlFor(slug)).pathname.replaceAll(/^\/+|\/+$/gu, "");

const corpusOf = (slugs: string[]): Corpus => ({
  entries: slugs.map((slug) => ({
    lastmod: "2026-09-19T08:00:00+00:00",
    url: urlFor(slug),
  })),
});

/**
 * A single-page "listing" served from `corpus` at call time, so mutating
 * the array between attempts reproduces a sitemap that shifted while the
 * run was down. `killOn` makes one detail read throw a
 * `RunOwnershipLostError`, which `runConnector` propagates without
 * recording a failure — the shape a killed worker leaves (`running` row,
 * last committed checkpoint). `abortOn` fires the attempt's signal inside
 * one detail read; `listingFailuresLeft` scripts a sitemap outage.
 */
const scriptedClient = (options: {
  abortOn?: { controller: AbortController; url: string };
  calls: ClientCalls;
  corpus: Corpus;
  killOn?: { once: { current: boolean }; url: string };
  listingFailuresLeft?: { current: number };
}): JsonLdClient => ({
  fetchDetail: (url) => {
    options.calls.detail.push(url);
    if (options.abortOn && url === options.abortOn.url) {
      options.abortOn.controller.abort();
    }
    if (
      options.killOn &&
      url === options.killOn.url &&
      options.killOn.once.current
    ) {
      options.killOn.once.current = false;
      return Promise.reject(new RunOwnershipLostError());
    }
    return Promise.resolve(detailPayload(url));
  },
  fetchListing: () => {
    options.calls.listing += 1;
    if (
      options.listingFailuresLeft &&
      options.listingFailuresLeft.current > 0
    ) {
      options.listingFailuresLeft.current -= 1;
      return Promise.reject(new Error("scripted Haert sitemap outage"));
    }
    return Promise.resolve([...options.corpus.entries]);
  },
});

const runWithStore = (options: {
  client: JsonLdClient;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  signal?: AbortSignal;
  store: InMemoryRunLifecycleStore;
}): Promise<ConnectorRunResult> =>
  runConnector({
    bronId: BRON_ID,
    bronSlug: haertConfig.slug,
    connector: createJsonLdConnector({
      bronId: BRON_ID,
      client: options.client,
      config: haertConfig,
    }),
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

describe("haert durable-cohort resume contract (CTP-639)", () => {
  const slugs = ["alpha-1", "beta-2", "gamma-3"];
  const refs = slugs.map(referentieFor);

  it("enumerates the whole filtered sitemap in one discover call — hasMore: false, an inert empty checkpoint, never truncated", async () => {
    const corpus = corpusOf(slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const connector = createJsonLdConnector({
      bronId: BRON_ID,
      client: scriptedClient({ calls, corpus }),
      config: haertConfig,
    });

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual(refs);
    // Single-page discovery: no cursor exists. The checkpoint is `{}` —
    // present only because the contract requires an object — and a "resumed"
    // discover ignores it and re-reads the same whole corpus.
    expect(first.checkpoint).toEqual({});
    expect(first.hasMore).toBe(false);
    // RJC-397: no page cap exists here, so the connector may never mark a
    // `hasMore: false` result as truncated; absent is the only honest value.
    expect(first.truncated).toBeUndefined();

    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(refs);
    expect(second.hasMore).toBe(false);
    expect(calls.listing).toBe(2);
  });

  it("a durable retake of a killed run re-enumerates the whole corpus; the replay key absorbs persisted items", async () => {
    const scrapeRunId = "run-haert-resume";
    const corpus = corpusOf(slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    // Attempt 1 persists the first item, then the process "dies" inside the
    // second item's detail read: RunOwnershipLostError propagates without
    // closing the row.
    const client = scriptedClient({
      calls,
      corpus,
      killOn: { once: { current: true }, url: urlFor("beta-2") },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(calls).toEqual({
      detail: [urlFor("alpha-1"), urlFor("beta-2")],
      listing: 1,
    });
    expect(await store.load({ bronId: BRON_ID, scrapeRunId })).toMatchObject({
      checkpoint: null,
    });

    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    // The retake re-read the sitemap AND every detail page — a whole-corpus
    // re-enumeration is this bron's "resume".
    expect(calls.listing).toBe(2);
    expect(calls.detail).toHaveLength(2 + slugs.length);
    expect(result.observedBronReferenties.toSorted()).toEqual(refs.toSorted());
    expect(result.completeness).toEqual({ complete: true });
    // Exactly-once: the item persisted by attempt 1 was re-fetched and
    // re-recorded under the same scrapeRunId, but the replay key
    // (scrapeRunId + bronReferentie + contentHash) returned the stored
    // outcome instead of appending a second observation.
    expect(recorder.records).toHaveLength(slugs.length);
    expect(recorder.observations).toHaveLength(slugs.length);
  });

  it("picks up a head insert on the retake itself — there is no read-pages blind spot", async () => {
    const scrapeRunId = "run-haert-insert";
    const corpus = corpusOf(slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({
      calls,
      corpus,
      killOn: { once: { current: true }, url: urlFor("beta-2") },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // A new detail URL appears while the run is down. Unlike freelancer-nl's
    // page cursor — where a head insert before the cursor waits for the next
    // fresh poll — this bron's retake re-enumerates everything, so the
    // insert is observed immediately.
    corpus.entries.unshift({
      lastmod: "2026-09-20T08:00:00+00:00",
      url: urlFor("nieuw-0"),
    });
    const result = await runWithStore({
      client,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties.toSorted()).toEqual(
      [...refs, referentieFor("nieuw-0")].toSorted()
    );
    expect(recorder.records).toHaveLength(slugs.length + 1);
  });

  it("a failed sitemap read closes the run `failed` (DISCOVER_FAILED) with no committed checkpoint", async () => {
    const scrapeRunId = "run-haert-discoverfail";
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({
      calls,
      corpus: corpusOf(slugs),
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
    // whole corpus — proven in
    // apps/worker/src/poller/l3c-cohort.integration.spec.ts.
    expect(recorder.observations).toHaveLength(0);
  });

  it("an abort mid-item closes the run `failed` (RAW_STORE_WRITE_FAILED — persistence abort is never benign, CTP-490), with no committed checkpoint", async () => {
    const scrapeRunId = "run-haert-abort";
    const corpus = corpusOf(slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const controller = new AbortController();
    // Abort while the SECOND item's detail is being read: the fetch returns,
    // then the raw-store write sees the aborted signal and throws.
    const client = scriptedClient({
      abortOn: { controller, url: urlFor("beta-2") },
      calls,
      corpus,
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
    expect(recorder.observations[0]?.bronReferentie).toBe(
      referentieFor("alpha-1")
    );
  });
});
