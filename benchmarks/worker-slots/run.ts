import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import path from "node:path";

import type { Connector } from "@ji/connectors";
import {
  createJsonLdClient,
  createJsonLdConnector,
} from "@ji/connectors/json-ld";
import type { JsonLdClient } from "@ji/connectors/json-ld";
import { bron } from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import type { BronId, ScrapeRunId } from "@ji/domain";
import {
  createCriticalPathSession,
  FileCriticalPathSink,
} from "@ji/performance";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "postgres";

import type { PollBronRuntime } from "../../apps/worker/src/poll-bron-run";
import {
  createBronIngestQueue,
  offerBronIngestJob,
  runDurableBronJobConsumer,
} from "../../apps/worker/src/poller/durable-jobs";
import type { BronIngestJob } from "../../apps/worker/src/poller/durable-jobs";
import type { SliceABronSlug } from "../../apps/worker/src/slice-a-bronnen";
import {
  createEventLoopLagProbe,
  createPoolWaitProbe,
  createResourceProbe,
  createSentinelProbe,
  sleepMs,
} from "./instrumentation";
import type {
  EventLoopLagSummary,
  ResourceSummary,
  SentinelSummary,
} from "./instrumentation";
import {
  buildLevelJobRollup,
  corpusDigest,
  mintedListing,
  parseLevels,
  PROBE_BRONNEN,
  resolveMintedDetailUrl,
} from "./probe";
import type {
  JobTiming,
  LevelJobRollup,
  ProbeBronSpec,
  SampleSummary,
} from "./probe";

/* oxlint-disable no-await-in-loop -- the probe is a sequential operator
   script: levels, migrations and cleanup deliberately run one at a time so
   the only measured concurrency is the slot count under test. */

/**
 * CTP-634 worker-slot load proef — operator-invoked, never a gate test.
 *
 *   bun run bench:worker-slots
 *
 * Runs the SAME ingest corpus (13 JSON-LD bronnen × K5_ITEMS_PER_BRON minted
 * detail items, each serving a committed fixture body) at 2, 4, 6 and 8
 * concurrent bron-slots — one slot = one independent
 * `runDurableBronJobConsumer` take loop on the real durable queue driving
 * `runBronIngestPipeline` end-to-end against a fresh disposable `ji_k5_*`
 * database per level. Measures wall clock, RSS, CPU, event-loop lag,
 * pool-reserve wait on the runtime's own pool, sentinel app-read latency,
 * pg backend counts and per-job offer→visible freshness.
 *
 * Env: K5_LEVELS="2,4,6,8" K5_ITEMS_PER_BRON=20 K5_CRAWL_DELAY_MS=5
 *      K5_RATE_LIMIT_PER_MINUTE=600 K5_LEVEL_DEADLINE_MS=600000
 *      K5_OUTPUT_DIR=.artifacts/performance/worker-slots
 *      POSTGRES_HOST_PORT=5432 POSTGRES_ADMIN_USER/PASSWORD
 *      POSTGRES_MIGRATOR_USER/PASSWORD POSTGRES_APP_USER/PASSWORD
 *
 * Safety: the script ONLY creates and drops databases whose names match
 * `ji_k5_*`; shared/dev databases are never touched. No live-source egress:
 * every connector is a fixture client; `*_LIVE` flags are ignored by
 * construction, and SEARCH_PROJECTOR is pinned to "onbox".
 */

const HOST = process.env.POSTGRES_HOST ?? "127.0.0.1";
const PORT = Number(process.env.POSTGRES_HOST_PORT ?? "5432");
const ADMIN_USER = process.env.POSTGRES_ADMIN_USER ?? "ji_admin";
const ADMIN_PASSWORD = process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local";
const MIGRATOR_USER = process.env.POSTGRES_MIGRATOR_USER ?? "ji_migrator";
const MIGRATOR_PASSWORD =
  process.env.POSTGRES_MIGRATOR_PASSWORD ?? "ji_migrator_local";
