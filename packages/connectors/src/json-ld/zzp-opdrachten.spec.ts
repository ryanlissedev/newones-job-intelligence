import { describe, expect, it } from "bun:test";

import type { CheckpointKey, ConnectorRunProgress } from "../checkpoint";
import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
} from "../contract";
import { CrawlDelayLimiter } from "../limiter";
import { InMemoryObjectStore } from "../object-store";
import { InMemoryObservationRecorder } from "../observation-recorder";
import { runConnector } from "../run";
import { ConnectorRunFailure, RunOwnershipLostError } from "../run-lifecycle";
import type {
  RunCompletionInput,
  RunFailureInput,
  RunLifecycleStore,
  RunStartInput,
  RunStartResult,
} from "../run-lifecycle";
import { createJsonLdClient } from "./client";
import type { JsonLdClient } from "./client";
import { zzpOpdrachtenConfig } from "./configs/zzp-opdrachten";
import { createJsonLdConnector } from "./connector";
import type { JsonLdConnectorConfig, JsonLdDiscoveryUrl } from "./types";

const client = createJsonLdClient({
  config: zzpOpdrachtenConfig,
  liveEnabled: false,
});
const details = [
  [
    "https://www.zzp-opdrachten.nl/vacatures/vacature-jurist-707983/",
    "Jurist",
    "ZZP Opdrachten",
    "Maarssen",
    "ZT57670",
    "2026-09-05",
    "80,75",
  ],
  [
    "https://www.zzp-opdrachten.nl/vacatures/vacature-bouwprojectmanager-708001/",
    "Bouwprojectmanager",
    "ZZP Opdrachten",
    "Heerenveen",
    "ZT57681",
    "2026-09-07",
    "131,75",
  ],
  [
    "https://www.zzp-opdrachten.nl/vacatures/vacature-woonfraude-specialist-710585/",
    "Woonfraude Specialist",
    "ZZP Opdrachten",
    "Haarlem",
    "ZT58329",
    "2026-09-26",
    "85,00",
  ],
] as const;

describe("ZZP-Opdrachten JSON-LD connector", () => {
  it("discovers the newest two sitemap chunks and the three recorded details", async () => {
    const urls = await client.fetchListing();
    expect(urls).toHaveLength(1805);
    for (const [url] of details) {
      expect(urls.some((entry) => entry.url === url)).toBe(true);
    }
  });

  it("parses published JobPosting fields", async () => {
    await Promise.all(
      details.map(
        async ([
          url,
          title,
          employer,
          locality,
          identifier,
          deadline,
          rate,
        ]) => {
          const detail = await client.fetchDetail(url);
          expect(detail.jobPosting).toMatchObject({
            baseSalary: {
              currency: "EUR",
              value: { unitText: "HOUR", value: rate },
            },
            employmentType: ["TEMPORARY"],
            hiringOrganization: { name: employer },
            identifier: { value: identifier },
            jobLocation: { address: { addressLocality: locality } },
            title,
            validThrough: deadline,
          });
        }
      )
    );
  });
});

/** Wraps a real client and counts the requests a discovery strategy issues. */
const countedClient = (base: JsonLdClient) => {
  const { fetchSitemapChild, fetchSitemapIndex } = base;
  if (!fetchSitemapChild || !fetchSitemapIndex) {
    throw new Error("batched discovery requires the sitemap-index methods");
  }
  const childCalls: string[] = [];
  let indexCalls = 0;
  let listingCalls = 0;
  const wrapped: JsonLdClient = {
    fetchDetail: (url, signal) => base.fetchDetail(url, signal),
    fetchListing: (signal) => {
      listingCalls += 1;
      return base.fetchListing(signal);
    },
    fetchSitemapChild: (url, signal) => {
      childCalls.push(url);
      return fetchSitemapChild(url, signal);
    },
    fetchSitemapIndex: (signal) => {
      indexCalls += 1;
      return fetchSitemapIndex(signal);
    },
  };
  return {
    calls: {
      get child() {
        return childCalls;
      },
      get index() {
        return indexCalls;
      },
      get listing() {
        return listingCalls;
      },
    },
    wrapped,
  };
};

const collectPages = async (
  connector: Connector,
  start: ConnectorCheckpoint | null = null
): Promise<ConnectorDiscoverResult[]> => {
  const pages: ConnectorDiscoverResult[] = [];
  let checkpoint = start;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- page checkpoints require sequential discovery
    const page = await connector.discover(checkpoint);
    pages.push(page);
    if (!page.hasMore) {
      return pages;
    }
    ({ checkpoint } = page);
  }
};

