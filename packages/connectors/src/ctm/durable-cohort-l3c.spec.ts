import { describe, expect, it } from "bun:test";

import {
  ConnectorRunFailure,
  CrawlDelayLimiter,
  InMemoryKnownHashStore,
  InMemoryObservationRecorder,
  InMemoryObjectStore,
  InMemoryRunLifecycleStore,
  runConnector,
  RunOwnershipLostError,
} from "@ji/connectors";
import type {
  Connector,
  ConnectorRunResult,
  DiscoverItem,
} from "@ji/connectors";

import type { CtmClient } from "./client";
import { createCtmConnector } from "./connector";
import { hashCtmListingItem } from "./hash";
import type { CtmEntry } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-639 L3c: CTM's durable-resume contract differs from the sitemap cohort
 * in two ways that this spec pins honestly.
 *
 * 1. The checkpoint is populated but inert. The feed is a single ungapped
 *    `days=30` Atom window — `discover()` returns every entry with
 *    `hasMore: false` and `checkpoint: { cursor: <feed updatedAt> }`. The
 *    cursor records WHEN the window was last published; a retake ignores it
 *    and re-reads the whole feed. Exactly-once on a retake therefore comes
 *    from the observation replay key (scrapeRunId + bronReferentie +
 *    contentHash), never from a page cursor.
 *
 * 2. `listingHashCoversDetail: true` (RJC-357/RJC-401): `fetch()` re-serialises
 *    the Atom entry the listing already carried — there is NO detail request
 *    (`fetchUsesNetwork: false`). The change vector is the feed entry itself:
 *    a mutated entry changes the listing hash, which defeats the production
 *    `knownHashes` short-circuit, so the re-serialised payload lands as a
 *    `changed` observation. On an UNCHANGED repeat poll the known-hash skip
 *    fires inside `fetch()` and nothing is re-persisted at all — CTM's
 *    dedupe point sits one layer earlier than the sitemap cohort's.
 */

const BRON_ID = "bron-ctm-l3c";

interface Corpus {
  entries: CtmEntry[];
  updatedAt: string;
}

interface ClientCalls {
  listing: number;
}

const entry = (nummer: string, titel?: string): CtmEntry => ({
  aanvraagnummer: nummer,
  link: `https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=${nummer}&PP=transactions.asp&B=CTMSOLUTION&PS=1`,
  organisatie: "Anculus B.V.",
  publicatiedatum: "2026-08-26T04:34:00+02:00",
  referentie: `https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=${nummer}&PP=transactions.asp&B=CTMSOLUTION&PS=1`,
  sluitingstijd: "2026-10-13T11:00:00",
  titel: titel ?? `Openbare Europese aanbesteding ${nummer}`,
});

const corpus = (nummers: string[]): Corpus => ({
  entries: nummers.map((nummer) => entry(nummer)),
  updatedAt: "2026-08-30T22:04:57Z",
});

/**
 * The feed window served from `corpus` at call time, so mutating the array
 * between attempts reproduces a feed that shifted while the run was down.
 * `listingFailuresLeft` makes discover() throw for the scripted outage.
 */
const scriptedClient = (options: {
  calls: ClientCalls;
  corpus: Corpus;
  listingFailuresLeft?: { current: number };
}): CtmClient => ({
  fetchListing: () => {
    options.calls.listing += 1;
    if (
      options.listingFailuresLeft &&
      options.listingFailuresLeft.current > 0
    ) {
      options.listingFailuresLeft.current -= 1;
      return Promise.reject(new Error("scripted CTM feed outage"));
    }
    return Promise.resolve({
      entries: [...options.corpus.entries],
      updatedAt: options.corpus.updatedAt,
    });
  },
});

/**
 * CTM's fetch() has no client call to inject into, so kill/abort scripting
 * wraps the CONNECTOR: `killOn` throws RunOwnershipLostError inside one
 * fetch (the residue a killed worker leaves — `running` row, last committed
 * checkpoint), `abortOn` fires the attempt's signal inside one fetch so the
 * raw-store write that follows lands on an aborted signal.
 */
const scriptedConnector = (options: {
  abortOn?: { controller: AbortController; fetchIndex: number };
  client: CtmClient;
  fetches: { count: number };
  killOn?: { fetchIndex: number; once: { current: boolean } };
  knownHashes?: InMemoryKnownHashStore;
}): Connector => {
  const inner = createCtmConnector({
    bronId: BRON_ID,
    client: options.client,
    knownHashes: options.knownHashes,
  });
  return {
    bronId: inner.bronId,
    discover: (checkpoint, signal) => inner.discover(checkpoint, signal),
    fetch: (item: DiscoverItem, signal) => {
      options.fetches.count += 1;
      if (options.abortOn?.fetchIndex === options.fetches.count) {
        options.abortOn.controller.abort();
      }
      if (
        options.killOn &&
        options.killOn.fetchIndex === options.fetches.count &&
        options.killOn.once.current
      ) {
        options.killOn.once.current = false;
        return Promise.reject(new RunOwnershipLostError());
      }
      return inner.fetch(item, signal);
    },
    fetchUsesNetwork: inner.fetchUsesNetwork,
  };
};

