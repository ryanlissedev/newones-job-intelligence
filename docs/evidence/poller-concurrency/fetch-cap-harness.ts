/**
 * PR6 runtime evidence (2/2): eight sources in flight through the real
 * `executeBronRun` → `runConnector` → json-ld live fetch, against a local
 * HTTP host that logs every request. Each bron allows a request every 100 ms
 * (10/s), so eight of them together could start 80 requests per second.
 * Run once without a process cap and once with
 * `configureProcessFetchRateCap(8)` (the POLLER_FETCHES_PER_SECOND default).
 *
 *   bun docs/evidence/poller-concurrency/fetch-cap-harness.ts
 */
import {
  configureProcessFetchRateCap,
  executeBronRun,
} from "../../../packages/application/src/bronnen/index";
import type { BronRegisterRecord } from "../../../packages/application/src/bronnen/register";
import * as connectors from "../../../packages/connectors/src/index";
import {
  createJsonLdClient,
  createJsonLdConnector,
} from "../../../packages/connectors/src/json-ld/index";
import type { JsonLdConnectorConfig } from "../../../packages/connectors/src/json-ld/types";

const SOURCES = 8;
const JOBS = 15;
const log: number[] = [];

const jobPage = (source: number, id: number) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  datePosted: "2026-10-01",
  description: `Cap job ${source}-${id}`,
  hiringOrganization: { "@type": "Organization", name: "Cap BV" },
  identifier: `job-${source}-${id}`,
  title: `Cap job ${source}-${id}`,
})}</script></head><body>job</body></html>`;

const server = Bun.serve({
  fetch: (request) => {
    log.push(performance.now());
    const parts = new URL(request.url).pathname.split("/");
    const source = Number(parts[1]);
    if (parts[2] === "sitemap.xml") {
      const urls = Array.from(
        { length: JOBS },
        (_, index) =>
          `<url><loc>http://127.0.0.1:${server.port}/${source}/job/${index + 1}</loc></url>`
      ).join("");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }
    return new Response(jobPage(source, Number(parts.at(-1))), {
      headers: { "content-type": "text/html" },
    });
  },
  port: 0,
});

const record = (bronId: string): BronRegisterRecord => ({
  actief: true,
  bronId,
  categorie: "werving",
  crawlDelayMs: 100,
  interval: "*/15 * * * *",
  lastRun: null,
  loginVereist: false,
  mappingRef: "json-ld",
  method: "html",
  naam: bronId,
  rateLimitPerMinute: 600,
  retentionDays: 30,
  secretRef: null,
  status: "ready",
  voorwaardenStatus: "toegestaan",
});

const runAll = async (label: string, round: number) => {
  log.length = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: SOURCES }, async (_, source) => {
      const bronId = `00000000-0000-4000-8000-${String(round * 100 + source).padStart(12, "0")}`;
      const config: JsonLdConnectorConfig = {
        discovery: {
          kind: "sitemap",
          url: `http://127.0.0.1:${server.port}/${source}/sitemap.xml`,
        },
        parserVersion: "cap-evidence/v1",
        slug: `cap-evidence-${source}`,
      };
      const row = record(bronId);
      await executeBronRun(
        {
          activate: () => Promise.reject(new Error("unused")),
          create: (created) => Promise.resolve(created),
          findById: () => Promise.resolve(row),
          list: () => Promise.resolve([row]),
        },
        {
          bronId: bronId as never,
          bronSlug: config.slug,
          connector: createJsonLdConnector({
            bronId,
            client: createJsonLdClient({ config, fetchImpl: fetch, liveEnabled: true }),
            config,
          }),
          objectStore: new connectors.InMemoryObjectStore(),
          observationRecorder: new connectors.InMemoryObservationRecorder(),
          runLifecycleStore: new connectors.InMemoryRunLifecycleStore(),
          scrapeRunId: `${bronId}-run` as never,
        }
      );
    })
  );
  const elapsedS = (performance.now() - started) / 1000;
  const times = log.toSorted((left, right) => left - right);
  let peak = 0;
  for (let index = 0, end = 0; index < times.length; index += 1) {
    while (end < times.length && (times[end] ?? 0) < (times[index] ?? 0) + 1000) {
      end += 1;
    }
    peak = Math.max(peak, end - index);
  }
  console.log(
    `${label}: ${times.length} requests in ${elapsedS.toFixed(2)} s → mean ${(times.length / elapsedS).toFixed(1)} req/s, peak ${peak} requests in any 1 s window`
  );
};

console.log(
  `${SOURCES} sources in flight, ${JOBS} detail pages each, each bron paced at 100 ms (10 req/s per host)`
);
configureProcessFetchRateCap(null);
await runAll("no process cap", 1);
configureProcessFetchRateCap(8);
await runAll("POLLER_FETCHES_PER_SECOND=8", 2);
configureProcessFetchRateCap(null);
server.stop(true);