const pageUrls = (pages: readonly ConnectorDiscoverResult[]): string[] =>
  pages.flatMap((page) =>
    // SAFETY: discover() attaches JsonLdDiscoveryUrl rows as listingPayload.
    page.items.map((item) => (item.listingPayload as JsonLdDiscoveryUrl).url)
  );

const CURSOR_PATTERN = /^sitemap-index:[0-9a-f]{16}:\d+:\d+$/u;

const batchedZzpConfig = (batchSize: number): JsonLdConnectorConfig => {
  const { discovery } = zzpOpdrachtenConfig;
  if (discovery.kind !== "sitemap-index") {
    throw new Error("zzp-opdrachten discovery must be sitemap-index");
  }
  return {
    ...zzpOpdrachtenConfig,
    discovery: { ...discovery, batchSize },
  };
};

describe("ZZP-Opdrachten resumable sitemap-index batches (CTP-624)", () => {
  it("emits the fixture corpus in bounded pages identical to fetchListing", async () => {
    const { calls, wrapped } = countedClient(client);
    const connector = createJsonLdConnector({
      bronId: "bron-zzp-batched",
      client: wrapped,
      config: zzpOpdrachtenConfig,
    });

    const pages = await collectPages(connector);

    // 805 + 1000 URLs at batchSize 100 -> 19 pages, the last one short.
    expect(pages).toHaveLength(19);
    for (const [index, page] of pages.entries()) {
      expect(page.items.length).toBeLessThanOrEqual(100);
      expect(page.hasMore).toBe(index < pages.length - 1);
      expect(page.checkpoint.cursor).toMatch(CURSOR_PATTERN);
    }
    expect(pages.at(-1)?.items).toHaveLength(5);

    const corpus = await client.fetchListing();
    expect(pageUrls(pages)).toEqual(corpus.map((entry) => entry.url));

    // One index read + one read per selected child for a whole same-process
    // walk — identical request shape to the single fetchListing pass.
    expect(calls.index).toBe(1);
    expect(calls.child).toEqual([
      "https://www.zzp-opdrachten.nl/job-sitemap58.xml",
      "https://www.zzp-opdrachten.nl/job-sitemap57.xml",
    ]);
    expect(calls.listing).toBe(0);
  });

  it("resumes mid-corpus in a fresh process by re-reading only the index and remaining children", async () => {
    const connectorA = createJsonLdConnector({
      bronId: "bron-zzp-attempt-1",
      client,
      config: zzpOpdrachtenConfig,
    });
    const first = await connectorA.discover(null);
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.checkpoint.cursor).toMatch(
      /^sitemap-index:[0-9a-f]{16}:0:100$/u
    );

    // A new connector instance = a durable retake in a new process: the index
    // is re-read, the fingerprint matches, and the walk continues at the
    // persisted position.
    const { calls, wrapped } = countedClient(
      createJsonLdClient({ config: zzpOpdrachtenConfig, liveEnabled: false })
    );
    const connectorB = createJsonLdConnector({
      bronId: "bron-zzp-attempt-1",
      client: wrapped,
      config: zzpOpdrachtenConfig,
    });
    const rest = await collectPages(connectorB, first.checkpoint);

    const corpus = await client.fetchListing();
    expect(pageUrls([first, ...rest])).toEqual(
      corpus.map((entry) => entry.url)
    );
    expect(rest).toHaveLength(18);
    expect(calls.index).toBe(1);
    expect(calls.child).toEqual([
      "https://www.zzp-opdrachten.nl/job-sitemap58.xml",
      "https://www.zzp-opdrachten.nl/job-sitemap57.xml",
    ]);
  });

  it("restarts at position 0 when the cursor fingerprint no longer matches the index", async () => {
    const { calls, wrapped } = countedClient(client);
    const connector = createJsonLdConnector({
      bronId: "bron-zzp-rebased",
      client: wrapped,
      config: zzpOpdrachtenConfig,
    });
    const first = await connector.discover(null);
    const fingerprint = first.checkpoint.cursor?.split(":")[1];
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/u);

    // A checkpoint written against a different index snapshot must not skip
    // into a shifted corpus: the walk restarts and re-observes from 0.
    const restarted = await connector.discover({
      cursor: "sitemap-index:0000000000000000:1:37",
    });
    expect(restarted.items.map((item) => item.bronReferentie)).toEqual(
      first.items.map((item) => item.bronReferentie)
    );
    expect(restarted.checkpoint.cursor).toBe(
      `sitemap-index:${fingerprint}:0:100`
    );
    expect(calls.index).toBe(2);
  });

  it("treats absent, malformed and foreign cursors as a fresh walk", async () => {
    const connector = createJsonLdConnector({
      bronId: "bron-zzp-legacy",
      client,
      config: zzpOpdrachtenConfig,
    });
    const reference = await connector.discover(null);
    const firstUrls = reference.items.map((item) => item.bronReferentie);

    for (const checkpoint of [
      {},
      { page: 3 },
      { cursor: "sitemap:12" },
      { cursor: "sitemap-index:not-a-cursor" },
      { cursor: "sitemap-index:abc:one:two" },
    ]) {
      const fresh = createJsonLdConnector({
        bronId: "bron-zzp-legacy-each",
        client,
        config: zzpOpdrachtenConfig,
      });
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const page = await fresh.discover(checkpoint);
      expect(page.items.map((item) => item.bronReferentie)).toEqual(firstUrls);
      expect(page.hasMore).toBe(true);
    }
  });

  it("rejects a non-integer or missing-client batchSize at construction", () => {
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createJsonLdConnector({
          bronId: "bron-zzp-bad-batch",
          client,
          config: batchedZzpConfig(batchSize),
        })
      ).toThrow(/positive integer/u);
    }
    const listingOnlyClient: JsonLdClient = {
      fetchDetail: () => Promise.reject(new Error("unused")),
      fetchListing: () => Promise.resolve([]),
    };
    expect(() =>
      createJsonLdConnector({
        bronId: "bron-zzp-bad-client",
        client: listingOnlyClient,
        config: zzpOpdrachtenConfig,
      })
    ).toThrow(/fetchSitemapIndex\/fetchSitemapChild/u);
  });
});