const APP_USER = process.env.POSTGRES_APP_USER ?? "ji_app";
const APP_PASSWORD = process.env.POSTGRES_APP_PASSWORD ?? "ji_app_local";

/**
 * Positive-finite env number. `Number()` maps malformed input to NaN — for
 * LEVEL_DEADLINE_MS that means `Date.now() >= deadline` stays false forever
 * and a stalled level hangs instead of hitting its deadline, so every
 * numeric knob is validated before any database is provisioned.
 */
const positiveEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got: ${raw}`);
  }
  return value;
};

const LEVELS = parseLevels(process.env.K5_LEVELS ?? "2,4,6,8");
const ITEMS_PER_BRON = positiveEnv("K5_ITEMS_PER_BRON", 20);
const CRAWL_DELAY_MS = positiveEnv("K5_CRAWL_DELAY_MS", 5);
const RATE_LIMIT_PER_MINUTE = positiveEnv("K5_RATE_LIMIT_PER_MINUTE", 600);
const LEVEL_DEADLINE_MS = positiveEnv("K5_LEVEL_DEADLINE_MS", 600_000);
const OUTPUT_DIR =
  process.env.K5_OUTPUT_DIR ?? ".artifacts/performance/worker-slots";
const QUEUE_POLL_INTERVAL_MS = 50;
const SENTINEL_INTERVAL_MS = 50;
const POOL_WAIT_INTERVAL_MS = 25;
const MAX_JOB_ATTEMPTS = 3;

const DATABASE_NAME_PATTERN = /^ji_k5_[a-z0-9_]+$/u;
const ROLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

const MIGRATIONS_FOLDER = path.join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "db",
  "src",
  "migrations"
);

const databaseUrl = (
  username: string,
  password: string,
  database: string
): string => {
  const url = new URL(`postgresql://${HOST}:${PORT}/${database}`);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url.toString();
};

const requireRoleName = (name: string): void => {
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Postgres role name: ${name}`);
  }
};

const requireK5DatabaseName = (name: string): void => {
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(`Refusing to touch non-disposable database: ${name}`);
  }
};

const adminClient = (): Sql =>
  postgres({
    connect_timeout: 3,
    database: "postgres",
    host: HOST,
    max: 1,
    password: ADMIN_PASSWORD,
    port: PORT,
    username: ADMIN_USER,
  });

const dropDatabase = async (name: string): Promise<void> => {
  requireK5DatabaseName(name);
  const admin = adminClient();
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 3 });
  }
};

/** Creates a migrated disposable ji_k5_* database; returns its name. */
const provisionDatabase = async (level: number): Promise<string> => {
  const name = `ji_k5_l${level}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  requireK5DatabaseName(name);
  requireRoleName(MIGRATOR_USER);
  requireRoleName(APP_USER);

  // Anything failing after CREATE DATABASE must not leak the half-provisioned
  // database: runLevel only learns the name on success, so cleanup lives here.
  let created = false;
  try {
    const admin = adminClient();
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      created = true;
      await admin.unsafe(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
      await admin.unsafe(
        `GRANT CONNECT, CREATE ON DATABASE "${name}" TO "${MIGRATOR_USER}"`
      );
      await admin.unsafe(
        `GRANT CONNECT ON DATABASE "${name}" TO "${APP_USER}"`
      );
    } finally {
      await admin.end({ timeout: 3 });
    }

    const adminOnNewDb = postgres(
      databaseUrl(ADMIN_USER, ADMIN_PASSWORD, name),
      {
        max: 1,
      }
    );
    try {
      await adminOnNewDb.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await adminOnNewDb.unsafe(
        `GRANT USAGE, CREATE ON SCHEMA public TO "${MIGRATOR_USER}"`
      );
      await adminOnNewDb.unsafe(
        `GRANT USAGE ON SCHEMA public TO "${APP_USER}"`
      );
      await adminOnNewDb.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${MIGRATOR_USER}" GRANT USAGE ON SCHEMAS TO "${APP_USER}"`
      );
      await adminOnNewDb.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${MIGRATOR_USER}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APP_USER}"`
      );
      await adminOnNewDb.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${MIGRATOR_USER}" GRANT USAGE, SELECT ON SEQUENCES TO "${APP_USER}"`
      );
    } finally {
      await adminOnNewDb.end({ timeout: 3 });
    }

    const migrator = postgres(
      databaseUrl(MIGRATOR_USER, MIGRATOR_PASSWORD, name),
      { max: 1 }
    );
    try {
      await migrate(drizzle(migrator), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await migrator.end({ timeout: 3 });
    }
    return name;
  } catch (error) {
    if (created) {
      await dropDatabase(name).catch(() => null);
    }
    throw error;
  }
};

