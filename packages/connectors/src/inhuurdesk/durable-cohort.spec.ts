import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObservationRecorder,
  InMemoryObjectStore,
  InMemoryRunLifecycleStore,
  runConnector,
  RunOwnershipLostError,
} from "@ji/connectors";

import type { InhuurdeskClient } from "./client";
import { createInhuurdeskConnector } from "./connector";
import type { InhuurdeskAssignment } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const PAGE_SIZE = 2;

const assignment = (id: string): InhuurdeskAssignment => ({
  content: `<p>Beschrijving ${id}</p>`,
  id,
  title: `Opdracht ${id}`,
});

/**
 * A 1-indexed Inhuurdesk feed served from `corpus` at call time, so mutating
 * the array between attempts reproduces a feed that shifted while the run
 * was down. `failOn` makes one page read throw a `RunOwnershipLostError`,
 * which `runConnector` propagates without recording a failure — the shape a
 * killed worker leaves (`running` row, last committed checkpoint).
 */
const pagingClient = (options: {
  calls: number[];
  corpus: () => InhuurdeskAssignment[];
  failOn?: { once: { current: boolean }; page: number };
}): InhuurdeskClient => ({
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
    return Promise.resolve({
      data: corpus.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total: corpus.length,
    });
  },
});

const runWithStore = (options: {
  bronId: string;
  client: InhuurdeskClient;
  recorder?: InMemoryObservationRecorder;
  scrapeRunId: string;
  store: InMemoryRunLifecycleStore;
}) =>
  runConnector({
    bronId: options.bronId,
    bronSlug: "inhuurdesk",
    connector: createInhuurdeskConnector({
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

describe("Inhuurdesk durable-cohort resume contract (CTP-629)", () => {
  it("advances the 1-indexed page cursor and never sets truncated", async () => {
    const corpus = [assignment("ih-a"), assignment("ih-b"), assignment("ih-c")];
    const calls: number[] = [];
    const connector = createInhuurdeskConnector({
      bronId: "bron-ih-pages",
      client: pagingClient({ calls, corpus: () => corpus }),
    });

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual([
      "ih-a",
      "ih-b",
    ]);
    expect(first.checkpoint).toEqual({ page: 2, pageSize: PAGE_SIZE });
    expect(first.hasMore).toBe(true);
    // RJC-397: Inhuurdesk has no page cap — `truncated` must stay absent.
    expect(first.truncated).toBeUndefined();

    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(["ih-c"]);
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBeUndefined();
    expect(calls).toEqual([1, 2]);
  });

  it("a durable retake of a killed run re-reads only pages past the checkpoint", async () => {
    const bronId = "bron-ih-resume";
    const scrapeRunId = "run-ih-resume";
    const corpus = [assignment("ih-a"), assignment("ih-b"), assignment("ih-c")];
    const calls: number[] = [];
    const client = pagingClient({
      calls,
      corpus: () => corpus,
      failOn: { once: { current: true }, page: 2 },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    // Attempt 1 persists the page-1 checkpoint, then the process "dies"
    // mid-page-2: RunOwnershipLostError propagates without closing the row.
    await expect(
      runWithStore({ bronId, client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);
    expect(calls).toEqual([1, 2]);
    expect(await store.load({ bronId, scrapeRunId })).toMatchObject({
      checkpoint: { page: 2, pageSize: PAGE_SIZE },
    });

    const result = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId,
      store,
    });
    // `hasMore` is total-bounded: page 2 returns ih-c and already knows the
    // corpus is exhausted, so the empty page 3 is never requested.
    expect(calls).toEqual([1, 2, 2]);
    expect(result.completeness).toEqual({ complete: false, reason: "resumed" });
    expect(
      recorder.records.map((record) => record.bronReferentie).toSorted()
    ).toEqual(["ih-a", "ih-b", "ih-c"]);
  });

  it("absorbs a head insert between attempts as an unchanged re-observation", async () => {
    const bronId = "bron-ih-shift";
    const scrapeRunId = "run-ih-shift";
    const corpus = [assignment("ih-a"), assignment("ih-b"), assignment("ih-c")];
    const calls: number[] = [];
    const client = pagingClient({
      calls,
      corpus: () => corpus,
      failOn: { once: { current: true }, page: 2 },
    });
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();

    await expect(
      runWithStore({ bronId, client, recorder, scrapeRunId, store })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // ih-b was read on page 1; the head insert pushes it onto page 2, where
    // the resumed run reads it a second time — absorbed as `unchanged`.
    corpus.unshift(assignment("ih-new"));
    const result = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId,
      store,
    });

    expect(calls).toEqual([1, 2, 2]);
    expect(result.observedBronReferenties.toSorted()).toEqual(["ih-b", "ih-c"]);
    expect(recorder.records).toHaveLength(3);
    // The replay key (scrapeRunId + bronReferentie + contentHash) absorbs the
    // re-observation: one stored observation, one source record.
    expect(
      recorder.observations.filter(
        (observation) => observation.bronReferentie === "ih-b"
      )
    ).toHaveLength(1);
  });

  it("documents the residual gap: a deletion before the cursor is skipped this run and healed by the next fresh poll", async () => {
    const bronId = "bron-ih-delete";
    const store = new InMemoryRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();
    const corpus = [assignment("ih-a"), assignment("ih-b"), assignment("ih-c")];
    const client = pagingClient({
      calls: [],
      corpus: () => corpus,
      failOn: { once: { current: true }, page: 2 },
    });

    await expect(
      runWithStore({
        bronId,
        client,
        recorder,
        scrapeRunId: "run-ih-delete-1",
        store,
      })
    ).rejects.toBeInstanceOf(RunOwnershipLostError);

    // ih-a was read on page 1 and is then delisted: ih-c slides into
    // already-read page territory, so this resumed run never sees it.
    corpus.splice(0, 1);
    const resumed = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId: "run-ih-delete-1",
      store,
    });
    expect(resumed.observedBronReferenties).toEqual([]);
    expect(recorder.records.map((record) => record.bronReferentie)).toEqual([
      "ih-a",
      "ih-b",
    ]);
    // No tombstone follows: a resumed run is never a complete reconciliation.
    expect(resumed.completeness).toEqual({
      complete: false,
      reason: "resumed",
    });

    // The next poll enumerates from page 1 and sees ih-c immediately.
    const fresh = await runWithStore({
      bronId,
      client,
      recorder,
      scrapeRunId: "run-ih-delete-2",
      store,
    });
    expect(fresh.observedBronReferenties.toSorted()).toEqual(["ih-b", "ih-c"]);
    expect(fresh.completeness).toEqual({ complete: true });
  });
});
