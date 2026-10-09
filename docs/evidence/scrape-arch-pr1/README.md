# Scrape-architecture PR1 — run outcome taxonomy: local fixture run

Recorded 2026-10-09 against a local Postgres 17 (`ji_test`, all migrations through
`0030_scrape_run_outcome_counts` applied) with the committed Randstad JSON-LD
fixtures (offline client, `liveEnabled: false`). Real `runConnector`,
`PostgresRunStore`, `PostgresObservationRecorder`, `PostgresKnownHashStore` and
`PostgresBronRunStatsReader`; in-memory object store.

Scenario:

1. **Run 1** — cold run over the recorded sitemap (5 URLs). Two have a committed
   detail fixture; the three without one are served as HTTP 404 (simulated
   "removed at source") by the harness wrapper.
2. **Run 2** — same sitemap `lastmod`, so the two persisted listing hashes match
   and the connector skips those fetches.
3. **Run 3** — the detail fetch is answered with the Cloudflare challenge error
   (`cloudflareChallengeError`), failing the run.

Before this PR, run 2 persisted `aantal_gevonden 5, nieuw 0, rejected 3` and the
two skipped items were invisible (counted nowhere); a failed run carried only
`failure_code` (`FETCH_FAILED` for a block, a 5xx, a timeout or a parser bug alike).

## Output

```
run 1 (cold, recorded Randstad fixtures): runConnector metrics = {"changed":0,"error":0,"found":5,"new":2,"rejected":3,"unchanged":0,"outcomes":{"rejected_gone":3}}
run 2 (same sitemap lastmod, known hashes): runConnector metrics = {"changed":0,"error":0,"found":5,"new":0,"rejected":3,"unchanged":0,"outcomes":{"skipped_known":2,"rejected_gone":3}}
run 3 (detail pages behind a Cloudflare challenge): run failed -> Connector fetch failed

curated.scrape_run rows for the fixture bron:
┌───┬───────────┬──────────┬───────┬─────────────┬──────────┬───────────────────────────────────────┬──────────────┬──────────────┐
│   │ status    │ gevonden │ nieuw │ ongewijzigd │ rejected │ outcome_counts                        │ failure_code │ failure_kind │
├───┼───────────┼──────────┼───────┼─────────────┼──────────┼───────────────────────────────────────┼──────────────┼──────────────┤
│ 0 │ succeeded │ 5        │ 2     │ 0           │ 3        │ {"rejected_gone":3}                   │ null         │ null         │
│ 1 │ succeeded │ 5        │ 0     │ 0           │ 3        │ {"rejected_gone":3,"skipped_known":2} │ null         │ null         │
│ 2 │ failed    │ 5        │ 0     │ 0           │ 0        │ {"skipped_known":1}                   │ FETCH_FAILED │ blocked      │
└───┴───────────┴──────────┴───────┴─────────────┴──────────┴───────────────────────────────────────┴──────────────┴──────────────┘

bron_run_stats (dashboard read model): {"runs":3,"nieuw":2,"overgeslagen":3,"rejected":6,"lastFailureCode":"FETCH_FAILED","lastFailureKind":"blocked"}
```

Read-out:

- Skipped fetches are now counted (`outcome_counts.skipped_known`) and surface as
  `overgeslagen` in the dashboard read model (2 from run 2 + 1 from run 3 = 3).
- Rejections carry their kind (`rejected_gone` for the 404s).
- The failed run says *what* failed (`failure_kind = blocked`) next to *where*
  (`failure_code = FETCH_FAILED`), and `lastFailureKind` reaches the dashboard.

## Harness

Run from `packages/db` with `bun <file>` (not committed as source; reproduced here).

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

const migratorUrl = "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const appUrl = "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const mig = postgres(migratorUrl, { max: 1, onnotice: () => {} });
await migrate(drizzle(mig, { schema }), { migrationsFolder: path.join(import.meta.dir, "migrations") });
await mig.end();
const client = postgres(appUrl, { max: 2 });
const db = drizzle(client, { schema });
const bronId = crypto.randomUUID();
await db.insert(bron).values({ actief: true, categorie: "evidence", id: bronId, naam: `Randstad fixture ${bronId.slice(0, 8)}`, status: "ready", voorwaardenStatus: "toegestaan" });

const recorded = createJsonLdClient({ config: randstadConfig, liveEnabled: false });
// Listing URLs without a committed detail fixture are served as HTTP 404 (simulated "removed at source").
const fixtureClient = { ...recorded, fetchDetail: async (url: string, signal?: AbortSignal) => {
  try { return await recorded.fetchDetail(url, signal); }
  catch (error) { if ((error as Error).message.startsWith("Missing randstad detail fixture")) { throw new HttpStatusError({ slug: "randstad", status: 404, url }); } throw error; }
} };
const blockedClient = { ...fixtureClient, fetchDetail: (url: string) => Promise.reject(cloudflareChallengeError({ cookieEnvVar: null, slug: "randstad", url })) };
const run = async (label: string, jsonLdClient: typeof fixtureClient) => {
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
      runKind: "poll", runLifecycleStore: new PostgresRunStore(db), scrapeRunId,
    });
    console.log(`${label}: runConnector metrics =`, JSON.stringify(result.metrics));
  } catch (error) {
    console.log(`${label}: run failed -> ${(error as Error).message}`);
  }
};
await run("run 1 (cold, recorded Randstad fixtures)", fixtureClient);
await run("run 2 (same sitemap lastmod, known hashes)", fixtureClient);
await run("run 3 (detail pages behind a Cloudflare challenge)", blockedClient);

const rows = await db.select({ status: scrapeRun.status, gevonden: scrapeRun.aantalGevonden, nieuw: scrapeRun.nieuw, ongewijzigd: scrapeRun.ongewijzigd, rejected: scrapeRun.rejected, outcome_counts: scrapeRun.outcomeCounts, failure_code: scrapeRun.failureCode, failure_kind: scrapeRun.failureKind, gestart: scrapeRun.gestart }).from(scrapeRun).where(eq(scrapeRun.bronId, bronId)).orderBy(scrapeRun.gestart);
console.log("\ncurated.scrape_run rows for the fixture bron:");
console.table(rows.map(({ gestart: _g, ...r }) => ({ ...r, outcome_counts: JSON.stringify(r.outcome_counts) })));
const stats = await new PostgresBronRunStatsReader(db).bronRunStats({ bronIds: [bronId], window: "24u" });
const s = stats.bronnen[0];
console.log("\nbron_run_stats (dashboard read model):", JSON.stringify({ runs: s?.runs, nieuw: s?.nieuw, overgeslagen: s?.overgeslagen, rejected: s?.rejected, lastFailureCode: s?.lastFailureCode, lastFailureKind: s?.lastFailureKind }));
await client.end();
```