const seedBronnen = async (
  database: PostgresJsDatabase<typeof schema>
): Promise<void> => {
  for (const spec of PROBE_BRONNEN) {
    await database.insert(bron).values({
      actief: true,
      categorie: spec.categorie,
      crawlDelayMs: CRAWL_DELAY_MS,
      id: spec.bronId,
      interval: "*/15 * * * *",
      naam: spec.naam,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
      retentionDays: 90,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
  }
};

/**
 * A fixture client that serves the minted listing and resolves every minted
 * detail URL back to its committed fixture body. Anything outside the minted
 * set throws — an unscoped URL reaching fetchDetail means the corpus leaked.
 */
const mintedFixtureConnector = (spec: ProbeBronSpec): Connector => {
  const fixtureClient: JsonLdClient = createJsonLdClient({
    config: spec.config,
    liveEnabled: false,
  });
  const listing = mintedListing(spec, ITEMS_PER_BRON);
  const client: JsonLdClient = {
    fetchDetail: (url, signal) => {
      const fixtureUrl = resolveMintedDetailUrl(url);
      if (fixtureUrl === null) {
        return Promise.reject(
          new Error(`k5 probe: unscoped detail URL ${url}`)
        );
      }
      return fixtureClient.fetchDetail(fixtureUrl, signal);
    },
    fetchListing: () => Promise.resolve(listing),
  };
  // SAFETY: bronId comes straight from the probe corpus, which the spec
  // asserts equals the registry id for each slug.
  return createJsonLdConnector({
    bronId: spec.bronId as BronId,
    client,
    config: spec.config,
  });
};

interface PgDatabaseCounters {
  readonly deadlocks: number;
  readonly numbackends: number;
  readonly tupInserted: number;
  readonly tupReturned: number;
  readonly xactCommit: number;
}

const readPgDatabaseCounters = async (
  sql: Sql,
  databaseName: string
): Promise<PgDatabaseCounters | null> => {
  const [row] = await sql<
    {
      deadlocks: number;
      numbackends: number;
      tup_inserted: number;
      tup_returned: number;
      xact_commit: number;
    }[]
  >`
    SELECT numbackends::int AS numbackends,
           xact_commit::int AS xact_commit,
           tup_returned::int AS tup_returned,
           tup_inserted::int AS tup_inserted,
           deadlocks::int AS deadlocks
    FROM pg_stat_database
    WHERE datname = ${databaseName}
  `;
  if (!row) {
    return null;
  }
  return {
    deadlocks: row.deadlocks,
    numbackends: row.numbackends,
    tupInserted: row.tup_inserted,
    tupReturned: row.tup_returned,
    xactCommit: row.xact_commit,
  };
};

interface LevelResult {
  readonly attempts: number;
  readonly completedJobs: number;
  readonly database: string;
  readonly deadlineHit: boolean;
  readonly eventLoop: EventLoopLagSummary | null;
  readonly failedJobs: number;
  readonly jobErrors: number;
  readonly jobs: LevelJobRollup;
  readonly pgCountersDelta: PgDatabaseCounters | null;
  readonly poolWait: SampleSummary | null;
  readonly resources: ResourceSummary | null;
  readonly sentinel: SentinelSummary;
  readonly slots: number;
  readonly startedAt: string;
  readonly wallMs: number;
}

const waitForCompletedJobs = async (
  sql: Sql,
  expected: number,
  deadlineMs: number
): Promise<boolean> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const [row] = await sql<{ completed: number }[]>`
      SELECT count(*)::int AS completed
      FROM curated.durable_job
      WHERE queue_name = 'bron-ingest' AND completed = true
    `;
    if ((row?.completed ?? 0) >= expected) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleepMs(100);
  }
};

