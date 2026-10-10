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
import { asmlConfig } from "./configs/asml";
import { bamConfig } from "./configs/bam";
import { enecoConfig } from "./configs/eneco";
import { heijmansConfig } from "./configs/heijmans";
import { nsConfig } from "./configs/ns";
import { createJsonLdConnector } from "./connector";
import type { JsonLdConnectorConfig, JsonLdDiscoveryUrl } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-637: the L3a JSON-LD cohort (ASML, BAM, Eneco, Heijmans, NS) shares the
 * CTP-630 resume contract — there IS no page cursor. `discovery.kind` is
 * "sitemap" (asml, bam, eneco, heijmans) or "listing" (ns), so `discover()`
 * always returns the whole corpus with `hasMore: false` and an inert
 * `checkpoint: {}`. A durable retake therefore re-enumerates EVERY detail URL
 * and re-fetches every detail page; exactly-once comes from the observation
 * replay key (scrapeRunId + bronReferentie + contentHash), not from resuming
 * mid-listing. These specs pin that contract per bron.
 */

interface Corpus {
  entries: JsonLdDiscoveryUrl[];
}

interface ClientCalls {
  detail: string[];
  listing: number;
}

const detailPayload = (url: string): JsonLdDetailPayload => ({
  jobPosting: {
    "@type": "JobPosting",
    hiringOrganization: { "@type": "Organization", name: "Werkgever" },
    title: `Vacature ${url}`,
  },
  labelBlock: {},
  url,
});

/**
 * A single-page "feed" served from `corpus` at call time, so mutating the
 * array between attempts reproduces a sitemap/listing that shifted while the
 * run was down. `killOn` makes one detail read throw a
 * `RunOwnershipLostError`, which `runConnector` propagates without recording
 * a failure — the shape a killed worker leaves (`running` row, last
 * committed checkpoint).
 */
const scriptedClient = (options: {
  abortOn?: { controller: AbortController; url: string };
  calls: ClientCalls;
  corpus: Corpus;
  killOn?: { once: { current: boolean }; url: string };
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
    return Promise.resolve([...options.corpus.entries]);
  },
});

interface BronSpec {
  readonly config: JsonLdConnectorConfig;
  readonly label: string;
  /** Detail-page URLs in the bron's real shape; bronReferentie derives from the path. */
  readonly urlFor: (slug: string) => string;
}

const ASML: BronSpec = {
  config: asmlConfig,
  label: "asml",
  urlFor: (slug) =>
    `https://www.asml.com/en/careers/find-your-job/${slug}-j00100000`,
};

const BAM: BronSpec = {
  config: bamConfig,
  label: "bam",
  urlFor: (slug) => `https://www.bamcareers.com/nl/nl/job/99000/${slug}`,
};

const ENECO: BronSpec = {
  config: enecoConfig,
  label: "eneco",
  urlFor: (slug) => `https://www.werkenbijeneco.nl/vacatures/${slug}-9900`,
};

const HEIJMANS: BronSpec = {
  config: heijmansConfig,
  label: "heijmans",
  urlFor: (slug) =>
    `https://www.werkenbijheijmans.nl/vacatures/${slug}-v-099000`,
};

const NS: BronSpec = {
  config: nsConfig,
  label: "ns",
  urlFor: (slug) => `https://www.werkenbijns.nl/vacatures/${slug}-9900000`,
};

const referentieFor = (spec: BronSpec, slug: string): string =>
  new URL(spec.urlFor(slug)).pathname.replaceAll(/^\/+|\/+$/gu, "");

const corpusOf = (spec: BronSpec, slugs: string[]): Corpus => ({
  entries: slugs.map((slug) => ({
    lastmod: "2026-09-19T08:00:00+00:00",
    url: spec.urlFor(slug),
  })),
});