const runWithStore = (options: {
  connector: Connector;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  signal?: AbortSignal;
  store: InMemoryRunLifecycleStore;
}): Promise<ConnectorRunResult> =>
  runConnector({
    bronId: BRON_ID,
    bronSlug: "ctm",
    connector: options.connector,
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

const NUMMERS = ["460057", "460060", "459877"];

describe("ctm durable-cohort resume contract (CTP-639)", () => {
  it("enumerates the whole feed window in one discover call — hasMore: false, populated-but-inert cursor checkpoint, never truncated", async () => {
    const calls: ClientCalls = { listing: 0 };
    const connector = createCtmConnector({
      bronId: BRON_ID,
      client: scriptedClient({ calls, corpus: corpus(NUMMERS) }),
    });

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual(NUMMERS);
    // Unlike the sitemap cohort's inert `{}`, CTM's checkpoint carries the
    // feed's <updated> timestamp. It is still inert: a "resumed" discover
    // ignores it and re-reads the same whole window.
    expect(first.checkpoint).toEqual({ cursor: "2026-08-30T22:04:57Z" });
    expect(first.hasMore).toBe(false);
    expect(first.truncated).toBeUndefined();

    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(NUMMERS);
    expect(second.hasMore).toBe(false);
    expect(calls.listing).toBe(2);
  });

  it("fetch() re-serialises the listing entry without any detail request — the feed entry IS the change vector", async () => {
    const calls: ClientCalls = { listing: 0 };
    const connector = createCtmConnector({
      bronId: BRON_ID,
      client: scriptedClient({ calls, corpus: corpus(NUMMERS) }),
    });
    // Pinned: CTM never touches the network in fetch() — the runner must not
    // route this connector's item fetches through the crawl-delay limiter.
    expect(connector.fetchUsesNetwork).toBe(false);

    const discovery = await connector.discover(null);
    const [item] = discovery.items;
    if (!item) {
      throw new Error("expected at least one feed entry");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("fetched");
    // Still one listing read total: the item's payload came from the entry
    // discover() already carried, not a second upstream request.
    expect(calls.listing).toBe(1);
  });

  it("a durable retake of a killed run re-reads the whole window; the replay key absorbs the persisted item", async () => {
    const scrapeRunId = "run-ctm-kill";
    const calls: ClientCalls = { listing: 0 };
    const fetches = { count: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, corpus: corpus(NUMMERS) }),
      fetches,
      killOn: { fetchIndex: 2, once: { current: true } },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // Attempt 1 persists the first entry, then "dies" inside the second
    // entry's fetch: RunOwnershipLostError propagates without closing the row.
    await expect(
      runWithStore({ connector, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(fetches.count).toBe(2);
    expect(await store.load({ bronId: BRON_ID, scrapeRunId })).toMatchObject({
      checkpoint: null,
    });

    const result = await runWithStore({
      connector,
      recorder,
      scrapeRunId,
      store,
    });

    // Whole-window re-enumeration: the feed is read again and every entry is
    // re-presented to fetch — there is no page cursor to resume from.
    expect(calls.listing).toBe(2);
    expect(fetches.count).toBe(2 + NUMMERS.length);
    expect(result.observedBronReferenties.toSorted()).toEqual(
      NUMMERS.toSorted()
    );
    expect(result.completeness).toEqual({ complete: true });
    // Exactly-once: the entry attempt 1 persisted was re-serialised under the
    // same scrapeRunId; the replay key returned the stored outcome instead of
    // appending a second observation.
    expect(recorder.records).toHaveLength(NUMMERS.length);
    expect(recorder.observations).toHaveLength(NUMMERS.length);
  });

  it("with the production known-hash wiring, an unchanged repeat run skips every fetch — CTM's dedupe sits before the recorder", async () => {
    const scrapeRunId = "run-ctm-knownhash";
    const calls: ClientCalls = { listing: 0 };
    const feedCorpus = corpus(NUMMERS);
    const knownHashes = new InMemoryKnownHashStore();
    // The Postgres store reads source_record.listing_hash; seed it with what
    // a prior poll persisted — the discover-tier listing hash per entry.
    const persistedHashes = await Promise.all(
      feedCorpus.entries.map((feedEntry) => hashCtmListingItem(feedEntry))
    );
    for (const [index, feedEntry] of feedCorpus.entries.entries()) {
      knownHashes.set(
        BRON_ID,
        feedEntry.aanvraagnummer,
        persistedHashes[index] ?? ""
      );
    }
    const fetches = { count: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, corpus: feedCorpus }),
      fetches,
      knownHashes,
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    const result = await runWithStore({
      connector,
      recorder,
      scrapeRunId,
      store,
    });

    // Every entry was discovered and counted as observed — the source still
    // lists them — but fetch() returned null on each: listingHashCoversDetail
    // is true, so a matching listing hash proves the WHOLE payload unchanged.
    expect(result.observedBronReferenties.toSorted()).toEqual(
      NUMMERS.toSorted()
    );
    expect(fetches.count).toBe(NUMMERS.length);
    expect(recorder.observations).toHaveLength(0);
    expect(recorder.records).toHaveLength(0);
    expect(result.completeness).toEqual({ complete: true });
  });

  it("a changed feed entry defeats the known-hash skip and lands a new observation — there is no separate detail payload", async () => {
    const scrapeRunId = "run-ctm-change";
    const feedCorpus = corpus(NUMMERS);
    const knownHashes = new InMemoryKnownHashStore();
    const persistedHashes = await Promise.all(
      feedCorpus.entries.map((feedEntry) => hashCtmListingItem(feedEntry))
    );
    for (const [index, feedEntry] of feedCorpus.entries.entries()) {
      knownHashes.set(
        BRON_ID,
        feedEntry.aanvraagnummer,
        persistedHashes[index] ?? ""
      );
    }
    const calls: ClientCalls = { listing: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, corpus: feedCorpus }),
      fetches: { count: 0 },
      knownHashes,
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // First poll: every entry skips on the seeded hash except one, which the
    // source republished with a new titel between polls — the changed entry
    // IS the changed payload; no detail fetch exists to carry the diff.
    const [mutated] = feedCorpus.entries;
    if (!mutated) {
      throw new Error("expected a first feed entry");
    }
    mutated.titel = `${mutated.titel} (gewijzigd)`;

    const result = await runWithStore({
      connector,
      recorder,
      scrapeRunId,
      store,
    });

    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]?.bronReferentie).toBe("460057");
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]?.bronReferentie).toBe("460057");
    expect(result.observedBronReferenties.toSorted()).toEqual(
      NUMMERS.toSorted()
    );
  });

  it("picks up a head insert on the retake itself — the window re-read has no read-pages blind spot", async () => {
    const scrapeRunId = "run-ctm-insert";
    const feedCorpus = corpus(NUMMERS);
    const calls: ClientCalls = { listing: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, corpus: feedCorpus }),
      fetches: { count: 0 },
      killOn: { fetchIndex: 2, once: { current: true } },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ connector, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // A new entry appears while the run is down. Like the sitemap cohort —
    // and unlike freelancer-nl's page cursor — this retake re-reads the whole
    // window, so the insert is observed immediately.
    feedCorpus.entries.unshift(entry("460999"));
    const result = await runWithStore({
      connector,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties.toSorted()).toEqual(
      [...NUMMERS, "460999"].toSorted()
    );
    expect(recorder.records).toHaveLength(NUMMERS.length + 1);
  });

  it("a failed feed read closes the run `failed` (DISCOVER_FAILED) with no committed checkpoint", async () => {
    const scrapeRunId = "run-ctm-discoverfail";
    const calls: ClientCalls = { listing: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({
        calls,
        corpus: corpus(NUMMERS),
        // Outlasts the spec's single-attempt retry budget so the failure is
        // the run's, not a retry's.
        listingFailuresLeft: { current: 1 },
      }),
      fetches: { count: 0 },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ connector, recorder, scrapeRunId, store })
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
    // The row is terminal `failed` at the pre-page (null) checkpoint: on
    // Postgres the durable retake reopens it via `reopenFailed` (CTP-643) and
    // re-reads the whole window — proven in
    // apps/worker/src/poller/l3c-cohort.integration.spec.ts. The in-memory
    // store cannot reopen a terminal row, so no retake is driven here.
    expect(recorder.observations).toHaveLength(0);
  });

  it("an abort mid-item closes the run `failed` (RAW_STORE_WRITE_FAILED — persistence abort is never benign, CTP-490), with no committed checkpoint", async () => {
    const scrapeRunId = "run-ctm-abort";
    const calls: ClientCalls = { listing: 0 };
    const controller = new AbortController();
    // Abort while the SECOND entry's fetch runs: the re-serialisation
    // returns, then the raw-store write sees the aborted signal and throws —
    // recorded as a real failure, never a benign `aborted` completion.
    const connector = scriptedConnector({
      abortOn: { controller, fetchIndex: 2 },
      client: scriptedClient({ calls, corpus: corpus(NUMMERS) }),
      fetches: { count: 0 },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({
        connector,
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
    expect(await store.load({ bronId: BRON_ID, scrapeRunId })).toMatchObject({
      checkpoint: null,
    });
    // Exactly the one entry persisted before the abort — no loss, no dupe.
    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]?.bronReferentie).toBe("460057");
  });
});
