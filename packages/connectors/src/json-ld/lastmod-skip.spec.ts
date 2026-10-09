import { describe, expect, it } from "bun:test";

import type { BronId } from "@ji/domain";

import type { DiscoverItem } from "../contract";
import type { KnownHashStore } from "../known-hash";
import { CrawlDelayLimiter } from "../limiter";
import { InMemoryObjectStore } from "../object-store";
import { InMemoryObservationRecorder } from "../observation-recorder";
import { runConnector } from "../run";
import { InMemoryRunLifecycleStore } from "../run-lifecycle";
import type { JsonLdClient } from "./client";
import { createJsonLdConnector } from "./connector";
import { hashJsonLdListingItem } from "./hash";
import {
  DATE_ONLY_LASTMOD_SETTLE_MS,
  LASTMOD_REVALIDATE_EVERY_DAYS,
  shouldSkipUnchangedLastmod,
} from "./lastmod-skip";
import type { JsonLdConnectorConfig, JsonLdDiscoveryUrl } from "./types";

const BRON_ID: BronId = "00000000-0000-4000-8000-0000000000aa";
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-09T08:00:00.000Z");

const config: JsonLdConnectorConfig = {
  discovery: { kind: "sitemap", url: "https://jobs.example.test/sitemap.xml" },
  parserVersion: "json-ld-test-v1",
  slug: "lastmod-test",
};

const storeWith = (hash: string | null): KnownHashStore => ({
  get: () => Promise.resolve(hash),
});

const itemFor = async (
  entry: JsonLdDiscoveryUrl,
  parserVersion = config.parserVersion
): Promise<DiscoverItem> => ({
  bronReferentie: new URL(entry.url).pathname.slice(1),
  contentHash: await hashJsonLdListingItem(entry, parserVersion),
  listingPayload: entry,
});

/** The first day from `start` on which `url` is NOT due for revalidation. */
const nonRevalidationDay = async (
  url: string,
  start: Date = NOW
): Promise<Date> => {
  for (let offset = 0; offset < LASTMOD_REVALIDATE_EVERY_DAYS; offset += 1) {
    const day = new Date(start.getTime() + offset * DAY_MS);
    // oxlint-disable-next-line no-await-in-loop -- probing days in order
    const skipped = await shouldSkipUnchangedLastmod(
      { knownHashes: storeWith("x"), now: () => day },
      BRON_ID,
      {
        bronReferentie: "probe",
        contentHash: "x",
        listingPayload: { lastmod: "2026-01-01T00:00:00Z", url },
      }
    );
    if (skipped) {
      return day;
    }
  }
  throw new Error(`no non-revalidation day found for ${url}`);
};

