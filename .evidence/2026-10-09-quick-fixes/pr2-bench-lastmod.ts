// Evidence bench (not committed to the PR): Randstad-sized corpus, real connector + runConnector, virtual crawl-delay clock.
import { CrawlDelayLimiter } from "../limiter";
import { InMemoryObjectStore } from "../object-store";
import { InMemoryObservationRecorder } from "../observation-recorder";
import { runConnector } from "../run";
import { InMemoryRunLifecycleStore } from "../run-lifecycle";
import { createJsonLdConnector } from "./connector";
import type { JsonLdDiscoveryUrl } from "./types";
const BRON = "00000000-0000-4000-8000-0000000000bb";
const config = { discovery: { kind: "sitemap" as const, url: "https://x.test/sitemap.xml" }, parserVersion: "v1", slug: "randstad-sim" };
const DAY = 86_400_000; const day1 = new Date("2026-10-08T06:00:00Z"); const day2 = new Date(day1.getTime() + DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const N = 3009, CHANGED = 136;
// Day 1: lastmods spread over the previous 30 days; 136 carry yesterday's date.
const d1: JsonLdDiscoveryUrl[] = Array.from({ length: N }, (_, i) => ({ url: `https://x.test/vacature/${i}`, lastmod: iso(new Date(day1.getTime() - (i < CHANGED ? 1 : 2 + (i % 28)) * DAY)) }));
// Day 2: another 136 edited today.
const d2 = d1.map((e, i) => (i >= CHANGED && i < 2 * CHANGED ? { ...e, lastmod: iso(day2) } : e));
const recorder = new InMemoryObservationRecorder();
const run = async (listing: JsonLdDiscoveryUrl[], now: Date, id: string, skip: boolean) => {
  let fetches = 0, waitMs = 0;
  const connector = createJsonLdConnector({ bronId: BRON as any, config, client: { fetchListing: () => Promise.resolve(listing), fetchDetail: (url) => { fetches++; return Promise.resolve({ jobPosting: { "@type": "JobPosting", title: url }, labelBlock: {}, url }); } },
    lastmodSkip: skip ? { now: () => now, knownHashes: { get: (b, r) => Promise.resolve(recorder.records.find((x) => x.bronId === b && x.bronReferentie === r)?.listingHash ?? null) } } : undefined });
  const res = await runConnector({ bronId: BRON as any, bronSlug: config.slug, checkpoint: null, connector, limiter: new CrawlDelayLimiter({ crawlDelayMs: 2000, now: () => waitMs, wait: (ms) => { waitMs += ms; return Promise.resolve(); } }),
    objectStore: new InMemoryObjectStore(), observationRecorder: recorder, rawRetentionDays: 90, retryPolicy: { initialDelayMs: 0, jitter: (d: number) => d, maxAttempts: 1, maxDelayMs: 0, multiplier: 1 }, runKind: "poll", runLifecycleStore: new InMemoryRunLifecycleStore(), scrapeRunId: id, startedAt: now });
  return { run: id, lastmodSkip: skip, urls: listing.length, detailFetches: fetches, crawlDelayMinutes: +(waitMs / 60000).toFixed(1), observed: res.observedBronReferenties.length, complete: res.completeness.complete };
};
console.log(JSON.stringify(await run(d1, day1, "day1-first-run", true)));
console.log(JSON.stringify(await run(d2, day2, "day2-with-lastmod-skip", true)));
const recorder2 = recorder; // baseline for comparison: same day-2 listing without skip
console.log(JSON.stringify(await run(d2, day2, "day2-without-skip (main)", false)));
