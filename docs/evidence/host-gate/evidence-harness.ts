/**
 * PR5 runtime evidence: the real json-ld connector + runner against a local
 * HTTP "host" that rate-limits (429 + Retry-After) or sits behind a Cloudflare
 * challenge (403, cf-mitigated: challenge). The server logs every request
 * that reaches it. Runs unchanged on the base tree (CrawlDelayLimiter) and on
 * this branch (HostGate): it picks HostGate when the package exports it.
 *
 *   bun docs/evidence/host-gate/evidence-harness.ts
 */
import * as connectors from "../../../packages/connectors/src/index";
import {
  createJsonLdClient,
  createJsonLdConnector,
} from "../../../packages/connectors/src/json-ld/index";
import type { JsonLdConnectorConfig } from "../../../packages/connectors/src/json-ld/types";

type Mode = "cloudflare" | "rate-limit";

const JOBS = 6;
const CRAWL_DELAY_MS = 500;
let mode: Mode = "rate-limit";
let rateLimitedOnce = false;
const log: { at: number; path: string; status: number }[] = [];

const jobPage = (id: number) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  datePosted: "2026-10-01",
  description: `Evidence job ${id}`,
  hiringOrganization: { "@type": "Organization", name: "Gate BV" },
  identifier: `job-${id}`,
  jobLocation: {
    "@type": "Place",
    address: { "@type": "PostalAddress", addressLocality: "Utrecht" },
  },
  title: `Evidence job ${id}`,
})}</script></head><body>job ${id}</body></html>`;

const server = Bun.serve({
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    const respond = (response: Response) => {
      log.push({ at: performance.now(), path: pathname, status: response.status });
      return response;
    };
    if (pathname === "/sitemap.xml") {
      const urls = Array.from(
        { length: JOBS },
        (_, index) =>
          `<url><loc>http://127.0.0.1:${server.port}/job/${index + 1}</loc></url>`
      ).join("");
      return respond(
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
          { headers: { "content-type": "application/xml" } }
        )
      );
    }
    const id = Number(pathname.split("/").at(-1));
    if (mode === "cloudflare") {
      return respond(
        new Response(
          "<html><title>Just a moment...</title><body>cf_chl challenge-platform</body></html>",
          { headers: { "cf-mitigated": "challenge" }, status: 403 }
        )
      );
    }
    if (id === 3 && !rateLimitedOnce) {
      rateLimitedOnce = true;
      return respond(
        new Response("slow down", { headers: { "Retry-After": "3" }, status: 429 })
      );
    }
    return respond(
      new Response(jobPage(id), { headers: { "content-type": "text/html" } })
    );
  },
  port: 0,
});

const config: JsonLdConnectorConfig = {
  discovery: { kind: "sitemap", url: `http://127.0.0.1:${server.port}/sitemap.xml` },
  parserVersion: "gate-evidence/v1",
  slug: "gate-evidence",
};

const bronId = "00000000-0000-4000-8000-0000000000e5";
const HostGateClass = (connectors as Record<string, unknown>).HostGate as
  | (new (options: { crawlDelayMs: number }) => connectors.RequestLimiter)
  | undefined;
const limiterName = HostGateClass ? "HostGate" : "CrawlDelayLimiter";
const limiter: connectors.RequestLimiter = HostGateClass
  ? new HostGateClass({ crawlDelayMs: CRAWL_DELAY_MS })
  : new connectors.CrawlDelayLimiter({ crawlDelayMs: CRAWL_DELAY_MS });

const runOnce = async (runNumber: number) => {
  const connector = createJsonLdConnector({
    bronId,
    client: createJsonLdClient({ config, fetchImpl: fetch, liveEnabled: true }),
    config,
  });
  const before = log.length;
  const startedAt = performance.now();
  let outcome: string;
  try {
    const result = await connectors.runConnector({
      bronId: bronId as never,
      bronSlug: "gate-evidence",
      connector,
      limiter,
      objectStore: new connectors.InMemoryObjectStore(),
      observationRecorder: new connectors.InMemoryObservationRecorder(),
      rawRetentionDays: 30,
      retryPolicy: {
        initialDelayMs: 250,
        jitter: connectors.fullJitter,
        maxAttempts: 3,
        maxDelayMs: 5000,
        multiplier: 2,
      },
      runKind: "poll",
      runLifecycleStore: new connectors.InMemoryRunLifecycleStore(),
      scrapeRunId: crypto.randomUUID() as never,
    });
    outcome = `succeeded new=${result.metrics.new} rejected=${result.metrics.rejected}`;
  } catch (error) {
    const kind = connectors.classifyRunFailure(error);
    outcome = `failed (${kind}): ${(error as Error).message}`;
  }
  const requests = log.slice(before);
  return {
    durationMs: Math.round(performance.now() - startedAt),
    outcome,
    requests,
    runNumber,
  };
};

const fmt = (entries: typeof log, origin: number) =>
  entries
    .map((entry) => `+${Math.round(entry.at - origin)}ms ${entry.status} ${entry.path}`)
    .join("\n    ");

console.log(`limiter: ${limiterName}, crawl delay ${CRAWL_DELAY_MS} ms\n`);

console.log("Scenario 1 — host answers job/3 with 429 Retry-After: 3 (once)");
const rate = await runOnce(1);
const origin = rate.requests[0]?.at ?? 0;
console.log(`  outcome: ${rate.outcome}, ${rate.durationMs} ms`);
console.log(`  requests:\n    ${fmt(rate.requests, origin)}`);
const limited = rate.requests.findIndex((entry) => entry.status === 429);
const retry = rate.requests[limited + 1];
const limitedEntry = rate.requests[limited];
if (retry && limitedEntry) {
  console.log(
    `  gap 429 -> retry of ${retry.path}: ${Math.round(retry.at - limitedEntry.at)} ms (host asked for 3000 ms)\n`
  );
}

mode = "cloudflare";
console.log("Scenario 2 — every detail page is a Cloudflare challenge (403); 4 poller runs back to back");
let total = 0;
for (let runNumber = 1; runNumber <= 4; runNumber += 1) {
  // oxlint-disable-next-line no-await-in-loop -- poller runs are sequential per source
  const run = await runOnce(runNumber);
  total += run.requests.length;
  console.log(
    `  run ${runNumber}: ${run.requests.length} requests reached the host -> ${run.outcome.slice(0, 110)}`
  );
}
console.log(`  total requests to the blocking host over 4 runs: ${total}`);
if (HostGateClass) {
  const snapshot = (limiter as unknown as { snapshot: (id: string) => unknown }).snapshot(bronId);
  console.log(`  gate snapshot: ${JSON.stringify(snapshot)}`);
}

server.stop(true);
