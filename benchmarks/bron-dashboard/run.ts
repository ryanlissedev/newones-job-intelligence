import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/* oxlint-disable no-await-in-loop -- latency samples must be measured one
   at a time, and the seed inserts are chunked deliberately to bound memory
   against a single pooled connection. */
/**
 * RJC-415 / D9: bron dashboard performance budget on a 50k scrape_run fixture.
 *
 * Budgets:
 * - each bronRunStats / bronRunTimeseries query p95 < 300 ms
 * - composed get_dashboard_overview server path p95 < 1000 ms (window=30d)
 * - zero external HTTP in the measured path
 *
 * Usage: bun benchmarks/bron-dashboard/run.ts
 * Or:    bun run perf:measure --label bron-dashboard --run-kind warm -- bun run bench:bron-dashboard
 */
import { createGetDashboardOverviewHandler } from "../../packages/application/src/registry/handlers/dashboard";
import {
  PostgresAlertStore,
  PostgresBronHealthStore,
} from "../../packages/db/src/bron-health-stores";
import { PostgresBronRunStatsReader } from "../../packages/db/src/bron-run-stats";
import * as schema from "../../packages/db/src/schema";
import { bron } from "../../packages/db/src/schema";
import { PostgresSourceHealthReader } from "../../packages/db/src/source-health-reader";

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";

const RUN_COUNT = Number(process.env.BENCH_RUNS ?? 50_000);
const BRON_COUNT = Number(process.env.BENCH_BRONNEN ?? 12);
const OBSERVATIONS_PER_RUN = Number(process.env.BENCH_OBSERVATIONS ?? 4);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 10);
const QUERY_BUDGET_MS = 300;
const OVERVIEW_BUDGET_MS = 1000;
const SEED_DAYS = 60;

const NOW = new Date();

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index] ?? Number.NaN;
};

interface Measurement {
  cold: number;
  label: string;
  max: number;
  median: number;
  p95: number;
}

const measure = async (
  label: string,
  fn: () => Promise<void>
): Promise<Measurement> => {
  const coldStart = performance.now();
  await fn();
  const cold = performance.now() - coldStart;

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);

  return {
    cold,
    label,
    max: samples.at(-1) ?? Number.NaN,
    median: percentile(samples, 50),
    p95: percentile(samples, 95),
  };
};