const runLevel = async (slots: number): Promise<LevelResult> => {
  const databaseName = await provisionDatabase(slots);
  process.stderr.write(`k5-probe: level ${slots} slots on ${databaseName}\n`);
  const appUrl = databaseUrl(APP_USER, APP_PASSWORD, databaseName);
  const adminOnDb = postgres(
    databaseUrl(ADMIN_USER, ADMIN_PASSWORD, databaseName),
    { max: 1 }
  );
  const rawDir = await mkdtemp(path.join(tmpdir(), "ji-k5-raw-"));

  // Per-level env: the runtime + projector-mode read process.env at call
  // time, so point them at this level's disposable state.
  process.env.DATABASE_URL = appUrl;
  process.env.SEARCH_PROJECTOR = "onbox";
  process.env.RAW_OBJECT_STORE_PATH = rawDir;
  // RAW_S3_* wins over RAW_OBJECT_STORE_PATH inside createRawObjectStore —
  // a leaked production-shaped env would upload every fixture payload to the
  // real durable bucket. The probe's raw store must stay filesystem-only.
  delete process.env.RAW_S3_ACCESS_KEY_ID;
  delete process.env.RAW_S3_BUCKET;
  delete process.env.RAW_S3_ENDPOINT;
  delete process.env.RAW_S3_REGION;
  delete process.env.RAW_S3_SECRET_ACCESS_KEY;

  const client = postgres(appUrl, { max: 4 });
  const database = drizzle(client, { schema });
  // poll-bron-run transitively opens a module-scope client on DATABASE_URL
  // (via @ji/db index), so it must be imported only after this level's env
  // is in place — the same reason the cohort specs dynamic-import it.
  const { createPollBronRuntime, runBronIngestPipeline } =
    await import("../../apps/worker/src/poll-bron-run");
  const runtime = createPollBronRuntime(appUrl);
  const wiredRuntime: PollBronRuntime = {
    ...runtime,
    createConnector: ({ bronSlug }) => {
      const spec = PROBE_BRONNEN.find(
        (candidate) => candidate.bronSlug === bronSlug
      );
      if (!spec) {
        throw new Error(`k5 probe: ${String(bronSlug)} is not in the corpus`);
      }
      return mintedFixtureConnector(spec);
    },
  };
  const sentinelClient = postgres(appUrl, { max: 1 });
  const queues: { close: () => Promise<void> }[] = [];
  const controllers: AbortController[] = [];
  const consumers: Promise<void>[] = [];
  const timings: JobTiming[] = [];
  let jobErrors = 0;

  try {
    await seedBronnen(database);
    const offerQueue = await createBronIngestQueue(appUrl, {
      lockExpiration: "5 seconds",
      lockRefreshInterval: "500 millis",
      pollInterval: `${QUEUE_POLL_INTERVAL_MS} millis`,
    });
    queues.push(offerQueue);
    const jobs: BronIngestJob[] = PROBE_BRONNEN.map((spec) => ({
      bronId: spec.bronId,
      bronSlug: spec.bronSlug,
      scrapeRunId: crypto.randomUUID(),
    }));
    const offeredAt = new Map<string, number>();
    for (const job of jobs) {
      offeredAt.set(job.scrapeRunId, performance.now());
      await offerBronIngestJob(offerQueue.queue, job);
    }

    const pgBefore = await readPgDatabaseCounters(adminOnDb, databaseName);

    const eventLoop = createEventLoopLagProbe();
    const resources = createResourceProbe();
    const poolWait = createPoolWaitProbe();
    const sentinel = createSentinelProbe();
    const probeSignal = new AbortController();

    const startedAt = new Date();
    const wallStart = performance.now();
    eventLoop.start();
    resources.start();
    const probes = [
      poolWait.run(
        // SAFETY: drizzle() attaches the underlying postgres-js client as
        // $client; the BronRuntimeDatabase alias drops that property from the
        // type but not from the object. reserve() on it measures THIS pool's
        // contention — the only honest pool-wait signal.
        (
          runtime.database as PostgresJsDatabase<typeof schema> & {
            $client: Sql;
          }
        ).$client,
        POOL_WAIT_INTERVAL_MS,
        probeSignal.signal
      ),
      sentinel.run(
        sentinelClient,
        databaseName,
        SENTINEL_INTERVAL_MS,
        probeSignal.signal
      ),
    ];

    const onJobError = (): void => {
      jobErrors += 1;
    };
    // One processJob per consumer, closing over that consumer's abort signal,
    // so a level deadline/shutdown propagates into the in-flight pipeline the
    // same way production's signal does — instead of the pipeline writing into
    // a database the finally block is already dropping.
    const makeProcessJob =
      (signal: AbortSignal) =>
      async (job: BronIngestJob): Promise<void> => {
        const jobStart = performance.now();
        // SAFETY: job rows are offered by this script with seeded ids, so
        // every branded-type field is a value this run minted itself.
        const result = await runBronIngestPipeline(
          {
            bronId: job.bronId as BronId,
            bronSlug: job.bronSlug as SliceABronSlug,
            scrapeRunId: job.scrapeRunId as ScrapeRunId,
          },
          wiredRuntime,
          "poll",
          { signal }
        );
        const ended = performance.now();
        timings.push({
          bronSlug: job.bronSlug,
          durationMs: Math.round(ended - jobStart),
          freshnessMs: Math.round(
            ended - (offeredAt.get(job.scrapeRunId) ?? jobStart)
          ),
          rejectedRecords: result.metrics.rejected,
          scrapeRunId: job.scrapeRunId,
          writtenRecords: result.writtenRecords,
        });
      };

    for (let index = 0; index < slots; index += 1) {
      const queue = await createBronIngestQueue(appUrl, {
        lockExpiration: "5 seconds",
        lockRefreshInterval: "500 millis",
        pollInterval: `${QUEUE_POLL_INTERVAL_MS} millis`,
      });
      queues.push(queue);
      const controller = new AbortController();
      controllers.push(controller);
      consumers.push(
        runDurableBronJobConsumer({
          maxAttempts: MAX_JOB_ATTEMPTS,
          onJobError,
          processJob: makeProcessJob(controller.signal),
          queue: queue.queue,
          signal: controller.signal,
        })
      );
    }

    const deadlineHit = !(await waitForCompletedJobs(
      client,
      jobs.length,
      LEVEL_DEADLINE_MS
    ));
    const wallMs = Math.round(performance.now() - wallStart);
    // Stop the wall-clock probes at the same boundary wallMs measures —
    // probe drain, consumer cancellation and the bookkeeping queries below
    // must not leak into the reported CPU/RSS/event-loop numbers.
    const eventLoopSummary = eventLoop.stop();
    const resourceSummary = resources.stop(wallMs);
    probeSignal.abort();
    // Abort consumers BEFORE draining probes: their released pool connections
    // are what lets a still-pending sql.reserve() sample settle.
    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.allSettled([...consumers, ...probes]);

    const jobRows = await client<
      { attempts: number; completed: boolean; last_failure: string | null }[]
    >`
      SELECT attempts, completed, last_failure
      FROM curated.durable_job
      WHERE queue_name = 'bron-ingest'
    `;
    const pgAfter = await readPgDatabaseCounters(adminOnDb, databaseName);

    return {
      attempts: jobRows.reduce((total, row) => total + row.attempts, 0),
      completedJobs: jobRows.filter((row) => row.completed).length,
      database: databaseName,
      deadlineHit,
      eventLoop: eventLoopSummary,
      failedJobs: jobRows.filter((row) => row.last_failure !== null).length,
      jobErrors,
      jobs: buildLevelJobRollup(timings),
      pgCountersDelta:
        pgBefore && pgAfter
          ? {
              deadlocks: pgAfter.deadlocks - pgBefore.deadlocks,
              numbackends: pgAfter.numbackends,
              tupInserted: pgAfter.tupInserted - pgBefore.tupInserted,
              tupReturned: pgAfter.tupReturned - pgBefore.tupReturned,
              xactCommit: pgAfter.xactCommit - pgBefore.xactCommit,
            }
          : null,
      poolWait: poolWait.summary(),
      resources: resourceSummary,
      sentinel: sentinel.summary(),
      slots,
      startedAt: startedAt.toISOString(),
      wallMs,
    };
  } finally {
    for (const queue of queues) {
      await queue.close().catch(() => null);
    }
    await runtime.close().catch(() => null);
    await sentinelClient.end({ timeout: 3 }).catch(() => null);
    await client.end({ timeout: 3 }).catch(() => null);
    await adminOnDb.end({ timeout: 3 }).catch(() => null);
    await rm(rawDir, { force: true, recursive: true }).catch((error: Error) => {
      process.stderr.write(
        `k5-probe: failed to remove raw dir ${rawDir}: ${error.message}\n`
      );
    });
    await dropDatabase(databaseName).catch((error: Error) => {
      process.stderr.write(
        `k5-probe: failed to drop ${databaseName}: ${error.message}\n`
      );
    });
  }
};

