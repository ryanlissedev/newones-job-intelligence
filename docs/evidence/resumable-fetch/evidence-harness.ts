/**
 * PR7 runtime evidence: the real json-ld connector + `executeBronRun` +
 * Postgres stores (observation recorder, run store, missed-poll lifecycle
 * ports) against a local sitemap host, with a real run budget
 * (`AbortSignal.timeout`) that is shorter than the crawl, like Techniekwerkt.
 *
 * Runs unchanged on the base tree (#474) and on this branch: it passes the
 * Postgres resume-order lookup when the package has one.
 *
 *   DATABASE_URL=postgresql://… bun docs/evidence/resumable-fetch/evidence-harness.ts
 */
import { executeBronRun } from "../../../packages/application/src/bronnen/index";
import { InMemoryObjectStore } from "../../../packages/connectors/src/index";
import {
  createJsonLdClient,
  createJsonLdConnector,
} from "../../../packages/connectors/src/json-ld/index";
import type { JsonLdConnectorConfig } from "../../../packages/connectors/src/json-ld/types";
import {
  PostgresBronPersistence,
  PostgresObservationRecorder,
  PostgresRunStore,
} from "../../../packages/db/src/bron-runtime";
import { createPostgresLifecyclePorts } from "../../../packages/db/src/missed-polls-store";
import * as schema from "../../../packages/db/src/schema";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const JOBS = 60;
const CRAWL_DELAY_MS = 100;
const RUN_BUDGET_MS = 2_150; // ≈ 20 detail fetches + discovery per run
const RUNS = 4;
const VANISHED = "job-5"; // fetched in run 1, gone from the listing from run 2 on

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
const client = postgres(databaseUrl, { max: 4 });
const database = drizzle(client, { schema });

let listed = Array.from({ length: JOBS }, (_, index) => `job-${index + 1}`);
const requests: string[] = [];

const page = (id: string) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  datePosted: "2026-10-01",
  description: `Resume evidence ${id}`,
  hiringOrganization: { "@type": "Organization", name: "Resume BV" },
  identifier: id,
  title: `Resume evidence ${id}`,
})}</script></head><body>${id}</body></html>`;

const server = Bun.serve({
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/sitemap.xml") {
      const urls = listed
        .map((id) => `<url><loc>http://127.0.0.1:${server.port}/${id}</loc></url>`)
        .join("");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }
    const id = pathname.slice(1);
    requests.push(id);
    return new Response(page(id), { headers: { "content-type": "text/html" } });
  },
  port: 0,
});

let resumeOrder: unknown;
try {
  const module = await import("../../../packages/db/src/resume-order-store");
  resumeOrder = new module.PostgresResumeOrderLookup(database);
} catch {
  resumeOrder = undefined;
}

const bronId = crypto.randomUUID();
await database.insert(schema.bron).values({
  actief: true,
  categorie: "werving",
  crawlDelayMs: CRAWL_DELAY_MS,
  id: bronId,
  ingestieType: "html",
  interval: "*/15 * * * *",
  naam: `Resume evidence ${bronId}`,
  rateLimitPerMinute: 6000,
  retentionDays: 30,
  status: "ready",
  voorwaardenStatus: "toegestaan",
});

const config: JsonLdConnectorConfig = {
  discovery: { kind: "sitemap", url: `http://127.0.0.1:${server.port}/sitemap.xml` },
  parserVersion: "resume-evidence/v1",
  slug: "resume-evidence",
};

console.log(
  `tree: ${resumeOrder ? "PR7 (resume-order lookup)" : "base (listing order)"}; ${JOBS} jobs, crawl delay ${CRAWL_DELAY_MS} ms, run budget ${RUN_BUDGET_MS} ms, ${RUNS} runs; ${VANISHED} disappears from the listing after run 1`
);
const everFetched = new Set<string>();
for (let run = 1; run <= RUNS; run += 1) {
  if (run === 2) {
    listed = listed.filter((id) => id !== VANISHED);
  }
  requests.length = 0;
  let line: string;
  try {
    // oxlint-disable-next-line no-await-in-loop -- poll runs are sequential
    const result = await executeBronRun(new PostgresBronPersistence(database), {
      bronId: bronId as never,
      bronSlug: config.slug,
      connector: createJsonLdConnector({
        bronId,
        client: createJsonLdClient({ config, fetchImpl: fetch, liveEnabled: true }),
        config,
      }),
      ...(resumeOrder ? { resumeOrder: resumeOrder as never } : {}),
      lifecycle: createPostgresLifecyclePorts(database),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new PostgresObservationRecorder(database),
      runLifecycleStore: new PostgresRunStore(database),
      scrapeRunId: crypto.randomUUID() as never,
      signal: AbortSignal.timeout(RUN_BUDGET_MS),
    });
    for (const id of requests) {
      everFetched.add(id);
    }
    const reason = result.completeness.complete ? "complete" : result.completeness.reason;
    line = `fetched ${String(requests.length).padStart(2)} (${requests[0]} … ${requests.at(-1)}), completeness ${reason}, lifecycle ${JSON.stringify(
      result.lifecycle && {
        incremented: result.lifecycle.incremented,
        skippedIncrementReason: result.lifecycle.skippedIncrementReason,
      }
    )}`;
  } catch (error) {
    line = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
  }
  // oxlint-disable-next-line no-await-in-loop -- read back after each run
  const [vanished] = await database
    .select({ missedPolls: schema.sourceRecord.missedPolls })
    .from(schema.sourceRecord)
    .where(
      and(
        eq(schema.sourceRecord.bronId, bronId),
        inArray(schema.sourceRecord.bronReferentie, [
          `http://127.0.0.1:${server.port}/${VANISHED}`,
          VANISHED,
        ])
      )
    );
  console.log(
    `run ${run}: ${line}; distinct jobs fetched so far ${everFetched.size}/${JOBS}; ${VANISHED} missed_polls=${vanished?.missedPolls ?? "no row"}`
  );
}

await database.delete(schema.bron).where(eq(schema.bron.id, bronId));
await client.end({ timeout: 5 });
server.stop(true);