describe("shouldSkipUnchangedLastmod", () => {
  const url = "https://jobs.example.test/vacature/a";
  const entry = { lastmod: "2026-10-01T10:00:00Z", url };

  it("skips when the stored listing hash matches an unchanged lastmod", async () => {
    const item = await itemFor(entry);
    const day = await nonRevalidationDay(url);
    await expect(
      shouldSkipUnchangedLastmod(
        { knownHashes: storeWith(item.contentHash), now: () => day },
        BRON_ID,
        item
      )
    ).resolves.toBe(true);
  });

  it("fetches when lastmod moved since the last fetch", async () => {
    const before = await itemFor(entry);
    const after = await itemFor({ ...entry, lastmod: "2026-10-08T09:00:00Z" });
    const day = await nonRevalidationDay(url);
    await expect(
      shouldSkipUnchangedLastmod(
        { knownHashes: storeWith(before.contentHash), now: () => day },
        BRON_ID,
        after
      )
    ).resolves.toBe(false);
  });

  it("always fetches an entry without lastmod, even with a matching hash", async () => {
    const item = await itemFor({ url });
    const day = await nonRevalidationDay(url);
    await expect(
      shouldSkipUnchangedLastmod(
        { knownHashes: storeWith(item.contentHash), now: () => day },
        BRON_ID,
        item
      )
    ).resolves.toBe(false);
  });

  it("fetches when nothing was persisted for the page yet", async () => {
    const item = await itemFor(entry);
    const day = await nonRevalidationDay(url);
    await expect(
      shouldSkipUnchangedLastmod(
        { knownHashes: storeWith(null), now: () => day },
        BRON_ID,
        item
      )
    ).resolves.toBe(false);
  });

  it("re-fetches a page after a parser version bump", async () => {
    const stored = await itemFor(entry, "json-ld-test-v1");
    const bumped = await itemFor(entry, "json-ld-test-v2");
    const day = await nonRevalidationDay(url);
    await expect(
      shouldSkipUnchangedLastmod(
        { knownHashes: storeWith(stored.contentHash), now: () => day },
        BRON_ID,
        bumped
      )
    ).resolves.toBe(false);
  });

  it("keeps fetching a date-only lastmod until it has settled", async () => {
    const item = await itemFor({ lastmod: "2026-10-08", url });
    const lastmodMs = Date.parse("2026-10-08T00:00:00Z");
    const decideAt = (now: Date) =>
      shouldSkipUnchangedLastmod(
        { knownHashes: storeWith(item.contentHash), now: () => now },
        BRON_ID,
        item
      );

    // A same-day edit after our fetch would not move a date-only lastmod.
    await expect(
      decideAt(new Date(lastmodMs + DATE_ONLY_LASTMOD_SETTLE_MS - 1))
    ).resolves.toBe(false);
    const settled = await nonRevalidationDay(
      url,
      new Date(lastmodMs + DATE_ONLY_LASTMOD_SETTLE_MS)
    );
    await expect(decideAt(settled)).resolves.toBe(true);
  });

  it("re-fetches every URL exactly once per revalidation window", async () => {
    const urls = Array.from(
      { length: 50 },
      (_, index) => `https://jobs.example.test/vacature/${index}`
    );
    const fetchedDays = new Map<string, number>();
    for (let offset = 0; offset < LASTMOD_REVALIDATE_EVERY_DAYS; offset += 1) {
      const day = new Date(NOW.getTime() + offset * DAY_MS);
      for (const candidate of urls) {
        // oxlint-disable-next-line no-await-in-loop -- sequential probe keeps the assertion simple
        const item = await itemFor({
          lastmod: "2026-01-01T00:00:00Z",
          url: candidate,
        });
        // oxlint-disable-next-line no-await-in-loop -- sequential probe keeps the assertion simple
        const skipped = await shouldSkipUnchangedLastmod(
          { knownHashes: storeWith(item.contentHash), now: () => day },
          BRON_ID,
          item
        );
        if (!skipped) {
          fetchedDays.set(candidate, (fetchedDays.get(candidate) ?? 0) + 1);
        }
      }
    }
    expect(fetchedDays.size).toBe(urls.length);
    expect([...fetchedDays.values()].every((count) => count === 1)).toBe(true);
  });
});

