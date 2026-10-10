// Local evidence harness for PR-C (not committed). Run from apps/worker.
import path from "node:path";
import { createBron } from "@ji/application/bronnen";
import { SOURCES } from "@ji/application/sources";
import { InMemoryObjectStore } from "@ji/connectors";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_evidence_c";
process.env.DATABASE_URL = url;
process.env.SEARCH_PROJECTOR = "onbox";
const db = await import("@ji/db");
const schema = await import("@ji/db/schema/index");
const { runBronIngestPipeline } = await import("./poll-bron-run");
const { curateScrapeRun } = await import("@ji/db/curate-scrape-run");

const CHAIN_RUNS = Number(process.env.CHAIN_RUNS ?? 2000);
const raw = postgres(url, { max: 1, onnotice: () => {} });
await migrate(drizzle(raw), { migrationsFolder: path.join(import.meta.dir, "../../../packages/db/src/migrations") });

const client = db.createBronRuntimeClient(url);
const objectStore = new InMemoryObjectStore();
const runtime = {
  ...client,
  createConnector: (o: { bronId: string; knownHashes: unknown; runKind: "poll" }) =>
    SOURCES.hero.createConnector({ ...o, listingFixturePath: "hero/listing-page-0.json", live: false } as never),
  curateStore: new db.PostgresCurateStore(client.database),
  loadBaseline: () => Promise.resolve([]),
  objectStore,
  withSourceHealthTransaction: (op: (x: unknown) => Promise<unknown>) =>
    client.database.transaction((tx) => op({ alerts: new db.PostgresAlertStore(tx), bronHealth: new db.PostgresBronHealthStore(tx), database: tx })),
} as never;
const hero = SOURCES.hero;
const created = createBron({ bronId: hero.bronId, categorie: "msp_broker", crawlDelayMs: 0, interval: "*/15 * * * *", loginVereist: false, mappingRef: null, method: "json-ld", naam: hero.naam, rateLimitPerMinute: 600, retentionDays: 30, secretRef: null, status: "ready", voorwaardenStatus: "toegestaan" });
if (!created.ok) throw new Error("bad bron");
await (runtime as { bronPersistence: { create: (r: unknown) => Promise<void> } }).bronPersistence.create(created.record);
await raw`UPDATE curated.bron SET actief = true WHERE id = ${hero.bronId}`;
const firstRun = crypto.randomUUID();
const first = await runBronIngestPipeline({ bronId: hero.bronId, bronSlug: "hero", scrapeRunId: firstRun }, runtime, "poll");
console.log(`run 1 (recorded Hero fixtures): curated=${first.curated}`);

// Prod shape: every later poll re-observes the same vacancies unchanged and leaves one awaiting row per identity per run.
await raw`
  WITH runs AS (
    INSERT INTO curated.scrape_run (id, bron_id, status, run_kind, fence_token, gestart, geindigd, aantal_gevonden)
    SELECT gen_random_uuid(), ${hero.bronId}::uuid, 'succeeded', 'poll', 1,
           now() + make_interval(secs => g), now() + make_interval(secs => g) + interval '1 second', 2
    FROM generate_series(1, ${CHAIN_RUNS}) g
    RETURNING id, gestart
  )
  INSERT INTO staging.aanvraag_observation (id, scrape_run_id, source_record_id, bron_id, content_hash, outcome, status, payload, created_at)
  SELECT gen_random_uuid(), runs.id, o.source_record_id, o.bron_id, o.content_hash, 'unchanged', 'awaiting_curation',
         jsonb_set(jsonb_set(o.payload, '{scrapeRunId}', to_jsonb(runs.id::text)), '{observedAt}', to_jsonb(to_char(runs.gestart AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
         runs.gestart
  FROM runs CROSS JOIN staging.aanvraag_observation o
  WHERE o.scrape_run_id = ${firstRun}::uuid`;
const [{ backlog }] = await raw`SELECT count(*)::int AS backlog FROM staging.aanvraag_observation WHERE bron_id = ${hero.bronId} AND status = 'awaiting_curation'`;
console.log(`synthetic backlog: ${CHAIN_RUNS} later runs x 2 identities = ${backlog} unchanged rows awaiting curation`);
const [lastRun] = await raw`SELECT id FROM curated.scrape_run WHERE bron_id = ${hero.bronId} ORDER BY gestart DESC LIMIT 1`;

// Same drain loop shape as the poller: passes until nothing remains or the 120 s curate budget runs out.
const deadline = Date.now() + 120_000;
const started = Date.now();
let passes = 0; let remaining = Number(backlog); let superseded = 0; let unchanged = 0;
while (remaining > 0 && Date.now() < deadline) {
  const r = await curateScrapeRun({ bronId: hero.bronId as never, bronSlug: "hero", database: client.database, objectStore, scrapeRunId: lastRun.id });
  passes += 1; remaining = r.remaining; superseded += r.superseded; unchanged += r.unchanged;
  if (passes <= 3 || passes % 25 === 0) console.log(`  pass ${passes}: superseded=${r.superseded} unchanged=${r.unchanged} remaining=${r.remaining}`);
}
console.log(`result: passes=${passes} wall=${((Date.now() - started) / 1000).toFixed(1)}s remaining=${remaining} superseded=${superseded} curated-unchanged=${unchanged}`);
const states = await raw`SELECT status, count(*)::int AS n FROM staging.aanvraag_observation WHERE bron_id = ${hero.bronId} GROUP BY status ORDER BY status`;
console.log("observation statuses:", states.map((s) => `${s.status}=${s.n}`).join(" "));
const seen = await raw`SELECT bool_and(a.laatst_gezien_op >= date_trunc('milliseconds', r.gestart)) AS ok FROM curated.aanvraag a, curated.scrape_run r WHERE a.bron_id = ${hero.bronId} AND r.id = ${lastRun.id}`;
console.log(`laatst_gezien_op reached the newest run on every aanvraag: ${seen[0]?.ok}`);
await client.close(); await raw.end();