const collectGitSha = async (): Promise<string | null> => {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const sha = output.trim();
  return exitCode === 0 && /^[a-f0-9]{40}$/u.test(sha) ? sha : null;
};

const readPostgresVersion = async (): Promise<string> => {
  const admin = adminClient();
  try {
    const [row] = await admin<{ server_version: string }[]>`
      SHOW server_version
    `;
    return row?.server_version ?? "unavailable";
  } finally {
    await admin.end({ timeout: 3 });
  }
};

/**
 * One schema-conformant in-process record per level (ADR-0001 evidence
 * contract): the aggregate JSON is the decision artifact, these records are
 * what the standard report/aggregate tooling can consume.
 */
const emitLevelRecord = async (
  level: LevelResult,
  digest: string,
  postgresVersion: string,
  sink: FileCriticalPathSink
): Promise<void> => {
  const session = createCriticalPathSession({
    executor: "k5-worker-slots-probe",
    metadata: {
      concurrency: String(level.slots),
      dataset: "k5-worker-slot-corpus",
      "dataset-digest": digest,
      "item-count": String(PROBE_BRONNEN.length * ITEMS_PER_BRON),
      job: "bron-ingest",
      machine: "k5-probe-box",
      "postgres-version": postgresVersion,
      "records-per-second": String(
        level.wallMs > 0
          ? Math.round(level.jobs.itemsWritten / (level.wallMs / 1000))
          : 0
      ),
    },
    runKind: "cold",
    sink,
  });
  session.recordSample({
    durationMs: level.wallMs,
    endedAt: new Date().toISOString(),
    label: "ingest-commit",
    startedAt: level.startedAt,
    success: level.failedJobs === 0 && !level.deadlineHit,
  });
  await session.flush();
};