describe("json-ld connector with lastmodSkip across two poll runs", () => {
  const CRAWL_DELAY_MS = 2000;
  const corpus: JsonLdDiscoveryUrl[] = Array.from(
    { length: 40 },
    (_, index) => ({
      lastmod: "2026-10-01T10:00:00Z",
      url: `https://jobs.example.test/vacature/${index}`,
    })
  );
  // Three entries without lastmod: always fetched, whatever was stored.
  const withoutLastmod: JsonLdDiscoveryUrl[] = [40, 41, 42].map((index) => ({
    url: `https://jobs.example.test/vacature/${index}`,
  }));

  const pollRun = async (
    listing: JsonLdDiscoveryUrl[],
    recorder: InMemoryObservationRecorder,
    now: Date,
    runId: string
  ) => {
    const fetchedUrls: string[] = [];
    const client: JsonLdClient = {
      fetchDetail: (detailUrl) => {
        fetchedUrls.push(detailUrl);
        return Promise.resolve({
          jobPosting: { "@type": "JobPosting", title: detailUrl },
          labelBlock: {},
          url: detailUrl,
        });
      },
      fetchListing: () => Promise.resolve(listing),
    };
    // Backed by what earlier runs persisted, like PostgresKnownHashStore.
    const knownHashes: KnownHashStore = {
      get: (bronId, bronReferentie) =>
        Promise.resolve(
          recorder.records.find(
            (record) =>
              record.bronId === bronId &&
              record.bronReferentie === bronReferentie
          )?.listingHash ?? null
        ),
    };
    let virtualWaitMs = 0;
    const result = await runConnector({
      bronId: BRON_ID,
      bronSlug: config.slug,
      checkpoint: null,
      connector: createJsonLdConnector({
        bronId: BRON_ID,
        client,
        config,
        lastmodSkip: { knownHashes, now: () => now },
      }),
      limiter: new CrawlDelayLimiter({
        crawlDelayMs: CRAWL_DELAY_MS,
        now: () => virtualWaitMs,
        wait: (milliseconds) => {
          virtualWaitMs += milliseconds;
          return Promise.resolve();
        },
      }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: recorder,
      rawRetentionDays: 90,
      retryPolicy: {
        initialDelayMs: 0,
        jitter: (delayMs: number) => delayMs,
        maxAttempts: 1,
        maxDelayMs: 0,
        multiplier: 1,
      },
      runKind: "poll",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: runId,
      startedAt: now,
    });
    return { fetchedUrls, result, virtualWaitMs };
  };

  it("fetches every page once, then only changed, lastmod-less and revalidation-day pages", async () => {
    const recorder = new InMemoryObservationRecorder();
    const listing = [...corpus, ...withoutLastmod];

    const first = await pollRun(listing, recorder, NOW, "run-lastmod-1");
    expect(first.fetchedUrls).toHaveLength(listing.length);

    // Next day: one page edited (lastmod moved), the rest untouched.
    const nextDay = new Date(NOW.getTime() + DAY_MS);
    const edited = corpus[7]?.url ?? "";
    const changedListing = listing.map((entry) =>
      entry.url === edited
        ? { lastmod: "2026-10-09T07:00:00Z", url: entry.url }
        : entry
    );
    const second = await pollRun(
      changedListing,
      recorder,
      nextDay,
      "run-lastmod-2"
    );

    const revalidated: string[] = [];
    for (const entry of corpus) {
      if (entry.url === edited) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential probe keeps the assertion simple
      const item = await itemFor(entry);
      // oxlint-disable-next-line no-await-in-loop -- sequential probe keeps the assertion simple
      const skipped = await shouldSkipUnchangedLastmod(
        { knownHashes: storeWith(item.contentHash), now: () => nextDay },
        BRON_ID,
        item
      );
      if (!skipped) {
        revalidated.push(entry.url);
      }
    }
    const expected = [
      edited,
      ...revalidated,
      ...withoutLastmod.map((entry) => entry.url),
    ];
    expect(second.fetchedUrls.toSorted()).toEqual(expected.toSorted());
    // Roughly one seventh of the unchanged pages revalidate per day.
    expect(revalidated.length).toBeLessThan(corpus.length / 2);
    // Skipped pages cost no crawl-delay slot...
    expect(second.virtualWaitMs).toBeLessThan(first.virtualWaitMs / 2);
    // ...and still count as observed, so missed-poll staling never closes them.
    expect(second.result.observedBronReferenties).toHaveLength(listing.length);
    expect(second.result.completeness).toEqual({ complete: true });
  });

  it("without lastmodSkip keeps fetching every page on every run", async () => {
    const recorder = new InMemoryObservationRecorder();
    const fetched: string[] = [];
    const client: JsonLdClient = {
      fetchDetail: (detailUrl) => {
        fetched.push(detailUrl);
        return Promise.resolve({
          jobPosting: { "@type": "JobPosting", title: detailUrl },
          labelBlock: {},
          url: detailUrl,
        });
      },
      fetchListing: () => Promise.resolve(corpus),
    };
    const connector = createJsonLdConnector({
      bronId: BRON_ID,
      client,
      config,
    });
    expect(connector.skipFetch).toBeUndefined();
    for (const runId of ["run-plain-1", "run-plain-2"]) {
      // oxlint-disable-next-line no-await-in-loop -- runs are sequential by definition
      await runConnector({
        bronId: BRON_ID,
        bronSlug: config.slug,
        checkpoint: null,
        connector,
        limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
        objectStore: new InMemoryObjectStore(),
        observationRecorder: recorder,
        rawRetentionDays: 90,
        retryPolicy: {
          initialDelayMs: 0,
          jitter: (delayMs: number) => delayMs,
          maxAttempts: 1,
          maxDelayMs: 0,
          multiplier: 1,
        },
        runKind: "poll",
        runLifecycleStore: new InMemoryRunLifecycleStore(),
        scrapeRunId: runId,
        startedAt: NOW,
      });
    }
    expect(fetched).toHaveLength(corpus.length * 2);
  });
});
