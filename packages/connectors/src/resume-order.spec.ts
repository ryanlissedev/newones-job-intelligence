import { describe, expect, it } from "bun:test";

import type { BronId, ScrapeRunId } from "@ji/domain";

import type { Connector, DiscoverItem } from "./contract";
import { CrawlDelayLimiter } from "./limiter";
import { InMemoryObjectStore } from "./object-store";
import { InMemoryObservationRecorder } from "./observation-recorder";
import type { ObservationRecordInput } from "./observation-recorder";
import { orderForResume } from "./resume-order";
import type { ResumeOrderLookup } from "./resume-order";
import { runConnector } from "./run";
import { InMemoryRunLifecycleStore } from "./run-lifecycle";

// SAFETY: BronId and ScrapeRunId are nominal string brands; specs mint readable ids.
const BRON = "bron-resume" as BronId;
const runId = (name: string): ScrapeRunId =>
  // SAFETY: nominal string brand, see above.
  name as ScrapeRunId;

const item = (bronReferentie: string): DiscoverItem => ({
  bronReferentie,
  contentHash: "",
});
const refs = (items: readonly DiscoverItem[]) =>
  items.map((entry) => entry.bronReferentie);

const hexDigest = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * In-memory stand-in for `staging.source_record.last_fetched_at`: the
 * recorder stamps a reference when its observation is written, the lookup
 * reads the stamps back. A tick counter keeps fetch times strictly ordered.
 */
const fetchHistory = () => {
  const lastFetched = new Map<string, Date | null>();
  let tick = 0;
  const lookups: string[][] = [];
  const recorder = new InMemoryObservationRecorder();
  const record = recorder.record.bind(recorder);
  recorder.record = (input: ObservationRecordInput) => {
    tick += 1;
    lastFetched.set(input.sourceRecord.bronReferentie, new Date(tick * 1000));
    return record(input);
  };
  const lookup: ResumeOrderLookup = {
    lastFetchedAt: (_bronId, bronReferenties) => {
      lookups.push([...bronReferenties]);
      return Promise.resolve(
        new Map(
          bronReferenties
            .filter((reference) => lastFetched.has(reference))
            .map((reference) => [reference, lastFetched.get(reference) ?? null])
        )
      );
    },
  };
  return { lastFetched, lookup, lookups, recorder };
};

/** One-page or multi-page listing; `fetched` logs every detail fetch. */
const listing = (
  pages: readonly (readonly string[])[],
  fetched: string[]
): Connector => ({
  bronId: BRON,
  discover: (checkpoint) => {
    // SAFETY: this fake connector only ever returns `{ page: number }` checkpoints.
    const page = Number((checkpoint as { page?: number } | null)?.page ?? 0);
    return Promise.resolve({
      checkpoint: { page: page + 1 },
      hasMore: page + 1 < pages.length,
      items: (pages[page] ?? []).map((reference) => item(reference)),
    });
  },
  fetch: (entry) => {
    fetched.push(entry.bronReferentie);
    return Promise.resolve({
      body: new TextEncoder().encode(entry.bronReferentie),
      bronReferentie: entry.bronReferentie,
      contentHash: hexDigest(entry.bronReferentie),
      contentType: "html" as const,
      status: "fetched" as const,
    });
  },
});

/**
 * Wraps a recorder so the run budget "elapses" right after the Nth item of
 * this run was persisted: the abort lands between items, as it does while a
 * real run waits out its crawl delay.
 */
const budgetAfter = (
  recorder: InMemoryObservationRecorder,
  persistedItems: number
) => {
  const controller = new AbortController();
  let persisted = 0;
  const record = recorder.record.bind(recorder);
  // SAFETY: the prototype is the recorder itself, so every member resolves to it.
  const wrapped = Object.create(recorder) as InMemoryObservationRecorder;
  wrapped.record = async (input: ObservationRecordInput) => {
    const result = await record(input);
    persisted += 1;
    if (persisted >= persistedItems) {
      controller.abort();
    }
    return result;
  };
  return { recorder: wrapped, signal: controller.signal };
};

const run = (
  connector: Connector,
  scrapeRunId: string,
  extra: {
    resumeOrder?: ResumeOrderLookup;
    recorder?: InMemoryObservationRecorder;
    signal?: AbortSignal;
  } = {}
) =>
  runConnector({
    bronId: BRON,
    bronSlug: "tenderned",
    checkpoint: null,
    connector,
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: extra.recorder ?? new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    resumeOrder: extra.resumeOrder,
    retryPolicy,
    runKind: "poll",
    runLifecycleStore: new InMemoryRunLifecycleStore(),
    scrapeRunId: runId(scrapeRunId),
    signal: extra.signal,
  });

describe("orderForResume", () => {
  it("puts never-fetched first, then unknown fetch time, then oldest fetch first; listing order breaks ties", () => {
    const items = ["old", "new-1", "unknown", "newest", "new-2", "older"].map(
      (reference) => item(reference)
    );
    const lastFetched = new Map<string, Date | null>([
      ["old", new Date("2026-10-08T10:00:00Z")],
      ["unknown", null],
      ["newest", new Date("2026-10-09T10:00:00Z")],
      ["older", new Date("2026-10-07T10:00:00Z")],
    ]);
    expect(
      refs(orderForResume(items, lastFetched, (entry) => entry.bronReferentie))
    ).toEqual(["new-1", "new-2", "unknown", "older", "old", "newest"]);
  });
});

