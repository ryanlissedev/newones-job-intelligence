// Evidence harness for PR3: prod-shaped bron registry in a scratch DB, then the read-only reconcile.
import path from "node:path";
import { MOTIAN_V1_BRON_SEEDS } from "@ji/application/backfill";
import { SOURCES } from "@ji/application/sources";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_evidence_3";
process.env.DATABASE_URL = url;
const db = await import("@ji/db");
const schema = await import("@ji/db/schema/index");
const { ensureMissingSliceABronnen } = await import("./smoke-seed");
const { reportSeedDrift, logSeedDriftAtBoot } = await import("./seed-reconcile");

const raw = postgres(url, { max: 2, onnotice: () => {} });
await migrate(drizzle(raw), { migrationsFolder: path.join(import.meta.dir, "../../../packages/db/src/migrations") });
const database = drizzle(raw, { schema });

// Prod shape (MEASURED.md 2026-10-09): 38 code sources have a row, 11 do not; all rows reviewed toegestaan;
// intermediair/prounity/rabobank inactive; 5 v1-backfill feed rows that have no code source.
const missing = new Set(["alliander", "circle8", "enexis", "essent", "gasunie", "indeed", "linkedin", "mercell", "stedin", "tennet", "werk-nl"]);
const present = Object.values(SOURCES).filter((d) => !missing.has(d.slug));
await ensureMissingSliceABronnen(database, present);
await raw`UPDATE curated.bron SET voorwaarden_status = 'toegestaan', status = 'ready'`;
await raw`UPDATE curated.bron SET actief = true WHERE naam NOT IN ${raw(present.filter((d) => ["intermediair", "prounity", "rabobank"].includes(d.slug)).map((d) => d.naam))}`;
await db.seedMotianV1Bronnen(database, MOTIAN_V1_BRON_SEEDS);

const fingerprint = async () => (await raw`SELECT md5(string_agg(b::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM curated.bron b`)[0];
const before = await fingerprint();
console.log(`bron rows: ${before.n}  fingerprint before: ${before.h}`);

const report = await reportSeedDrift(database);
console.log("--- report (bun apps/worker/scripts/bron-seed-reconcile.ts output shape) ---");
console.log(JSON.stringify({ ...report, voorwaardenDrift: `${report.voorwaardenDrift.length} entries, e.g. ${JSON.stringify(report.voorwaardenDrift[0])}` }, null, 2));
console.log("--- poller boot line ---");
await logSeedDriftAtBoot(() => reportSeedDrift(database));
const after = await fingerprint();
console.log(`fingerprint after:  ${after.h}  unchanged: ${before.h === after.h && before.n === after.n}`);
await raw.end();
