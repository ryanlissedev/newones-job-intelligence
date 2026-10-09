// Evidence harness for PR2: 2,000-page sitemap corpus through the real runner and json-ld connector, three scenarios.
import { CrawlDelayLimiter } from "../limiter";
import type { KnownHashStore } from "../known-hash";
import { InMemoryObjectStore } from "../object-store";
import { InMemoryObservationRecorder } from "../observation-recorder";
import { runConnector } from "../run";
import { InMemoryRunLifecycleStore } from "../run-lifecycle";
import { createJsonLdConnector } from "./connector";
import type { LastmodHonestyReport } from "./lastmod-skip";

const BRON = "00000000-0000-4000-8000-0000000000ab";
const NOW = new Date("2026-10-09T08:00:00.000Z");
const DAY = 86_400_000;
const corpus = Array.from({ length: 2000 }, (_, i) => ({ lastmod: "2026-10-01T10:00:00Z", url: `https://jobs.example.test/vacature/${i}` }));

const run = async (rec: InMemoryObservationRecorder, now: Date, id: string, edited: (url: string) => boolean, percent?: number) => {
  let fetched = 0;
  const reports: LastmodHonestyReport[] = [];
  const persisted = (ref: string) => rec.records.find((r) => r.bronReferentie === ref);
  const knownHashes: KnownHashStore = {
    get: (_b, ref) => Promise.resolve(persisted(ref)?.listingHash ?? null),
    getPayloadHash: (_b, ref) => Promise.resolve(persisted(ref)?.contentHash ?? null),
  };
  const result = await runConnector({
    bronId: BRON, bronSlug: "probe-evidence", checkpoint: null,
    connector: createJsonLdConnector({
      bronId: BRON,
      client: {
        fetchDetail: (url) => { fetched += 1; return Promise.resolve({ jobPosting: { "@type": "JobPosting", title: edited(url) ? `${url} v2` : url }, labelBlock: {}, url }); },
        fetchListing: () => Promise.resolve(corpus),
      },
      config: { discovery: { kind: "sitemap", url: "https://jobs.example.test/sitemap.xml" }, parserVersion: "v1", slug: "probe-evidence" },
      lastmodSkip: { knownHashes, now: () => now, onDistrust: (r) => reports.push(r), ...(percent === undefined ? {} : { probePercent: percent }) },
    }),
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(), observationRecorder: rec, rawRetentionDays: 90,
    retryPolicy: { initialDelayMs: 0, jitter: (d: number) => d, maxAttempts: 1, maxDelayMs: 0, multiplier: 1 },
    runKind: "poll", runLifecycleStore: new InMemoryRunLifecycleStore(), scrapeRunId: id, startedAt: now,
  });
  return { changed: result.metrics.changed, distrust: reports[0], fetched };
};

const scenario = async (label: string, edited: (url: string) => boolean, percent?: number) => {
  const rec = new InMemoryObservationRecorder();
  await run(rec, NOW, `${label}-1`, () => false);
  const r = await run(rec, new Date(NOW.getTime() + DAY), `${label}-2`, edited, percent);
  const edits = corpus.filter((e) => edited(e.url)).length;
  console.log(`${label.padEnd(44)} edits=${String(edits).padStart(4)} fetched=${String(r.fetched).padStart(4)}/2000 changed-observed=${String(r.changed).padStart(4)} distrust=${r.distrust ? `yes (after ${r.distrust.probes} probes)` : "no"}`);
};

await scenario("honest source, probe 2% (default)", () => false);
await scenario("frozen lastmod, all edited, probe off (#468)", () => true, 0);
await scenario("frozen lastmod, all edited, probe 2%", () => true);
await scenario("frozen lastmod, 10% edited, probe off (#468)", (u) => Number(u.split("/").pop()) % 10 === 0, 0);
await scenario("frozen lastmod, 10% edited, probe 2%", (u) => Number(u.split("/").pop()) % 10 === 0);