/** A sitemap-index corpus small enough to drive the real run loop: child
 * sitemap2 first (chunk order is descending), then sitemap1. */
const CHUNK_2 = "https://example.test/job-sitemap2.xml";
const CHUNK_1 = "https://example.test/job-sitemap1.xml";
const CHILD_ENTRIES = new Map<string, JsonLdDiscoveryUrl[]>([
  [
    CHUNK_2,
    ["b1", "b2", "b3", "b4"].map((id) => ({
      url: `https://example.test/jobs/${id}`,
    })),
  ],
  [
    CHUNK_1,
    ["a1", "a2", "a3"].map((id) => ({
      url: `https://example.test/jobs/${id}`,
    })),
  ],
]);

const batchedTestConfig = (batchSize: number): JsonLdConnectorConfig => ({
  discovery: {
    batchSize,
    childPattern: /\/job-sitemap(?<chunk>\d+)\.xml$/u,
    kind: "sitemap-index",
    newest: 2,
    url: "https://example.test/sitemap_index.xml",
  },
  parserVersion: "test/v1",
  slug: "test-batched",
});

const createSyntheticClient = (options?: {
  abortOnceOnUrl?: { controller: AbortController; url: string };
  failOnceOnSitemapChild?: string;
  failOnceOnUrl?: string;
  onFetchDetail?: (url: string) => void;
}): JsonLdClient => {
  let failed = false;
  let childFailed = false;
  return {
    fetchDetail: (url) => {
      options?.onFetchDetail?.(url);
      if (url === options?.abortOnceOnUrl?.url) {
        // A real detail request dies with AbortError when the run's signal
        // fires mid-flight; runConnector classifies that as a clean run abort.
        options.abortOnceOnUrl.controller.abort();
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      if (url === options?.failOnceOnUrl && !failed) {
        failed = true;
        return Promise.reject(new Error("HTTP 500"));
      }
      return Promise.resolve({
        jobPosting: { "@type": "JobPosting", title: url },
        labelBlock: {},
        url,
      });
    },
    fetchListing: () =>
      Promise.reject(new Error("batched discovery never reads fetchListing")),
    fetchSitemapChild: (url) => {
      if (url === options?.failOnceOnSitemapChild && !childFailed) {
        childFailed = true;
        return Promise.reject(new Error("transient child sitemap failure"));
      }
      return Promise.resolve(CHILD_ENTRIES.get(url) ?? []);
    },
    fetchSitemapIndex: () => Promise.resolve([CHUNK_2, CHUNK_1]),
  };
};

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const runKey = ({ bronId, scrapeRunId }: CheckpointKey): string =>
  `${bronId}\0${scrapeRunId}`;

/**
 * The in-memory lifecycle store treats `failed` and `succeeded` rows as
 * terminal, so it cannot drive a durable retake. This double mirrors the
 * Postgres store's contract (packages/db bron-runtime.ts, CTP-643): mode
 * "resume" reopens a `failed` run keeping its persisted checkpoint under a
 * new fence; a `succeeded` row stays closed.
 */
class ReopeningRunLifecycleStore implements RunLifecycleStore {
  private readonly progressByRun = new Map<string, ConnectorRunProgress>();
  private readonly fenceTokenByRun = new Map<string, number>();
  private readonly statusByRun = new Map<
    string,
    "failed" | "running" | "succeeded"
  >();

  status(key: CheckpointKey): "failed" | "running" | "succeeded" | undefined {
    return this.statusByRun.get(runKey(key));
  }

  load(key: CheckpointKey): Promise<ConnectorRunProgress | null> {
    return Promise.resolve(
      structuredClone(this.progressByRun.get(runKey(key)) ?? null)
    );
  }

  start(input: RunStartInput): Promise<RunStartResult> {
    const key = runKey(input.key);
    const status = this.statusByRun.get(key);
    const stored = this.progressByRun.get(key);
    if (
      status === "succeeded" ||
      (status === "failed" && input.mode !== "resume")
    ) {
      return Promise.reject(
        new Error("Cannot resume mismatched or completed scrape run")
      );
    }
    const progress =
      input.mode === "resume" && stored !== undefined ? stored : input.progress;
    const fenceToken = (this.fenceTokenByRun.get(key) ?? 0) + 1;
    this.fenceTokenByRun.set(key, fenceToken);
    this.statusByRun.set(key, "running");
    this.progressByRun.set(key, structuredClone(progress));
    return Promise.resolve({
      fenceToken,
      progress: structuredClone(progress),
      startedAt: input.startedAt,
    });
  }

  checkpoint(
    key: CheckpointKey,
    progress: ConnectorRunProgress,
    fenceToken: number
  ): Promise<void> {
    if (this.fenceTokenByRun.get(runKey(key)) !== fenceToken) {
      return Promise.reject(new RunOwnershipLostError());
    }
    this.progressByRun.set(runKey(key), structuredClone(progress));
    return Promise.resolve();
  }

  complete(input: RunCompletionInput): Promise<void> {
    if (this.fenceTokenByRun.get(runKey(input.key)) !== input.fenceToken) {
      return Promise.reject(new RunOwnershipLostError());
    }
    this.progressByRun.set(runKey(input.key), structuredClone(input.progress));
    this.statusByRun.set(runKey(input.key), "succeeded");
    return Promise.resolve();
  }

  fail(input: RunFailureInput): Promise<void> {
    if (this.fenceTokenByRun.get(runKey(input.key)) !== input.fenceToken) {
      return Promise.reject(new RunOwnershipLostError());
    }
    this.progressByRun.set(runKey(input.key), structuredClone(input.progress));
    this.statusByRun.set(runKey(input.key), "failed");
    return Promise.resolve();
  }
}

describe("ZZP-Opdrachten batched run resume (CTP-624)", () => {
  const bronId = "bron-zzp-durable";
  const config = batchedTestConfig(3);

  it("re-emits a page in full when a mid-batch child read fails and the same connector retries", async () => {
    // runConnector wraps discover() in withRetry on this same connector
    // instance: a transient child failure after items were buffered must not
    // leave them committed to the cross-page dedupe set — the retried page
    // re-emits them and downstream idempotency absorbs the overlap.
    const connector = createJsonLdConnector({
      bronId,
      client: createSyntheticClient({ failOnceOnSitemapChild: CHUNK_1 }),
      config,
    });

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual([
      "jobs/b1",
      "jobs/b2",
      "jobs/b3",
    ]);

    // Page 2 buffers b4, then the child-1 read throws mid-batch.
    await expect(connector.discover(first.checkpoint)).rejects.toThrow(
      "transient child sitemap failure"
    );
    const retried = await connector.discover(first.checkpoint);
    expect(retried.items.map((item) => item.bronReferentie)).toEqual([
      "jobs/b4",
      "jobs/a1",
      "jobs/a2",
    ]);

    const last = await connector.discover(retried.checkpoint);
    expect(last.items.map((item) => item.bronReferentie)).toEqual(["jobs/a3"]);
    expect(last.hasMore).toBe(false);
  });

  const runInput = (
    connector: Connector,
    store: ReopeningRunLifecycleStore,
    recorder: InMemoryObservationRecorder,
    checkpoint?: ConnectorCheckpoint | null,
    signal?: AbortSignal
  ) => ({
    bronId,
    bronSlug: config.slug,
    checkpoint,
    connector,
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: recorder,
    rawRetentionDays: 90,
    retryPolicy,
    runKind: "test" as const,
    runLifecycleStore: store,
    scrapeRunId: "run-zzp-durable-1",
    signal,
  });

  it("resumes a failed run from the persisted page checkpoint and emits each remaining item once", async () => {
    const store = new ReopeningRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();
    const failingOn = "https://example.test/jobs/a1";

    // Attempt 1 walks page 1 (b1..b3), then fails on a1 mid page 2 after b4
    // was already persisted. The checkpoint stays at the page-1 boundary.
    const attempt1 = createJsonLdConnector({
      bronId,
      client: createSyntheticClient({ failOnceOnUrl: failingOn }),
      config,
    });
    await expect(
      runConnector(runInput(attempt1, store, recorder, null))
    ).rejects.toBeInstanceOf(ConnectorRunFailure);
    expect(store.status({ bronId, scrapeRunId: "run-zzp-durable-1" })).toBe(
      "failed"
    );
    const persisted = await store.load({
      bronId,
      scrapeRunId: "run-zzp-durable-1",
    });
    expect(persisted?.checkpoint?.cursor).toMatch(
      /^sitemap-index:[0-9a-f]{16}:0:3$/u
    );
    expect(recorder.records.map((record) => record.bronReferentie)).toEqual([
      "jobs/b1",
      "jobs/b2",
      "jobs/b3",
      "jobs/b4",
    ]);

    // Attempt 2 is a fresh connector process: `checkpoint: undefined` makes
    // runConnector resume the stored progress, the index fingerprint matches,
    // and discovery emits exactly the remaining corpus once.
    const detailFetches: string[] = [];
    const attempt2 = createJsonLdConnector({
      bronId,
      client: createSyntheticClient({
        onFetchDetail: (url) => detailFetches.push(url),
      }),
      config,
    });
    const result = await runConnector(runInput(attempt2, store, recorder));

    expect(detailFetches).toEqual([
      "https://example.test/jobs/b4",
      "https://example.test/jobs/a1",
      "https://example.test/jobs/a2",
      "https://example.test/jobs/a3",
    ]);
    expect(result.completeness).toEqual({
      complete: false,
      reason: "resumed",
    });
    expect(result.checkpoint.cursor).toMatch(
      /^sitemap-index:[0-9a-f]{16}:2:0$/u
    );

    // Exactly-once across attempts: b4 was re-emitted but the recorder's
    // same-run replay key absorbs it — seven records, seven observations.
    expect(recorder.records).toHaveLength(7);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie))
    ).toEqual(
      new Set([
        "jobs/b1",
        "jobs/b2",
        "jobs/b3",
        "jobs/b4",
        "jobs/a1",
        "jobs/a2",
        "jobs/a3",
      ])
    );
    expect(recorder.observations).toHaveLength(7);
  });

  it("closes an aborted run at the last completed page without tombstone authority", async () => {
    const store = new ReopeningRunLifecycleStore();
    const recorder = new InMemoryObservationRecorder();
    const controller = new AbortController();

    // Abort lands while page 2 is being persisted: the page is unfinished, so
    // the checkpoint keeps pointing at its start (end of page 1).
    const connector = createJsonLdConnector({
      bronId,
      client: createSyntheticClient({
        abortOnceOnUrl: {
          controller,
          url: "https://example.test/jobs/a1",
        },
      }),
      config,
    });
    const result = await runConnector(
      runInput(connector, store, recorder, null, controller.signal)
    );

    expect(result.completeness).toEqual({
      complete: false,
      reason: "aborted",
    });
    expect(result.checkpoint.cursor).toMatch(
      /^sitemap-index:[0-9a-f]{16}:0:3$/u
    );
    expect(recorder.records.map((record) => record.bronReferentie)).toEqual([
      "jobs/b1",
      "jobs/b2",
      "jobs/b3",
      "jobs/b4",
    ]);
    expect(store.status({ bronId, scrapeRunId: "run-zzp-durable-1" })).toBe(
      "succeeded"
    );
  });
});
