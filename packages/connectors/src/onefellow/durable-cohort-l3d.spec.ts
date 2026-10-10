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

import type { OnefellowClient } from "./client";
import { createOnefellowConnector } from "./connector";
import { hashOnefellowListingItem } from "./hash";
import type { OnefellowJob } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * CTP-640 L3d: Onefellow's durable-resume contract differs from the paged
 * cohort siblings in two ways that this spec pins honestly.
 *
 * 1. No pagination at all. The private JSON endpoint returns every open
 *    opdracht in one call — `discover()` returns `hasMore: false` with an
 *    inert `checkpoint: {}`. A retake ignores the checkpoint and re-reads
 *    the whole listing. Exactly-once comes from the observation replay
 *    key (scrapeRunId + bronReferentie + contentHash), never from a page
 *    cursor.
 *
 * 2. `listingHashCoversDetail: true` (RJC-357/RJC-401): `fetch()`
 *    re-serialises the whitelisted listing job — there is NO detail
 *    request (`fetchUsesNetwork: false`). The change vector is the listing
 *    job itself: a mutated job changes the listing hash, which defeats the
 *    production `knownHashes` short-circuit the source definition wires
 *    in, so the re-serialised payload lands as a `changed` observation.
 *    On an UNCHANGED repeat poll the known-hash skip fires inside `fetch()`
 *    and nothing is re-persisted at all — Onefellow's dedupe point sits
 *    one layer earlier than the paged siblings'.
 */

const BRON_ID = "bron-onefellow-l3d";

interface ClientCalls {
  listing: number;
}

const job = (id: number, title?: string): OnefellowJob => ({
  company: "Eindklant B.V.",
  description: "Omschrijving.",
  joborder_id: id,
  status: "Open",
  title: title ?? `Opdracht ${id}`,
});

const corpus = (ids: number[]): OnefellowJob[] => ids.map((id) => job(id));

/**
 * The listing served from `jobs` at call time, so mutating the array
 * between attempts reproduces an endpoint that shifted while the run was
 * down. `listingFailuresLeft` makes discover() throw for the scripted
 * outage.
 */
const scriptedClient = (options: {
  calls: ClientCalls;
  jobs: OnefellowJob[];
  listingFailuresLeft?: { current: number };
}): OnefellowClient => ({
  fetchListing: () => {
    options.calls.listing += 1;
    if (
      options.listingFailuresLeft &&
      options.listingFailuresLeft.current > 0
    ) {
      options.listingFailuresLeft.current -= 1;
      return Promise.reject(new Error("scripted Onefellow listing outage"));
    }
    // The live endpoint wraps jobs in {jobs: [...]}; the client returns the
    // array, so the scripted client does the same.
    return Promise.resolve([...options.jobs]);
  },
});

/**
 * Onefellow's fetch() has no client call to inject into, so kill/abort
 * scripting wraps the CONNECTOR: `killOn` throws RunOwnershipLostError
 * inside one fetch (the residue a killed worker leaves — `running` row,
 * last committed checkpoint), `abortOn` fires the attempt's signal inside
 * one fetch so the raw-store write that follows lands on an aborted
 * signal.
 */
