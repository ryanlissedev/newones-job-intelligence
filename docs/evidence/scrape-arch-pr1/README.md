# Scrape-architecture PR1 — run outcome taxonomy: local fixture run

Recorded 2026-10-09 07:4x CEST against a fresh local Postgres 17 database
(`ji_evidence`, every migration through `0030_scrape_run_outcome_counts`
applied) with the committed Randstad JSON-LD fixtures (offline client,
`liveEnabled: false`). The harness uses the real `runConnector`,
`PostgresRunStore`, `PostgresObservationRecorder`, `PostgresKnownHashStore` and
`PostgresBronRunStatsReader`, with an in-memory object store.

Scenario, mapped to the prod measurements of 2026-10-09 (MEASURED.md):

1. **Run 1**: a cold run over the recorded sitemap (5 URLs). Two URLs have a
   committed detail fixture. The harness serves the other three as **HTTP 410
   Gone**, which is what Randstad and BAM answer for closed vacancies. In prod,
   one 410 killed 10/43 Randstad runs and 5/42 BAM runs.
2. **Run 2**: same sitemap `lastmod`. The two persisted listing hashes match,
   so the connector skips those two fetches.
3. **Run 3**: the detail fetch gets the Cloudflare challenge error, so the run
   fails. Planet Interim fails the same way on 100% of its runs.
4. **Run 4**: the run-budget timer (`AbortSignal.timeout`, a `TimeoutError`
   reason) fires while the second detail request is in flight. Techniekwerkt
   hits its 5.5 h budget on 8/9 runs, and every such row says `succeeded`.

Before this PR:
- Run 1 failed on the first 410.
- In run 2, the skipped items were counted nowhere.
- Run 3 carried only `FETCH_FAILED`, which a block, a 5xx, a timeout and a
  parser bug all share.
- Run 4 was a plain `succeeded` row, indistinguishable from a complete run.

## Output

```
run 1 (cold, recorded Randstad fixtures): runConnector metrics = {"changed":0,"error":0,"found":5,"new":2,"rejected":3,"unchanged":0,"outcomes":{"rejected_gone":3}}
run 2 (same sitemap lastmod, known hashes): runConnector metrics = {"changed":0,"error":0,"found":5,"new":0,"rejected":3,"unchanged":0,"outcomes":{"skipped_known":2,"rejected_gone":3}}
run 3 (detail pages behind a Cloudflare challenge): run failed -> Connector fetch failed
run 4 (run budget fires mid-run, cf. Techniekwerkt): runConnector metrics = {"changed":0,"error":0,"found":5,"new":1,"rejected":0,"unchanged":0}

curated.scrape_run rows for the fixture bron:
┌───┬───────────┬──────────┬───────┬─────────────┬──────────┬───────────────────────────────────────┬──────────────┬──────────────┬──────────────────┐
│   │ status    │ gevonden │ nieuw │ ongewijzigd │ rejected │ outcome_counts                        │ failure_code │ failure_kind │ completion       │
├───┼───────────┼──────────┼───────┼─────────────┼──────────┼───────────────────────────────────────┼──────────────┼──────────────┼──────────────────┤
│ 0 │ succeeded │ 5        │ 2     │ 0           │ 3        │ {"rejected_gone":3}                   │ null         │ null         │ complete         │
│ 1 │ succeeded │ 5        │ 0     │ 0           │ 3        │ {"rejected_gone":3,"skipped_known":2} │ null         │ null         │ complete         │
│ 2 │ failed    │ 5        │ 0     │ 0           │ 0        │ {"skipped_known":1}                   │ FETCH_FAILED │ blocked      │ null             │
│ 3 │ succeeded │ 5        │ 1     │ 0           │ 0        │ {}                                    │ null         │ null         │ budget_exhausted │
└───┴───────────┴──────────┴───────┴─────────────┴──────────┴───────────────────────────────────────┴──────────────┴──────────────┴──────────────────┘

bron_run_stats (dashboard read model): {"runs":4,"nieuw":3,"overgeslagen":3,"rejected":6,"lastFailureCode":"FETCH_FAILED","lastFailureKind":"blocked","succeeded":3,"onvolledig":1,"lastCompletion":"budget_exhausted"}
```

What the output shows:

- **410 tolerance:** the 410 pages are rejected as `rejected_gone` and the run
  succeeds.
- **Skipped items:** they are now counted (`outcome_counts.skipped_known`) and
  appear as `overgeslagen` in the dashboard read model. That is 2 from run 2
  plus 1 from run 3, so 3.
- **Failure kind:** the failed run records *what* failed
  (`failure_kind = blocked`) as well as *where* (`FETCH_FAILED`).
- **Budget cuts:** a budget-cut run stays `succeeded` with its checkpoint, but
  it is marked `completion = budget_exhausted`. It is counted in `onvolledig`,
  and `lastCompletion` surfaces it.

## Harness

The harness is not committed as source; it is reproduced here. Run it from
`packages/db` with `bun <file>` against a scratch database.

