import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObservationRecorder,
  InMemoryObjectStore,
  InMemoryRunLifecycleStore,
  runConnector,
  RunOwnershipLostError,
} from "@ji/connectors";

import type { TenderNedClient } from "./client";
import { createTenderNedConnector } from "./connector";
import type { TenderNedListingItem } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const tnItem = (
  kenmerk: string,
  publicatieId: string
): TenderNedListingItem => ({
  aanbestedingNaam: `Aanbesteding ${kenmerk}`,
  kenmerk,
  publicatieDatum: "2026-09-19",
  publicatieId,
});

/**
 * A TenderNed feed of one item per page; `corpus` is the live listing order
 * the fake serves at call time, so mutating it between attempts reproduces a
 * feed that shifted while the run was down. `failOn` makes one page read
 * throw a `RunOwnershipLostError`, which `runConnector` propagates without
 * recording a failure — the shape a killed worker leaves (`running` row,
 * last committed checkpoint).
 */
const pagingClient = (options: {
  calls: number[];
  corpus: () => TenderNedListingItem[];
  failOn?: { page: number; once: { current: boolean } };
}): TenderNedClient => ({
  fetchDetail: (publicatieId) =>
    Promise.resolve({
      aanbestedingNaam: `Detail ${publicatieId}`,
      kenmerk: publicatieId,
      publicatieId,
    }),
  fetchListing: (page) => {
    options.calls.push(page);
    if (
      options.failOn &&
      page === options.failOn.page &&
      options.failOn.once.current
    ) {
      options.failOn.once.current = false;
      return Promise.reject(new RunOwnershipLostError());
    }
    const corpus = options.corpus();
    const content = corpus.slice(page, page + 1);
    return Promise.resolve({
      content,
      first: page === 0,
      last: page >= corpus.length - 1,
      number: page,
      size: 1,
      totalElements: corpus.length,
      totalPages: corpus.length,
    });
  },
});

const runWithStore = (options: {
  bronId: string;
  client: TenderNedClient;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  store: InMemoryRunLifecycleStore;
}) =>
  runConnector({
    bronId: options.bronId,
    bronSlug: "tenderned",
    connector: createTenderNedConnector({
      bronId: options.bronId,
      client: options.client,
    }),
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: options.recorder ?? new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    retryPolicy,
    runKind: "test",
    runLifecycleStore: options.store,
    scrapeRunId: options.scrapeRunId,
  });

describe("TenderNed durable-cohort resume contract (CTP-629)", () => {
  it("advances the page cursor across discover calls and never sets truncated", async () => {
    const corpus = [tnItem("TN-A", "pub-a"), tnItem("TN-B", "pub-b")];
    const calls: number[] = [];
    const connector = createTenderNedConnector({
      bronId: "bron-tn-pages",
      client: pagingClient({ calls, corpus: () => corpus }),
    });

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual(["TN-A"]);
    expect(first.checkpoint).toEqual({ page: 1 });
    expect(first.hasMore).toBe(true);
    // RJC-397: TenderNed has no page cap — the connector may never mark a
    // `hasMore: false` result as truncated, so absent is the only honest value.
    expect(first.truncated).toBeUndefined();

    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(["TN-B"]);
    expect(second.checkpoint).toEqual({ page: 2 });
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBeUndefined();
    expect(calls).toEqual([0, 1]);
  });

  it("a durable retake of a killed run re-reads only pages past the checkpoint", async () => {
    const bronId = "bron-tn-resume";
    const scrapeRunId = "run-tn-resume";
    const corpus = [tnItem("TN-A", "pub-a"), tnItem("TN-B", "pub-b")];
    const calls: number[] = [];
    const client = pagingClient({
      calls,
      corpus: () => corpus,
      failOn: { once: { current: true }, page: 1 },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // Attempt 1 persists page 0's checkpoint, then the process "dies"
    // mid-page-1: RunOwnershipLostError propagates without closing the row.
    await expect(
      runWithStore({ bronId, client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(calls).toEqual([0, 1]);
    expect(await store.load({ bronId, scrapeRunId })).toMatchObject({
      checkpoint: { page: 1 },
    });

    // The durable retake replays the same scrapeRunId; resume must pick the
    // walk up at page 1 instead of re-reading page 0.
    const result = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId,
      store,
    });
    expect(calls).toEqual([0, 1, 1]);
    expect(result.completeness).toEqual({ complete: false, reason: "resumed" });
    expect(result.metrics.found).toBe(2);
    expect(
      recorder.records.map((record) => record.bronReferentie).toSorted()
    ).toEqual(["TN-A", "TN-B"]);
  });

  it("absorbs a head insert between attempts as an unchanged re-observation", async () => {
    const bronId = "bron-tn-shift";
    const scrapeRunId = "run-tn-shift";
    const corpus = [tnItem("TN-A", "pub-a"), tnItem("TN-B", "pub-b")];
    const calls: number[] = [];
    const client = pagingClient({
      calls,
      corpus: () => corpus,
      failOn: { once: { current: true }, page: 1 },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ bronId, client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // The feed gained a head item while the run was down: TN-A shifts from
    // page 0 onto page 1 and is read a second time on resume.
    corpus.unshift(tnItem("TN-NEW", "pub-new"));
    const result = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId,
      store,
    });

    expect(calls).toEqual([0, 1, 1, 2]);
    // TN-NEW sits on page 0 — never re-read by this resumed run; the next
    // fresh poll owns it.
    expect(result.observedBronReferenties.toSorted()).toEqual(["TN-A", "TN-B"]);
    expect(recorder.records).toHaveLength(2);
    // The replay key (scrapeRunId + bronReferentie + contentHash) absorbs the
    // re-observation: one stored observation, one source record.
    expect(
      recorder.observations.filter(
        (observation) => observation.bronReferentie === "TN-A"
      )
    ).toHaveLength(1);
  });

  it("documents the residual gap: a deletion before the cursor is skipped this run and healed by the next fresh poll", async () => {
    const bronId = "bron-tn-delete";
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();
    const corpus = [tnItem("TN-A", "pub-a"), tnItem("TN-B", "pub-b")];
    const calls: number[] = [];
    const client = pagingClient({
      calls,
      corpus: () => corpus,
      failOn: { once: { current: true }, page: 1 },
    });

    await expect(
      runWithStore({
        bronId,
        client,
        recorder,
        scrapeRunId: "run-tn-delete-1",
        store,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // TN-A was read on page 0; it is then delisted, so TN-B slides into
    // already-read page territory and this resumed run never sees it.
    corpus.splice(0, 1);
    const resumed = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId: "run-tn-delete-1",
      store,
    });
    expect(resumed.observedBronReferenties).toEqual([]);
    expect(recorder.records.map((record) => record.bronReferentie)).toEqual([
      "TN-A",
    ]);
    // No tombstone follows: a resumed run is never a complete reconciliation.
    expect(resumed.completeness).toEqual({
      complete: false,
      reason: "resumed",
    });

    // The next poll enumerates from page 0 and sees TN-B immediately.
    const fresh = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId: "run-tn-delete-2",
      store,
    });
    expect(fresh.observedBronReferenties.toSorted()).toEqual(["TN-B"]);
    expect(fresh.completeness).toEqual({ complete: true });
  });
});