const seed = async (sql: postgres.Sql, bronIds: string[]): Promise<void> => {
  const database = drizzle(sql, { schema });

  await database.insert(bron).values(
    bronIds.map((id, index) => ({
      categorie: "overheidsportaal",
      id,
      interval: "*/15 * * * *",
      naam: `Bench Bron ${index}`,
      status: "ready" as const,
      voorwaardenStatus: "toegestaan" as const,
    }))
  );

  const statuses = [
    "succeeded",
    "succeeded",
    "succeeded",
    "failed",
    "cancelled",
  ];
  const hoursSpan = SEED_DAYS * 24;
  const CHUNK = 2000;
  for (let offset = 0; offset < RUN_COUNT; offset += CHUNK) {
    const size = Math.min(CHUNK, RUN_COUNT - offset);
    const values = Array.from({ length: size }, (_, i) => {
      const n = offset + i;
      const status = statuses[n % statuses.length] ?? "succeeded";
      const gestart = new Date(NOW.getTime() - (n % hoursSpan) * 3_600_000);
      const geindigd = new Date(gestart.getTime() + 500 + (n % 5000));
      const failed = status === "failed";
      return {
        aantal_gevonden: 40,
        bron_id: bronIds[n % bronIds.length],
        failure_class: failed ? "connector" : null,
        failure_code: failed ? "FETCH_FAILED" : null,
        failure_message: failed ? "Connector fetch failed" : null,
        failure_phase: failed ? "fetch" : null,
        fouten: failed ? 1 : 0,
        geindigd: geindigd.toISOString(),
        gestart: gestart.toISOString(),
        gewijzigd: 3,
        nieuw: 5,
        rejected: 1,
        run_kind: n % 20 === 0 ? "backfill" : "poll",
        status,
      };
    });

    await sql`
      INSERT INTO curated.scrape_run ${sql(
        values,
        "bron_id",
        "status",
        "run_kind",
        "gestart",
        "geindigd",
        "aantal_gevonden",
        "nieuw",
        "gewijzigd",
        "rejected",
        "fouten",
        "failure_phase",
        "failure_class",
        "failure_code",
        "failure_message"
      )}
    `;
  }

  const runIds = await sql<{ id: string }[]>`
    SELECT id FROM curated.scrape_run
    WHERE bron_id = ANY(${bronIds})
    ORDER BY gestart DESC
    LIMIT ${Math.floor(RUN_COUNT / 4)}
  `;

  for (let offset = 0; offset < runIds.length; offset += 500) {
    const slice = runIds.slice(offset, offset + 500);
    const records = slice.map((row, i) => ({
      bron_id: bronIds[i % bronIds.length],
      bron_referentie: `bench-${row.id}`,
      content_hash: `sha256:bench-${row.id}`,
      raw_payload_ref: `bench/${row.id}.json`,
      scrape_run_id: row.id,
    }));
    const inserted = await sql<{ id: string; scrape_run_id: string }[]>`
      INSERT INTO staging.source_record ${sql(
        records,
        "bron_id",
        "bron_referentie",
        "content_hash",
        "raw_payload_ref",
        "scrape_run_id"
      )}
      RETURNING id, scrape_run_id
    `;

    const observations = inserted.flatMap((record) =>
      Array.from({ length: OBSERVATIONS_PER_RUN }, (_, k) => ({
        bron_id: bronIds[0],
        content_hash: `sha256:obs-${record.id}-${k}`,
        outcome: k === 0 ? "new" : "unchanged",
        payload: JSON.stringify({ bench: true }),
        scrape_run_id: record.scrape_run_id,
        source_record_id: record.id,
      }))
    );

    await sql`
      INSERT INTO staging.aanvraag_observation ${sql(
        observations,
        "bron_id",
        "content_hash",
        "outcome",
        "payload",
        "scrape_run_id",
        "source_record_id"
      )}
    `;
  }

  // Seed health rows so list() has work proportional to bronnen.
  for (const id of bronIds) {
    await sql`
      INSERT INTO curated.bron_health (bron_id, circuit_status, last_run_status, silence_alert_open, updated_at)
      VALUES (${id}, 'closed', 'succeeded', false, ${NOW.toISOString()})
      ON CONFLICT (bron_id) DO NOTHING
    `;
  }
};