```ts
// Local evidence harness for scrape-arch PR1 (not committed).
import path from "node:path";
import { HttpStatusError, cloudflareChallengeError, createJsonLdClient, createJsonLdConnector, randstadConfig } from "@ji/connectors/json-ld";
import { CrawlDelayLimiter, InMemoryObjectStore, runConnector } from "@ji/connectors";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { PostgresBronRunStatsReader } from "./bron-run-stats";
import { PostgresObservationRecorder, PostgresRunStore } from "./bron-runtime";
import { PostgresKnownHashStore } from "./known-hash-store";
import * as schema from "./schema";
import { bron, scrapeRun } from "./schema";

const migratorUrl = "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_evidence";
const appUrl = migratorUrl; // fresh scratch DB owned by the migrator role
const mig = postgres(migratorUrl, { max: 1, onnotice: () => {} });
await migrate(drizzle(mig, { schema }), { migrationsFolder: path.join(import.meta.dir, "migrations") });
await mig.end();
const client = postgres(appUrl, { max: 2 });
const db = drizzle(client, { schema });
const bronId = crypto.randomUUID();
await db.insert(bron).values({ actief: true, categorie: "evidence", id: bronId, naam: `Randstad fixture ${bronId.slice(0, 8)}`, status: "ready", voorwaardenStatus: "toegestaan" });

const recorded = createJsonLdClient({ config: randstadConfig, liveEnabled: false });
// Listing URLs without a committed detail fixture are served as HTTP 410 Gone (what Randstad answers for closed vacancies).
const fixtureClient = { ...recorded, fetchDetail: async (url: string, signal?: AbortSignal) => {
  try { return await recorded.fetchDetail(url, signal); }
  catch (error) { if ((error as Error).message.startsWith("Missing randstad detail fixture")) { throw new HttpStatusError({ slug: "randstad", status: 410, url }); } throw error; }
} };
const blockedClient = { ...fixtureClient, fetchDetail: (url: string) => Promise.reject(cloudflareChallengeError({ cookieEnvVar: null, slug: "randstad", url })) };
const run = async (label: string, jsonLdClient: typeof fixtureClient, signal?: AbortSignal) => {
  const scrapeRunId = crypto.randomUUID();
  try {
    const result = await runConnector({
      bronId, bronSlug: "randstad",
      connector: createJsonLdConnector({ bronId, client: jsonLdClient, config: randstadConfig, knownHashes: new PostgresKnownHashStore(db) }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new PostgresObservationRecorder(db),
      rawRetentionDays: 30,
      retryPolicy: { initialDelayMs: 0, jitter: (d: number) => d, maxAttempts: 1, maxDelayMs: 0, multiplier: 1 },
      runKind: "poll", runLifecycleStore: new PostgresRunStore(db), scrapeRunId, signal,
    });
    console.log(`${label}: runConnector metrics =`, JSON.stringify(result.metrics));
  } catch (error) {
    console.log(`${label}: run failed -> ${(error as Error).message}`);
  }
};
await run("run 1 (cold, recorded Randstad fixtures)", fixtureClient);
await run("run 2 (same sitemap lastmod, known hashes)", fixtureClient);
await run("run 3 (detail pages behind a Cloudflare challenge)", blockedClient);
// Run 4: the poller's run budget (AbortSignal.timeout) fires after the first detail fetch.
const budget = new AbortController();
let budgetCalls = 0;
// The 2nd detail request is in flight when the budget timer fires: fetch rejects with the signal's reason, as a real aborted fetch does.
const budgetClient = { ...fixtureClient, fetchDetail: async (url: string, s?: AbortSignal) => { budgetCalls += 1; if (budgetCalls === 2) { budget.abort(new DOMException("run budget", "TimeoutError")); throw budget.signal.reason; } return fixtureClient.fetchDetail(url, s); } };
await db.delete(schema.sourceRecord).where(eq(schema.sourceRecord.bronId, bronId)); // forget known hashes so run 4 fetches again
await run("run 4 (run budget fires mid-run, cf. Techniekwerkt)", budgetClient, budget.signal);

const rows = await db.select({ status: scrapeRun.status, gevonden: scrapeRun.aantalGevonden, nieuw: scrapeRun.nieuw, ongewijzigd: scrapeRun.ongewijzigd, rejected: scrapeRun.rejected, outcome_counts: scrapeRun.outcomeCounts, failure_code: scrapeRun.failureCode, failure_kind: scrapeRun.failureKind, completion: scrapeRun.completion, gestart: scrapeRun.gestart }).from(scrapeRun).where(eq(scrapeRun.bronId, bronId)).orderBy(scrapeRun.gestart);
console.log("\ncurated.scrape_run rows for the fixture bron:");
console.table(rows.map(({ gestart: _g, ...r }) => ({ ...r, outcome_counts: JSON.stringify(r.outcome_counts) })));
const stats = await new PostgresBronRunStatsReader(db).bronRunStats({ bronIds: [bronId], window: "24u" });
const s = stats.bronnen[0];
console.log("\nbron_run_stats (dashboard read model):", JSON.stringify({ runs: s?.runs, nieuw: s?.nieuw, overgeslagen: s?.overgeslagen, rejected: s?.rejected, lastFailureCode: s?.lastFailureCode, lastFailureKind: s?.lastFailureKind, succeeded: s?.succeeded, onvolledig: s?.onvolledig, lastCompletion: s?.lastCompletion }));
await client.end();
```