describe("closure is separated from fetch", () => {
  it("a budget cut while fetching a one-page listing still saw the whole listing", async () => {
    const fetched: string[] = [];
    const result = await run(
      listing([["A", "B", "C", "D"]], fetched),
      "cut-one-page",
      budgetAfter(new InMemoryObservationRecorder(), 2)
    );
    expect(fetched).toEqual(["A", "B"]);
    // Fetch was cut: the run is still recorded as incomplete …
    expect(result.completeness).toEqual({ complete: false, reason: "aborted" });
    // … but every listed reference was discovered, so closure may run.
    expect(result.discoveryCompleteness).toEqual({ complete: true });
    expect(result.observedBronReferenties).toEqual(["A", "B", "C", "D"]);
  });

  it("a cut on page 1 of a multi-page listing never claims the listing", async () => {
    const fetched: string[] = [];
    const result = await run(
      listing(
        [
          ["A", "B"],
          ["C", "D"],
        ],
        fetched
      ),
      "cut-first-page",
      budgetAfter(new InMemoryObservationRecorder(), 1)
    );
    expect(fetched).toEqual(["A"]);
    expect(result.discoveryCompleteness).toEqual({
      complete: false,
      reason: "aborted",
    });
    expect(result.observedBronReferenties).toEqual(["A", "B"]);
  });

  it("a cut while fetching the LAST page of a multi-page listing still saw the whole listing", async () => {
    const fetched: string[] = [];
    const result = await run(
      listing(
        [
          ["A", "B"],
          ["C", "D"],
        ],
        fetched
      ),
      "cut-last-page",
      budgetAfter(new InMemoryObservationRecorder(), 3)
    );
    expect(fetched).toEqual(["A", "B", "C"]);
    expect(result.completeness).toEqual({ complete: false, reason: "aborted" });
    expect(result.discoveryCompleteness).toEqual({ complete: true });
    expect(result.observedBronReferenties).toEqual(["A", "B", "C", "D"]);
  });

  it("a complete run is complete on both counts", async () => {
    const result = await run(listing([["A"], ["B"]], []), "complete");
    expect(result.completeness).toEqual({ complete: true });
    expect(result.discoveryCompleteness).toEqual({ complete: true });
  });
});

describe("resumable fetch order across runs", () => {
  it("after a budget cut, the next run fetches the items the cut run never reached first", async () => {
    const history = fetchHistory();
    const page = ["J1", "J2", "J3", "J4", "J5", "J6"];

    const firstFetched: string[] = [];
    await run(listing([page], firstFetched), "resume-run-1", {
      resumeOrder: history.lookup,
      ...budgetAfter(history.recorder, 3),
    });
    expect(firstFetched).toEqual(["J1", "J2", "J3"]);

    // Run 2 gets the same budget (three fetches) and spends it on the tail.
    const secondFetched: string[] = [];
    await run(listing([page], secondFetched), "resume-run-2", {
      resumeOrder: history.lookup,
      ...budgetAfter(history.recorder, 3),
    });
    expect(secondFetched).toEqual(["J4", "J5", "J6"]);

    // Run 3 then refreshes the oldest fetches first.
    const thirdFetched: string[] = [];
    await run(listing([page], thirdFetched), "resume-run-3", {
      recorder: history.recorder,
      resumeOrder: history.lookup,
    });
    expect(thirdFetched).toEqual(["J1", "J2", "J3", "J4", "J5", "J6"]);
    expect(history.lookups).toHaveLength(3);
  });

  it("without the lookup, every run starts at the top of the listing again (the old behaviour)", async () => {
    const page = ["J1", "J2", "J3", "J4"];
    const fetchedPerRun: string[][] = [];
    for (const name of ["old-1", "old-2"]) {
      const fetched: string[] = [];
      // oxlint-disable-next-line no-await-in-loop -- runs are sequential like poller rounds
      await run(
        listing([page], fetched),
        name,
        budgetAfter(new InMemoryObservationRecorder(), 2)
      );
      fetchedPerRun.push(fetched);
    }
    expect(fetchedPerRun).toEqual([
      ["J1", "J2"],
      ["J1", "J2"],
    ]);
  });

  it("keeps listing order when the lookup fails", async () => {
    const fetched: string[] = [];
    await run(listing([["B", "A"]], fetched), "lookup-fails", {
      resumeOrder: {
        lastFetchedAt: () => Promise.reject(new Error("database down")),
      },
    });
    expect(fetched).toEqual(["B", "A"]);
  });

  it("skips the lookup for connectors whose fetch never hits the network", async () => {
    const history = fetchHistory();
    const fetched: string[] = [];
    await run(
      { ...listing([["A", "B"]], fetched), fetchUsesNetwork: false },
      "offline",
      { resumeOrder: history.lookup }
    );
    expect(history.lookups).toEqual([]);
    expect(fetched).toEqual(["A", "B"]);
  });
});