const captureExplain = async (
  sql: postgres.Sql,
  label: string,
  query: string
): Promise<{ label: string; plan: string }> => {
  const rows = await sql.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`
  );
  const plan = rows.map((row) => Object.values(row)[0]).join("\n");
  return { label, plan };
};

const main = async (): Promise<void> => {
  let queryCount = 0;
  const sql = postgres(DATABASE_URL, {
    debug: () => {
      queryCount += 1;
    },
    max: 2,
  });
  const database = drizzle(sql, { schema });
  const reader = new PostgresBronRunStatsReader(database);
  const healthStore = new PostgresBronHealthStore(database);
  const alertStore = new PostgresAlertStore(database);
  const sourceHealthReader = new PostgresSourceHealthReader(
    database,
    () => NOW
  );
  const dashboard = createGetDashboardOverviewHandler({
    bronRunStatsReader: reader,
    sourceHealthReader,
    stores: { alerts: alertStore, bronHealth: healthStore },
  });
  const overviewQueryCounts: number[] = [];
  const bronIds = Array.from({ length: BRON_COUNT }, () => crypto.randomUUID());

  try {
    const seedStart = performance.now();
    await seed(sql, bronIds);
    const seedMs = performance.now() - seedStart;

    const runRowRows = await sql<{ count: number }[]>`
      SELECT CAST(count(*) AS integer) AS count
      FROM curated.scrape_run WHERE bron_id = ANY(${bronIds})
    `;
    const runRowsValue = runRowRows[0]?.count ?? 0;
    const observationRowRows = await sql<{ count: number }[]>`
      SELECT CAST(count(*) AS integer) AS count
      FROM staging.aanvraag_observation WHERE scrape_run_id IN (
        SELECT id FROM curated.scrape_run WHERE bron_id = ANY(${bronIds})
      )
    `;
    const observationRowsValue = observationRowRows[0]?.count ?? 0;

    const results: Measurement[] = [];
    for (const window of ["24u", "7d", "30d"] as const) {
      results.push(
        await measure(`bronRunStats(${window})`, async () => {
          await reader.bronRunStats({ bronIds, now: NOW, window });
        }),
        await measure(`bronRunTimeseries(${window}, day)`, async () => {
          await reader.bronRunTimeseries({ bronIds, now: NOW, window });
        })
      );
    }
    results.push(
      await measure("sourceHealthSignals(batch)", async () => {
        const before = queryCount;
        const signals = await sourceHealthReader.listByBronIds(bronIds);
        if (signals.length !== BRON_COUNT || queryCount - before !== 1) {
          throw new Error(
            "Source health must load all fixture sources in one query"
          );
        }
      }),
      await measure("bronRunStats(30d, runKind=all)", async () => {
        await reader.bronRunStats({
          bronIds,
          now: NOW,
          runKind: "all",
          window: "30d",
        });
      }),
      await measure("get_dashboard_overview(30d)", async () => {
        const before = queryCount;
        const result = await dashboard({ window: "30d" });
        overviewQueryCounts.push(queryCount - before);
        if (
          result.value.bronnen.length !== BRON_COUNT ||
          result.value.bronnen.some(
            (row) =>
              row.health?.healthSignals === null ||
              row.health?.healthSignals === undefined
          )
        ) {
          throw new Error(
            "Dashboard fixture did not return every source's health signals"
          );
        }
      })
    );

    // EXPLAIN ANALYZE for the 30d stats shape (window filter on gestart).
    const since30d = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const explains = [
      await captureExplain(
        sql,
        "windowed_runs_30d",
        `SELECT count(*) FROM curated.scrape_run r WHERE r.gestart >= '${since30d.toISOString()}' AND r.run_kind = 'poll'`
      ),
      await captureExplain(
        sql,
        "observation_totals_sample",
        `SELECT o.scrape_run_id, count(*) FILTER (WHERE o.outcome = 'unchanged') AS ongewijzigd
         FROM staging.aanvraag_observation o
         WHERE o.scrape_run_id IN (
           SELECT id FROM curated.scrape_run
           WHERE gestart >= '${since30d.toISOString()}' AND run_kind = 'poll'
           LIMIT 5000
         )
         GROUP BY o.scrape_run_id`
      ),
    ];

    const report = {
      budgets: {
        overviewP95Ms: OVERVIEW_BUDGET_MS,
        queryP95Ms: QUERY_BUDGET_MS,
      },
      explains: explains.map((e) => ({
        label: e.label,
        plan: e.plan,
      })),
      externalHttpInRequestPath: 0,
      fixture: {
        bronnen: BRON_COUNT,
        observationRows: observationRowsValue,
        runRows: runRowsValue,
        seedDays: SEED_DAYS,
        seedMs: Math.round(seedMs),
      },
      generatedAt: new Date().toISOString(),
      iterations: ITERATIONS,
      measurements: results.map((r) => {
        const budget = r.label.startsWith("get_dashboard_overview")
          ? OVERVIEW_BUDGET_MS
          : QUERY_BUDGET_MS;
        return {
          ...r,
          budgetMs: budget,
          cold: Number(r.cold.toFixed(1)),
          max: Number(r.max.toFixed(1)),
          median: Number(r.median.toFixed(1)),
          p95: Number(r.p95.toFixed(1)),
          withinBudget: r.p95 < budget,
        };
      }),
      postgresQueriesPerOverview: overviewQueryCounts,
      unit: "RJC-415",
    };

    const outPath = path.join(
      process.cwd(),
      ".artifacts/performance/rjc-415-bron-dashboard.json"
    );
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

    console.log(
      `fixture: ${runRowsValue} runs, ${observationRowsValue} observations over ${SEED_DAYS}d, seeded in ${Math.round(seedMs)}ms\n`
    );
    for (const r of report.measurements) {
      console.log(
        `${r.withinBudget ? "PASS" : "FAIL"}  ${r.label.padEnd(40)} cold ${String(r.cold).padStart(7)}ms  median ${String(r.median).padStart(7)}ms  p95 ${String(r.p95).padStart(7)}ms  (budget ${r.budgetMs}ms)`
      );
    }
    console.log(`\nwrote ${outPath}`);

    if (report.measurements.some((r) => !r.withinBudget)) {
      process.exitCode = 1;
    }
  } finally {
    await sql`DELETE FROM curated.bron_health WHERE bron_id = ANY(${bronIds})`;
    await sql`DELETE FROM curated.bron WHERE id = ANY(${bronIds})`;
    await sql.end({ timeout: 5 });
  }
};

await main();