const runWithStore = (options: {
  bronId: string;
  client: JsonLdClient;
  config: JsonLdConnectorConfig;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  signal?: AbortSignal;
  store: InMemoryRunLifecycleStore;
}): Promise<ConnectorRunResult> =>
  runConnector({
    bronId: options.bronId,
    bronSlug: options.config.slug,
    connector: createJsonLdConnector({
      bronId: options.bronId,
      client: options.client,
      config: options.config,
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

describe.each([
  ["asml", ASML],
  ["bam", BAM],
  ["eneco", ENECO],
  ["heijmans", HEIJMANS],
  ["ns", NS],
])("%s durable-cohort resume contract (CTP-637)", (_label, spec) => {
  const slugs = ["alpha-1", "beta-2", "gamma-3"];
  const refs = slugs.map((slug) => referentieFor(spec, slug));

  it("enumerates the whole corpus in one discover call — hasMore: false, an inert empty checkpoint, never truncated", async () => {
    const corpus = corpusOf(spec, slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const connector = createJsonLdConnector({
      bronId: `bron-${spec.label}-discover`,
      client: scriptedClient({ calls, corpus }),
      config: spec.config,
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
    const bronId = `bron-${spec.label}-resume`;
    const scrapeRunId = `run-${spec.label}-resume`;
    const corpus = corpusOf(spec, slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    // Attempt 1 persists the first item, then the process "dies" inside the
    // second item's detail read: RunOwnershipLostError propagates without
    // closing the row.
    const client = scriptedClient({
      calls,
      corpus,
      killOn: { once: { current: true }, url: spec.urlFor("beta-2") },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({
        bronId,
        client,
        config: spec.config,
        recorder,
        scrapeRunId,
        store,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(calls).toEqual({
      detail: [spec.urlFor("alpha-1"), spec.urlFor("beta-2")],
      listing: 1,
    });
    // No page ever completed, so nothing was checkpointed: the row is
    // `running` with the run's initial (null) progress.
    expect(await store.load({ bronId, scrapeRunId })).toMatchObject({
      checkpoint: null,
    });

    const result = await runWithStore({
      bronId,
      client,
      config: spec.config,
      recorder,
      scrapeRunId,
      store,
    });

    // The retake re-read the sitemap/listing AND every detail page — a
    // whole-corpus re-enumeration is this cohort's "resume".
    expect(calls.listing).toBe(2);
    expect(calls.detail).toHaveLength(2 + slugs.length);
    expect(result.observedBronReferenties.toSorted()).toEqual(refs.toSorted());
    // Because no checkpoint survived, the retake is a complete enumeration:
    // `complete: true`, so missed-poll reconciliation applies in full.
    expect(result.completeness).toEqual({ complete: true });
    // Exactly-once: the item persisted by attempt 1 was re-fetched and
    // re-recorded under the same scrapeRunId, but the replay key
    // (scrapeRunId + bronReferentie + contentHash) returned the stored
    // outcome instead of appending a second observation.
    expect(recorder.records).toHaveLength(slugs.length);
    expect(recorder.observations).toHaveLength(slugs.length);
  });

  it("picks up a head insert on the retake itself — there is no read-pages blind spot", async () => {
    const bronId = `bron-${spec.label}-insert`;
    const scrapeRunId = `run-${spec.label}-insert`;
    const corpus = corpusOf(spec, slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({
      calls,
      corpus,
      killOn: { once: { current: true }, url: spec.urlFor("beta-2") },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({
        bronId,
        client,
        config: spec.config,
        recorder,
        scrapeRunId,
        store,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // A new item appears while the run is down. Unlike a paged feed — where
    // a head insert before the cursor waits for the next fresh poll — this
    // cohort's retake re-enumerates everything, so the insert is observed
    // immediately.
    corpus.entries.unshift({
      lastmod: "2026-09-20T08:00:00+00:00",
      url: spec.urlFor("nieuw-0"),
    });
    const result = await runWithStore({
      bronId,
      client,
      config: spec.config,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties.toSorted()).toEqual(
      [...refs, referentieFor(spec, "nieuw-0")].toSorted()
    );
    expect(recorder.records).toHaveLength(slugs.length + 1);
    // Still exactly-once for the re-observed item from attempt 1.
    expect(
      recorder.observations.filter(
        (observation) =>
          observation.bronReferentie === referentieFor(spec, "alpha-1")
      )
    ).toHaveLength(1);
  });

  it("a deletion between attempts simply drops out of the retake's enumeration", async () => {
    const bronId = `bron-${spec.label}-delete`;
    const scrapeRunId = `run-${spec.label}-delete`;
    const corpus = corpusOf(spec, slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({
      calls,
      corpus,
      killOn: { once: { current: true }, url: spec.urlFor("beta-2") },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({
        bronId,
        client,
        config: spec.config,
        recorder,
        scrapeRunId,
        store,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // alpha-1 was persisted by attempt 1, then delisted while the run was
    // down. The retake's whole-corpus enumeration just does not list it —
    // no page cursor means no already-read territory it could hide in.
    corpus.entries.splice(0, 1);
    const result = await runWithStore({
      bronId,
      client,
      config: spec.config,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties.toSorted()).toEqual(
      [referentieFor(spec, "beta-2"), referentieFor(spec, "gamma-3")].toSorted()
    );
    // The connector writes no tombstone itself; because this retake is a
    // complete enumeration (`complete: true`), the application layer's
    // missed-poll reconcile counts the delisted record on this very run.
    expect(result.completeness).toEqual({ complete: true });
    expect(recorder.records).toHaveLength(slugs.length);
  });

  it("a kill between the checkpoint write and complete() leaves a `running` row at checkpoint {}; its retake is `resumed` but still re-reads everything", async () => {
    const bronId = `bron-${spec.label}-postcheckpoint`;
    const scrapeRunId = `run-${spec.label}-postcheckpoint`;
    const corpus = corpusOf(spec, slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const client = scriptedClient({ calls, corpus });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();
    // The one narrow window where a checkpoint DOES survive: after the
    // single page's items persist and `checkpoint` commits `{}`, but before
    // `complete` lands. Simulated by failing the store's first complete().
    const realComplete = store.complete.bind(store);
    const killComplete = { current: true };
    store.complete = (input) => {
      if (killComplete.current) {
        killComplete.current = false;
        return Promise.reject(new RunOwnershipLostError());
      }
      return realComplete(input);
    };

    await expect(
      runWithStore({
        bronId,
        client,
        config: spec.config,
        recorder,
        scrapeRunId,
        store,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    // All three items persisted, the empty checkpoint committed, and the row
    // is still `running` — the exact residue a crashed worker leaves here.
    expect(await store.load({ bronId, scrapeRunId })).toMatchObject({
      checkpoint: {},
    });
    expect(recorder.observations).toHaveLength(slugs.length);

    const result = await runWithStore({
      bronId,
      client,
      config: spec.config,
      recorder,
      scrapeRunId,
      store,
    });

    // A non-null checkpoint makes the retake formally "resumed" even though
    // it re-read the whole corpus. Documented gap: completeness `resumed`
    // suppresses missed-poll reconciliation for this run, so a record
    // delisted during this exact window keeps missed_polls at 0 until the
    // next fresh (complete) poll — self-healing, never silently stale.
    expect(result.completeness).toEqual({ complete: false, reason: "resumed" });
    expect(calls.listing).toBe(2);
    expect(result.observedBronReferenties.toSorted()).toEqual(refs.toSorted());
    // Every item was re-fetched and absorbed by the replay key — still one
    // observation and one source record per bronReferentie.
    expect(recorder.observations).toHaveLength(slugs.length);
    expect(recorder.records).toHaveLength(slugs.length);
  });

  it("an abort mid-item closes the run `failed` (persistence abort is never benign — CTP-490), with no committed checkpoint", async () => {
    const bronId = `bron-${spec.label}-abort`;
    const scrapeRunId = `run-${spec.label}-abort`;
    const corpus = corpusOf(spec, slugs);
    const calls: ClientCalls = { detail: [], listing: 0 };
    const controller = new AbortController();
    // Abort while the SECOND item's detail is being read: the fetch returns,
    // then the raw-store write sees the aborted signal and throws — and a
    // persistence-phase abort is recorded as a real failure, never a benign
    // `aborted` completion.
    const client = scriptedClient({
      abortOn: { controller, url: spec.urlFor("beta-2") },
      calls,
      corpus,
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({
        bronId,
        client,
        config: spec.config,
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
    // The row is terminal `failed` holding the pre-page (null) checkpoint:
    // on Postgres the durable retake reopens it via `reopenFailed` (CTP-643)
    // and re-enumerates the whole corpus — proven against real Postgres in
    // apps/worker/src/poller/json-ld-cohort-l3a.integration.spec.ts. The
    // in-memory store cannot reopen a terminal row, so no retake is driven
    // here.
    const lastStart = store.events.findLast((event) => event.type === "start");
    expect(lastStart?.type).toBe("start");
    expect(recorder.observations).toHaveLength(1);
  });
});