const scriptedConnector = (options: {
  abortOn?: { controller: AbortController; fetchIndex: number };
  client: OnefellowClient;
  fetches: { count: number };
  killOn?: { fetchIndex: number; once: { current: boolean } };
  knownHashes?: InMemoryKnownHashStore;
}): Connector => {
  const inner = createOnefellowConnector({
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
    bronSlug: "onefellow",
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

const IDS = [920, 1029, 1030];

describe("onefellow durable-cohort resume contract (CTP-640)", () => {
  it("enumerates the whole endpoint response in one discover call — hasMore: false, inert empty checkpoint, never truncated", async () => {
    const calls: ClientCalls = { listing: 0 };
    const connector = createOnefellowConnector({
      bronId: BRON_ID,
      client: scriptedClient({ calls, jobs: corpus(IDS) }),
    });

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual(
      IDS.map(String)
    );
    // Single-call discovery: no cursor exists. The checkpoint is `{}` —
    // present only because the contract requires an object — and a
    // "resumed" discover ignores it and re-reads the same whole response.
    expect(first.checkpoint).toEqual({});
    expect(first.hasMore).toBe(false);
    expect(first.truncated).toBeUndefined();

    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(
      IDS.map(String)
    );
    expect(second.hasMore).toBe(false);
    expect(calls.listing).toBe(2);
  });

  it("fetch() re-serialises the listing job without any detail request — the job IS the change vector", async () => {
    const calls: ClientCalls = { listing: 0 };
    const connector = createOnefellowConnector({
      bronId: BRON_ID,
      client: scriptedClient({ calls, jobs: corpus(IDS) }),
    });
    // Pinned: Onefellow never touches the network in fetch() — the runner
    // must not route this connector's item fetches through the crawl-delay
    // limiter.
    expect(connector.fetchUsesNetwork).toBe(false);

    const discovery = await connector.discover(null);
    const [item] = discovery.items;
    if (!item) {
      throw new Error("expected at least one listed job");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("fetched");
    // Still one listing read total: the item's payload came from the job
    // discover() already carried, not a second upstream request.
    expect(calls.listing).toBe(1);
  });

  it("a durable retake of a killed run re-reads the whole response; the replay key absorbs the persisted item", async () => {
    const scrapeRunId = "run-onefellow-kill";
    const calls: ClientCalls = { listing: 0 };
    const fetches = { count: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, jobs: corpus(IDS) }),
      fetches,
      killOn: { fetchIndex: 2, once: { current: true } },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // Attempt 1 persists the first job, then "dies" inside the second
    // job's fetch: RunOwnershipLostError propagates without closing the row.
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

    expect(calls.listing).toBe(2);
    expect(fetches.count).toBe(2 + IDS.length);
    expect(result.observedBronReferenties.toSorted()).toEqual(
      IDS.map(String).toSorted()
    );
    expect(result.completeness).toEqual({ complete: true });
    // Exactly-once: the job attempt 1 persisted was re-serialised under the
    // same scrapeRunId; the replay key returned the stored outcome instead
    // of appending a second observation.
    expect(recorder.records).toHaveLength(IDS.length);
    expect(recorder.observations).toHaveLength(IDS.length);
  });

  it("with the production known-hash wiring, an unchanged repeat run skips every fetch — Onefellow's dedupe sits before the recorder", async () => {
    const scrapeRunId = "run-onefellow-knownhash";
    const calls: ClientCalls = { listing: 0 };
    const jobs = corpus(IDS);
    const knownHashes = new InMemoryKnownHashStore();
    // The Postgres store reads source_record.listing_hash; seed it with
    // what a prior poll persisted — the discover-tier listing hash per
    // job, over the WHITELISTED projection the connector emits.
    const persistedHashes = await Promise.all(
      jobs.map((listed) => hashOnefellowListingItem(listed))
    );
    for (const [index, listed] of jobs.entries()) {
      knownHashes.set(
        BRON_ID,
        String(listed.joborder_id),
        persistedHashes[index] ?? ""
      );
    }
    const fetches = { count: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, jobs }),
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

    // Every job was discovered and counted as observed — the endpoint still
    // lists them — but fetch() returned null on each:
    // listingHashCoversDetail is true, so a matching listing hash proves the
    // WHOLE payload unchanged.
    expect(result.observedBronReferenties.toSorted()).toEqual(
      IDS.map(String).toSorted()
    );
    expect(fetches.count).toBe(IDS.length);
    expect(recorder.observations).toHaveLength(0);
    expect(recorder.records).toHaveLength(0);
    expect(result.completeness).toEqual({ complete: true });
  });

  it("a changed listing job defeats the known-hash skip and lands a new observation — there is no separate detail payload", async () => {
    const scrapeRunId = "run-onefellow-change";
    const jobs = corpus(IDS);
    const knownHashes = new InMemoryKnownHashStore();
    const persistedHashes = await Promise.all(
      jobs.map((listed) => hashOnefellowListingItem(listed))
    );
    for (const [index, listed] of jobs.entries()) {
      knownHashes.set(
        BRON_ID,
        String(listed.joborder_id),
        persistedHashes[index] ?? ""
      );
    }
    const calls: ClientCalls = { listing: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, jobs }),
      fetches: { count: 0 },
      knownHashes,
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // The source republished one job with a new title between polls — the
    // changed listing job IS the changed payload; no detail fetch exists to
    // carry the diff.
    const [mutated] = jobs;
    if (!mutated) {
      throw new Error("expected a first listed job");
    }
    mutated.title = `${mutated.title} (gewijzigd)`;

    const result = await runWithStore({
      connector,
      recorder,
      scrapeRunId,
      store,
    });

    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]?.bronReferentie).toBe("920");
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]?.bronReferentie).toBe("920");
    expect(result.observedBronReferenties.toSorted()).toEqual(
      IDS.map(String).toSorted()
    );
  });

  it("picks up a head insert on the retake itself — the whole-response re-read has no read-pages blind spot", async () => {
    const scrapeRunId = "run-onefellow-insert";
    const jobs = corpus(IDS);
    const calls: ClientCalls = { listing: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({ calls, jobs }),
      fetches: { count: 0 },
      killOn: { fetchIndex: 2, once: { current: true } },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ connector, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // A new job appears while the run is down. Unlike the page-cursor
    // siblings — whose retake resumes past already-read pages — this retake
    // re-reads the whole response, so the insert is observed immediately.
    jobs.unshift(job(1999));
    const result = await runWithStore({
      connector,
      recorder,
      scrapeRunId,
      store,
    });

    expect(result.observedBronReferenties.toSorted()).toEqual(
      [...IDS, 1999].map(String).toSorted()
    );
    expect(recorder.records).toHaveLength(IDS.length + 1);
  });

  it("a failed listing read closes the run `failed` (DISCOVER_FAILED) with no committed checkpoint", async () => {
    const scrapeRunId = "run-onefellow-discoverfail";
    const calls: ClientCalls = { listing: 0 };
    const connector = scriptedConnector({
      client: scriptedClient({
        calls,
        jobs: corpus(IDS),
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
    // Terminal `failed` at the null checkpoint: on Postgres the durable
    // retake reopens it via `reopenFailed` (CTP-643) and re-reads the whole
    // response — proven in
    // apps/worker/src/poller/l3d-cohort.integration.spec.ts.
    expect(recorder.observations).toHaveLength(0);
  });

  it("an abort mid-item closes the run `failed` (RAW_STORE_WRITE_FAILED — persistence abort is never benign, CTP-490), with no committed checkpoint", async () => {
    const scrapeRunId = "run-onefellow-abort";
    const calls: ClientCalls = { listing: 0 };
    const controller = new AbortController();
    // Abort while the SECOND job's fetch runs: the re-serialisation
    // returns, then the raw-store write sees the aborted signal and throws —
    // recorded as a real failure, never a benign `aborted` completion.
    const connector = scriptedConnector({
      abortOn: { controller, fetchIndex: 2 },
      client: scriptedClient({ calls, jobs: corpus(IDS) }),
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
    // Exactly the one job persisted before the abort — no loss, no dupe.
    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]?.bronReferentie).toBe("920");
  });
});