const buildResults = async (
  levels: readonly LevelResult[],
  digest: string,
  postgresVersion: string
) => {
  const cpuList = cpus();
  return {
    config: {
      crawlDelayMs: CRAWL_DELAY_MS,
      levelDeadlineMs: LEVEL_DEADLINE_MS,
      maxJobAttempts: MAX_JOB_ATTEMPTS,
      queuePollIntervalMs: QUEUE_POLL_INTERVAL_MS,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
      runtimePoolMax: 10,
    },
    corpus: {
      bronnen: PROBE_BRONNEN.map((spec) => ({
        bronId: spec.bronId,
        bronSlug: spec.bronSlug,
        fixtureDetailUrls: spec.fixtureDetailUrls.length,
      })),
      digest,
      itemsPerBron: ITEMS_PER_BRON,
      totalItems: PROBE_BRONNEN.length * ITEMS_PER_BRON,
    },
    generatedAt: new Date().toISOString(),
    git: { sha: await collectGitSha() },
    hardware: {
      arch: arch(),
      cpuCount: cpuList.length,
      cpuModel: cpuList.at(0)?.model ?? "unavailable",
      memoryBytes: totalmem(),
      os: platform(),
      osRelease: release(),
      postgresVersion,
    },
    levels,
    schemaVersion: 1,
  };
};

const printSummaryTable = (levels: readonly LevelResult[]): void => {
  process.stdout.write(
    `${"slots".padStart(6)} ${"wall s".padStart(8)} ${"job p50".padStart(9)} ${"job p95".padStart(9)} ${"fresh p95".padStart(10)} ${"evl p95".padStart(8)} ${"evl max".padStart(8)} ${"rss MB".padStart(9)} ${"cpu%".padStart(7)} ${"pool p95".padStart(9)} ${"sent p95".padStart(9)} ${"backends".padStart(9)} ${"fail".padStart(5)}\n`
  );
  for (const level of levels) {
    const row = [
      String(level.slots).padStart(6),
      (level.wallMs / 1000).toFixed(1).padStart(8),
      String(level.jobs.duration?.p50 ?? "-").padStart(9),
      String(level.jobs.duration?.p95 ?? "-").padStart(9),
      String(level.jobs.freshness?.p95 ?? "-").padStart(10),
      String(level.eventLoop?.p95Ms ?? "-").padStart(8),
      String(level.eventLoop?.maxMs ?? "-").padStart(8),
      String(
        level.resources
          ? Math.round(level.resources.peakRssBytes / 1_048_576)
          : "-"
      ).padStart(9),
      String(
        level.resources ? Math.round(level.resources.cpuUtilisation * 100) : "-"
      ).padStart(7),
      String(level.poolWait?.p95 ?? "-").padStart(9),
      String(level.sentinel.latency?.p95 ?? "-").padStart(9),
      String(level.sentinel.backendPeak ?? "-").padStart(9),
      String(level.failedJobs).padStart(5),
    ];
    process.stdout.write(`${row.join(" ")}\n`);
  }
};

const main = async (): Promise<void> => {
  if (!Number.isInteger(ITEMS_PER_BRON) || ITEMS_PER_BRON < 1) {
    throw new Error("K5_ITEMS_PER_BRON must be a positive integer");
  }
  const postgresVersion = await readPostgresVersion();

  const levels: LevelResult[] = [];
  const digest = await corpusDigest(ITEMS_PER_BRON);
  const sink = new FileCriticalPathSink(OUTPUT_DIR);
  for (const slots of LEVELS) {
    const level = await runLevel(slots);
    await emitLevelRecord(level, digest, postgresVersion, sink);
    levels.push(level);
  }

  const results = await buildResults(levels, digest, postgresVersion);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const destination = path.join(
    OUTPUT_DIR,
    `k5-worker-slot-load-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}.json`
  );
  await writeFile(destination, `${JSON.stringify(results, null, 2)}\n`);

  process.stdout.write(`\nk5-probe results written to ${destination}\n\n`);
  printSummaryTable(results.levels);
  if (results.levels.some((level) => level.deadlineHit)) {
    process.stderr.write(
      "k5-probe: at least one level hit its deadline — see failedJobs/deadlineHit in the results JSON\n"
    );
    process.exitCode = 2;
  }
};

if (import.meta.main) {
  await main();
}
