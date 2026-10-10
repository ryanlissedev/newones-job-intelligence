/**
 * Restore drill for one complete ingest chain (CTP-632).
 *
 * Proves on disposable `ji_restore_drill_*` databases that an operator can
 * reconstruct processing state after losing the database mid-chain:
 *
 *   seed bron → durable job → real ingest (scrape_run + source_record +
 *   aanvraag_observation + curated aanvraag + outbox) → pg_dump backup →
 *   post-backup commit that the backup does NOT contain → DROP DATABASE →
 *   restore into a fresh database → retake the unfinished durable job →
 *   checkpoint resume → idempotent replay → receipt.
 *
 * What this drill proves and what it does not:
 *
 * - It exercises the real runtime path: `curated.durable_job` claim/release,
 *   `PostgresRunStore` resume with a persisted checkpoint, the observation
 *   recorder's (bronId, bronReferentie) dedupe, `curateScrapeRun`, and the
 *   outbox commit. The connector is a deterministic fixture — no live
 *   egress — because the drill measures Postgres recovery, not the network.
 * - The backup is a real `pg_dump` of the source database, the same logical
 *   format the production pre-migration lane uses (ADR-0011 /
 *   docs/runbooks/postgres-restore-v1.md). It runs on this host's pg_dump
 *   when present, otherwise inside the already-running Postgres container —
 *   the drill refuses to fake a backup when no dump tool exists.
 * - The raw object store is an in-memory fixture held constant across the
 *   outage, mirroring production where raw payloads live in S3, outside the
 *   Postgres backup boundary. Object-store loss is a different drill.
 * - Search-side projection is reported `unknown`, not verified: the
 *   restored outbox rows and `search_projection_checkpoint` are checked for
 *   presence and referential integrity, but the drill does not run the
 *   on-box projector against a Manticore. Manticore is a rebuildable index;
 *   the outbox is the recoverable evidence.
 * - Nothing here touches production data or `ji_test`. Both databases are
 *   created and dropped by this script; `--keep` retains them for
 *   inspection.
 *
 * Usage:
 *   bun tools/backfill/restore-drill.ts [--output .artifacts/restore-drill-receipt.json] [--keep]
 *
 * Credentials default to the local dev roles (ji_admin / ji_migrator /
 * ji_app on 127.0.0.1:5432); override with POSTGRES_ADMIN_USER,
 * POSTGRES_ADMIN_PASSWORD, POSTGRES_MIGRATOR_USER,
 * POSTGRES_MIGRATOR_PASSWORD, POSTGRES_APP_USER, POSTGRES_APP_PASSWORD,
 * POSTGRES_HOST_PORT and RESTORE_DRILL_PG_CONTAINER.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SOURCES } from "@ji/application/sources";
import { hashContent, InMemoryObjectStore } from "@ji/connectors";
import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  ConnectorFetchResult,
  DiscoverItem,
  ObjectStore,
} from "@ji/connectors";
import {
  PostgresAlertStore,
  PostgresBronHealthStore,
} from "@ji/db/bron-health-stores";
import { PostgresCurateStore } from "@ji/db/postgres-curate-store";
import { createBronRuntimeClient } from "@ji/db/runtime-client";
import { bron } from "@ji/db/schema/curated";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Effect } from "effect";
import postgres from "postgres";

import { mapUnknownToWorkerFault } from "../../apps/worker/src/effect/faults";
import { fromWorkerPromise } from "../../apps/worker/src/effect/from-promise";
import { runWorkerPromise } from "../../apps/worker/src/effect/run";
import type {
  BronIngestPipelineResult,
  PollBronRuntime,
} from "../../apps/worker/src/poll-bron-run";
import {
  createBronIngestQueue,
  DURABLE_JOB_MAX_ATTEMPTS,
  offerBronIngestJob,
} from "../../apps/worker/src/poller/durable-jobs";
import type { BronIngestJob } from "../../apps/worker/src/poller/durable-jobs";

const ROLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const DATABASE_NAME_PATTERN = /^ji_restore_drill_[a-z0-9_]+$/u;

/** Policy numbers from docs/runbooks/postgres-on-box.md (backup policy). */
export const POLICY_RPO_MS = 60 * 60 * 1000;
export const POLICY_RTO_MS = 4 * 60 * 60 * 1000;

const BRON_SLUG = "opdrachtoverheid" as const;
// SAFETY: SOURCES is keyed by SupportedBronSlug and each entry's bronId is a
// registered BronId literal; the registry asserts the match.
const BRON_ID = SOURCES[BRON_SLUG].bronId as BronId;

const migrationsFolder = path.join(
  import.meta.dir,
  "../../packages/db/src/migrations"
);

export interface DrillArguments {
  readonly keepDatabases: boolean;
  readonly outputPath: string;
}

const valueFlags = new Set(["--output"]);
const booleanFlags = new Set(["--keep"]);

export const parseArguments = (
  arguments_: readonly string[]
): DrillArguments => {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    if (
      !argument ||
      (!valueFlags.has(argument) && !booleanFlags.has(argument))
    ) {
      throw new Error(`Unsupported option ${argument ?? ""}`);
    }
    if (values.has(argument) || booleans.has(argument)) {
      throw new Error(`Duplicate option ${argument}`);
    }
    if (booleanFlags.has(argument)) {
      booleans.add(argument);
      continue;
    }
    const value = normalized[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }
  return {
    keepDatabases: booleans.has("--keep"),
    outputPath:
      values.get("--output") ?? ".artifacts/restore-drill-receipt.json",
  };
};

interface DrillCredentials {
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly appUser: string;
  readonly appPassword: string;
  readonly hostPort: number;
  readonly migratorUser: string;
  readonly migratorPassword: string;
}

const credentials = (): DrillCredentials => ({
  adminPassword: process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local",
  adminUser: process.env.POSTGRES_ADMIN_USER ?? "ji_admin",
  appPassword: process.env.POSTGRES_APP_PASSWORD ?? "ji_app_local",
  appUser: process.env.POSTGRES_APP_USER ?? "ji_app",
  hostPort: Number(process.env.POSTGRES_HOST_PORT ?? "5432"),
  migratorPassword:
    process.env.POSTGRES_MIGRATOR_PASSWORD ?? "ji_migrator_local",
  migratorUser: process.env.POSTGRES_MIGRATOR_USER ?? "ji_migrator",
});

const databaseUrl = (
  creds: DrillCredentials,
  role: "admin" | "migrator" | "app",
  database: string
): string => {
  const url = new URL(`postgresql://127.0.0.1:${creds.hostPort}/${database}`);
  const roleCredentials = {
    admin: { password: creds.adminPassword, user: creds.adminUser },
    app: { password: creds.appPassword, user: creds.appUser },
    migrator: { password: creds.migratorPassword, user: creds.migratorUser },
  }[role];
  url.username = encodeURIComponent(roleCredentials.user);
  url.password = encodeURIComponent(roleCredentials.password);
  return url.toString();
};

const requireDatabaseName = (name: string): void => {
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(`'${name}' is not a valid restore-drill database name`);
  }
};

const requireRoleName = (name: string): void => {
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new Error(`'${name}' is not a valid role name`);
  }
};

/** Same least-privilege grants as tools/postgres/test-isolation.ts. */
const grantDatabaseRoles = async (
  admin: postgres.Sql,
  databaseName: string,
  creds: DrillCredentials
): Promise<void> => {
  requireRoleName(creds.migratorUser);
  requireRoleName(creds.appUser);
  requireDatabaseName(databaseName);
  await admin.unsafe(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`);
  await admin.unsafe(
    `GRANT CONNECT, CREATE ON DATABASE "${databaseName}" TO "${creds.migratorUser}"`
  );
  await admin.unsafe(
    `GRANT CONNECT ON DATABASE "${databaseName}" TO "${creds.appUser}"`
  );
};

const grantSchemaRoles = async (
  sql: postgres.Sql,
  creds: DrillCredentials
): Promise<void> => {
  await sql.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  await sql.unsafe(
    `GRANT USAGE, CREATE ON SCHEMA public TO "${creds.migratorUser}"`
  );
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${creds.appUser}"`);
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${creds.migratorUser}" GRANT USAGE ON SCHEMAS TO "${creds.appUser}"`
  );
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${creds.migratorUser}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${creds.appUser}"`
  );
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${creds.migratorUser}" GRANT USAGE, SELECT ON SEQUENCES TO "${creds.appUser}"`
  );
};

const provisionMigratedDatabase = async (
  admin: postgres.Sql,
  creds: DrillCredentials,
  databaseName: string
): Promise<void> => {
  requireDatabaseName(databaseName);
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await grantDatabaseRoles(admin, databaseName, creds);
  const adminOnDb = postgres(databaseUrl(creds, "admin", databaseName), {
    max: 1,
  });
  try {
    await grantSchemaRoles(adminOnDb, creds);
  } finally {
    await adminOnDb.end({ timeout: 3 });
  }
  const migrator = postgres(databaseUrl(creds, "migrator", databaseName), {
    max: 1,
  });
  try {
    await migrate(drizzle(migrator), { migrationsFolder });
  } finally {
    await migrator.end({ timeout: 3 });
  }
};

const dropDatabase = async (
  admin: postgres.Sql,
  databaseName: string
): Promise<void> => {
  requireDatabaseName(databaseName);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
};

/* ------------------------------------------------------------------ */
/* Fixture connector: deterministic two-page listing, no egress.       */
/* ------------------------------------------------------------------ */

export interface FixtureListingItem {
  readonly bronReferentie: string;
  readonly title: string;
}

interface PreparedFixtureItem extends FixtureListingItem {
  readonly body: Uint8Array;
  readonly contentHash: string;
}

/**
 * A source-shaped connector over an in-memory listing. `discover` pages by
 * `checkpoint.page`; `failDiscoverOnPage` throws while `failureBudget` has
 * attempts left, which is how the drill lands a failed run with a persisted
 * checkpoint instead of scripting the scrape_run row by hand.
 */
export const createFixtureConnector = async (input: {
  readonly bronId: BronId;
  readonly failureBudget?: { remaining: number };
  readonly failDiscoverOnPage?: number;
  readonly pages: readonly (readonly FixtureListingItem[])[];
}): Promise<Connector> => {
  const prepared = new Map<string, PreparedFixtureItem>();
  for (const page of input.pages) {
    for (const item of page) {
      if (prepared.has(item.bronReferentie)) {
        continue;
      }
      const body = new TextEncoder().encode(
        JSON.stringify({
          jobPosting: null,
          tender: {
            opdracht_overheid_url: `https://fixture.invalid/ctp-632/${item.bronReferentie}`,
            tender_buying_organization: "Synthetic Restore Drill Organisation",
            tender_id: item.bronReferentie,
            tender_name: item.title,
            web_key: item.bronReferentie,
          },
        })
      );
      // oxlint-disable-next-line no-await-in-loop -- hashing a handful of fixture items; sequential keeps the code obvious
      const contentHash = await hashContent(body);
      prepared.set(item.bronReferentie, {
        ...item,
        body,
        contentHash,
      });
    }
  }
  return {
    bronId: input.bronId,
    discover: (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const page = checkpoint?.page ?? 0;
      const budget = input.failureBudget;
      if (
        input.failDiscoverOnPage === page &&
        budget !== undefined &&
        budget.remaining > 0
      ) {
        budget.remaining -= 1;
        return Promise.reject(
          new Error(`fixture discover failure on page ${page}`)
        );
      }
      const items: DiscoverItem[] = (input.pages[page] ?? []).map((item) => {
        const preparedItem = prepared.get(item.bronReferentie);
        if (!preparedItem) {
          throw new Error(`unprepared fixture item ${item.bronReferentie}`);
        }
        return {
          bronReferentie: preparedItem.bronReferentie,
          contentHash: preparedItem.contentHash,
        };
      });
      const nextPage = page + 1;
      return Promise.resolve({
        checkpoint: { page: nextPage },
        hasMore: nextPage < input.pages.length,
        items,
      });
    },
    fetch: (item: DiscoverItem): Promise<ConnectorFetchResult | null> => {
      const preparedItem = prepared.get(item.bronReferentie);
      if (!preparedItem) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        body: preparedItem.body,
        bronReferentie: preparedItem.bronReferentie,
        contentHash: preparedItem.contentHash,
        contentType: "json",
        status: "fetched",
      });
    },
    fetchUsesNetwork: false,
  };
};

/* ------------------------------------------------------------------ */
/* pg_dump / psql runners                                             */
/* ------------------------------------------------------------------ */

export type DumpRunner =
  | { readonly kind: "host"; readonly binary: string }
  | { readonly container: string; readonly kind: "docker" };

export interface CommandInvocation {
  readonly command: readonly string[];
  readonly env?: Record<string, string>;
}

const commandEnvironment = (adminPassword: string) =>
  ({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    PGPASSWORD: adminPassword,
  }) satisfies Record<string, string>;

/** Bun 1.3.x may yield a bare ArrayBuffer from Response/File `.bytes()`. */
export const asCommandBytes = (bytes: ArrayBuffer | Uint8Array): Uint8Array =>
  bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

const runCommand = async (
  command: readonly string[],
  options: { env?: Record<string, string>; stdin?: Uint8Array } = {}
): Promise<{ exitCode: number; stderr: string; stdout: Uint8Array }> => {
  const child = Bun.spawn([...command], {
    env: options.env,
    stderr: "pipe",
    stdin: options.stdin,
    stdout: "pipe",
  });
  const [stdoutRaw, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout: asCommandBytes(stdoutRaw) };
};

const publishesHostPort = (
  ports: string | undefined,
  hostPort: number
): boolean =>
  (ports ?? "")
    .split(",")
    .some(
      (mapping) =>
        mapping.split("->")[0]?.trim().split(":").pop() === String(hostPort)
    );

/** Probes whether `container`'s Postgres authenticates the drill admin role. */
const containerAcceptsAdmin = async (
  container: string,
  creds: DrillCredentials
): Promise<boolean> => {
  const probe = await runCommand([
    "docker",
    "exec",
    "-e",
    `PGPASSWORD=${creds.adminPassword}`,
    container,
    "psql",
    "-h",
    "127.0.0.1",
    "-p",
    "5432",
    "-U",
    creds.adminUser,
    "-d",
    "postgres",
    "-tAc",
    "SELECT 1",
  ]);
  return (
    probe.exitCode === 0 &&
    new TextDecoder().decode(probe.stdout).trim() === "1"
  );
};

const dockerPostgresContainer = async (
  creds: DrillCredentials
): Promise<string | null> => {
  const override = process.env.RESTORE_DRILL_PG_CONTAINER?.trim();
  if (override) {
    return override;
  }
  if (!Bun.which("docker")) {
    return null;
  }
  const listing = await runCommand([
    "docker",
    "ps",
    "--format",
    "{{.Names}}\t{{.Ports}}",
  ]);
  if (listing.exitCode !== 0) {
    return null;
  }
  const text = new TextDecoder().decode(listing.stdout);
  for (const line of text.split("\n")) {
    const [name, ports] = line.split("\t");
    // The drill talks to whatever container publishes the host port the
    // credentials target; `55432->5432` is a different instance and must
    // not be picked. A container that publishes the port but does not
    // authenticate the drill role is another project's database — skip it
    // rather than dumping a stranger's schema.
    if (!(name && publishesHostPort(ports, creds.hostPort))) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- container probes are sequential and there is at most a handful
    if (await containerAcceptsAdmin(name, creds)) {
      return name;
    }
  }
  return null;
};

export const resolveDumpRunner = async (
  creds: DrillCredentials
): Promise<DumpRunner | null> => {
  const hostBinary = Bun.which("pg_dump");
  if (hostBinary) {
    return { binary: hostBinary, kind: "host" };
  }
  const container = await dockerPostgresContainer(creds);
  return container ? { container, kind: "docker" } : null;
};

export const buildHostDumpInvocation = (
  runner: Extract<DumpRunner, { kind: "host" }>,
  creds: DrillCredentials,
  databaseName: string
): CommandInvocation => ({
  command: [
    runner.binary,
    "-h",
    "127.0.0.1",
    "-p",
    String(creds.hostPort),
    "-U",
    creds.adminUser,
    "-d",
    databaseName,
    "--format=plain",
  ],
  env: commandEnvironment(creds.adminPassword),
});

export const buildHostRestoreInvocation = (
  runner: Extract<DumpRunner, { kind: "host" }>,
  creds: DrillCredentials,
  databaseName: string
): CommandInvocation => ({
  command: [
    runner.binary.replace(/pg_dump$/u, "psql"),
    "-h",
    "127.0.0.1",
    "-p",
    String(creds.hostPort),
    "-U",
    creds.adminUser,
    "-d",
    databaseName,
    "-v",
    "ON_ERROR_STOP=1",
    "--single-transaction",
  ],
  env: commandEnvironment(creds.adminPassword),
});

interface DumpResult {
  readonly bytes: number;
  readonly exitCode: number;
  readonly method: string;
  readonly path: string;
  readonly sha256: string;
}

const pgDump = async (
  runner: DumpRunner,
  creds: DrillCredentials,
  databaseName: string,
  directory: string
): Promise<DumpResult> => {
  // Inside `docker exec` the target is the container's own Postgres on its
  // internal 5432; the published host port only exists on the host.
  const port = runner.kind === "docker" ? "5432" : String(creds.hostPort);
  const args = [
    "-h",
    "127.0.0.1",
    "-p",
    port,
    "-U",
    creds.adminUser,
    "-d",
    databaseName,
    "--format=plain",
  ];
  const command =
    runner.kind === "host"
      ? buildHostDumpInvocation(runner, creds, databaseName).command
      : [
          "docker",
          "exec",
          "-e",
          `PGPASSWORD=${creds.adminPassword}`,
          runner.container,
          "pg_dump",
          ...args,
        ];
  const result = await runCommand(
    command,
    runner.kind === "host"
      ? { env: buildHostDumpInvocation(runner, creds, databaseName).env }
      : {}
  );
  if (result.exitCode !== 0 || result.stdout.byteLength === 0) {
    throw new Error(
      `pg_dump failed (exit ${result.exitCode}): ${result.stderr.trim()}`
    );
  }
  const dumpPath = path.join(directory, `${databaseName}.dump.sql`);
  writeFileSync(dumpPath, result.stdout);
  return {
    bytes: result.stdout.byteLength,
    exitCode: result.exitCode,
    method:
      runner.kind === "host"
        ? `pg_dump (${runner.binary})`
        : `pg_dump via docker exec ${runner.container}`,
    path: dumpPath,
    sha256: createHash("sha256").update(result.stdout).digest("hex"),
  };
};

const psqlRestore = async (
  runner: DumpRunner,
  creds: DrillCredentials,
  databaseName: string,
  dumpPath: string
): Promise<{ exitCode: number; stderr: string }> => {
  const dump = asCommandBytes(await Bun.file(dumpPath).bytes());
  const port = runner.kind === "docker" ? "5432" : String(creds.hostPort);
  const args = [
    "-h",
    "127.0.0.1",
    "-p",
    port,
    "-U",
    creds.adminUser,
    "-d",
    databaseName,
    "-v",
    "ON_ERROR_STOP=1",
    "--single-transaction",
  ];
  const command =
    runner.kind === "host"
      ? buildHostRestoreInvocation(runner, creds, databaseName).command
      : [
          "docker",
          "exec",
          "-i",
          "-e",
          `PGPASSWORD=${creds.adminPassword}`,
          runner.container,
          "psql",
          ...args,
        ];
  const result = await runCommand(
    command,
    runner.kind === "host"
      ? {
          env: buildHostRestoreInvocation(runner, creds, databaseName).env,
          stdin: dump,
        }
      : { stdin: dump }
  );
  return { exitCode: result.exitCode, stderr: result.stderr };
};

/* ------------------------------------------------------------------ */
/* Chain state snapshot                                                */
/* ------------------------------------------------------------------ */

interface ScrapeRunRow {
  readonly checkpoint: unknown;
  readonly fenceToken: number;
  readonly id: string;
  readonly runKind: string;
  readonly status: string;
}

interface DurableJobRow {
  readonly attempts: number;
  readonly completed: boolean;
  readonly id: string;
  readonly lastFailure: string | null;
}

export interface ChainState {
  readonly aanvraagReferenties: readonly string[];
  readonly counts: {
    readonly aanvraag: number;
    readonly durableJob: number;
    readonly migrationJournal: number;
    readonly observation: number;
    readonly outboxEvent: number;
    readonly scrapeRun: number;
    readonly sourceRecord: number;
  };
  readonly durableJobs: readonly DurableJobRow[];
  readonly observationsByStatus: Readonly<Record<string, number>>;
  readonly outboxUnprocessed: number;
  readonly scrapeRuns: readonly ScrapeRunRow[];
  readonly sourceRecordReferenties: readonly string[];
}

const collectState = async (sql: postgres.Sql): Promise<ChainState> => {
  const scrapeRuns = await sql<ScrapeRunRow[]>`
    SELECT id::text AS "id", status, run_kind AS "runKind",
           fence_token::int AS "fenceToken", checkpoint
    FROM curated.scrape_run
    ORDER BY gestart ASC, id ASC
  `;
  const sourceRows = await sql<{ bronReferentie: string }[]>`
    SELECT bron_referentie AS "bronReferentie"
    FROM staging.source_record
    ORDER BY bron_referentie ASC
  `;
  const observationRows = await sql<{ count: number; status: string }[]>`
    SELECT status, count(*)::int AS count
    FROM staging.aanvraag_observation
    GROUP BY status
    ORDER BY status ASC
  `;
  const aanvraagRows = await sql<{ bronReferentie: string }[]>`
    SELECT bron_referentie AS "bronReferentie"
    FROM curated.aanvraag
    ORDER BY bron_referentie ASC
  `;
  const durableJobs = await sql<DurableJobRow[]>`
    SELECT id, completed, attempts, last_failure AS "lastFailure"
    FROM curated.durable_job
    ORDER BY sequence ASC
  `;
  const [journal] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
  `;
  const [outbox] = await sql<{ total: number; unprocessed: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed
    FROM curated.outbox_event
  `;
  return {
    aanvraagReferenties: aanvraagRows.map((row) => row.bronReferentie),
    counts: {
      aanvraag: aanvraagRows.length,
      durableJob: durableJobs.length,
      migrationJournal: journal?.count ?? 0,
      observation: Object.values(
        Object.fromEntries(
          observationRows.map((row) => [row.status, row.count])
        )
      ).reduce((total, value) => total + value, 0),
      outboxEvent: outbox?.total ?? 0,
      scrapeRun: scrapeRuns.length,
      sourceRecord: sourceRows.length,
    },
    durableJobs,
    observationsByStatus: Object.fromEntries(
      observationRows.map((row) => [row.status, row.count])
    ),
    outboxUnprocessed: outbox?.unprocessed ?? 0,
    scrapeRuns,
    sourceRecordReferenties: sourceRows.map((row) => row.bronReferentie),
  };
};

/* ------------------------------------------------------------------ */
/* Drill                                                               */
/* ------------------------------------------------------------------ */

type VerificationStatus = "failed" | "unknown" | "verified";

interface Verification {
  readonly detail: string;
  readonly name: string;
  readonly status: VerificationStatus;
}

interface StepRecord {
  readonly detail?: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly name: string;
  readonly status: "failed" | "ok";
}

/** Mutable slot a step fills while running; folded into its StepRecord. */
interface StepReport {
  exitCode?: number;
}

export interface DrillReceipt {
  readonly backup: {
    readonly bytes: number;
    readonly completedAt: string;
    readonly durationMs: number;
    readonly method: string;
    readonly sha256: string;
  } | null;
  /** null per database when `--keep` retained it or cleanup never ran. */
  readonly cleanup: {
    readonly sourceDropped: boolean | null;
    readonly targetDropped: boolean | null;
  };
  readonly counts: {
    readonly atBackup: ChainState | null;
    readonly reconstructed: ChainState | null;
    readonly restored: ChainState | null;
    readonly sourceBeforeLoss: ChainState | null;
  };
  readonly databases: {
    readonly retained: boolean;
    readonly source: string;
    readonly target: string;
  };
  readonly environment: string;
  readonly generatedAt: string;
  readonly gitSha: string;
  readonly lostWrites: readonly string[];
  readonly objectStore: string;
  readonly result: "fail" | "pass";
  readonly rpo: {
    readonly backupCompletedAt: string | null;
    readonly exposureWindowMs: number | null;
    readonly lossAt: string | null;
    readonly policyTargetMs: number;
    readonly withinPolicy: boolean | null;
  };
  readonly rto: {
    readonly consistentAt: string | null;
    readonly lossAt: string | null;
    readonly measuredMs: number | null;
    readonly policyTargetMs: number;
    readonly withinPolicy: boolean | null;
  };
  readonly schemaVersion: 1;
  readonly searchProjection: {
    readonly detail: string;
    readonly status: VerificationStatus;
  };
  readonly steps: readonly StepRecord[];
  readonly verifications: readonly Verification[];
}

export class DrillStepError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(
      `${step}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "DrillStepError";
    this.step = step;
  }
}

interface DrillContext {
  readonly objectStore: InMemoryObjectStore;
  readonly out: {
    backup: DrillReceipt["backup"];
    cleanup: { sourceDropped: boolean | null; targetDropped: boolean | null };
    counts: {
      atBackup: ChainState | null;
      reconstructed: ChainState | null;
      restored: ChainState | null;
      sourceBeforeLoss: ChainState | null;
    };
    lostWrites: string[];
    rpo: { backupCompletedAt: string | null; lossAt: string | null };
    rto: { consistentAt: string | null; lossAt: string | null };
    searchProjection: DrillReceipt["searchProjection"];
    steps: StepRecord[];
    verifications: Verification[];
  };
}

/** Records a check outcome; a `failed` status aborts the drill. */
const verify = (
  context: DrillContext,
  name: string,
  detail: string,
  status: VerificationStatus = "verified"
): void => {
  context.out.verifications.push({ detail, name, status });
  if (status === "failed") {
    throw new DrillStepError(name, new Error(detail));
  }
};

const buildRuntime = (
  appUrl: string,
  objectStore: ObjectStore,
  connector: Connector
): PollBronRuntime => {
  const client = createBronRuntimeClient(appUrl);
  return {
    alerts: new PostgresAlertStore(client.database),
    bronHealth: new PostgresBronHealthStore(client.database),
    bronPersistence: client.bronPersistence,
    close: client.close,
    createConnector: () => connector,
    curateStore: new PostgresCurateStore(client.database),
    database: client.database,
    knownHashStore: client.knownHashStore,
    lifecycle: client.lifecycle,
    // A disposable drill database has no poll history; an empty baseline is
    // honest ("no history"), where a skipped load would read as "unreadable".
    loadBaseline: () => Promise.resolve([]),
    objectStore,
    observationRecorder: client.observationRecorder,
    runLifecycleStore: client.runLifecycleStore,
    withSourceHealthTransaction: (runOperation) =>
      client.database.transaction((transaction) =>
        runOperation({
          alerts: new PostgresAlertStore(transaction),
          bronHealth: new PostgresBronHealthStore(transaction),
          database: transaction,
        })
      ),
  };
};

/**
 * One queue take = one real claim → process → ack/release cycle, the same
 * call `runDurableBronJobConsumer` loops over in the worker. The drill calls
 * it per attempt so each attempt's outcome lands exactly where the receipt
 * expects it.
 */
type DrillQueue = Awaited<ReturnType<typeof createBronIngestQueue>>;

const takeOnce = async (
  queue: DrillQueue,
  processJob: (job: BronIngestJob) => Promise<BronIngestPipelineResult>
): Promise<BronIngestPipelineResult> =>
  await runWorkerPromise(
    queue.queue
      .take((job) => fromWorkerPromise(() => processJob(job)), {
        maxAttempts: DURABLE_JOB_MAX_ATTEMPTS,
      })
      .pipe(Effect.mapError(mapUnknownToWorkerFault))
  );

// Parameter-position nullable arguments avoid the never-narrowing TS applies
// to a `let` whose only straight-line assignment is `null` while the real
// assignment happened inside an async callback.
const closeRuntime = async (runtime: PollBronRuntime | null): Promise<void> => {
  await runtime?.close();
};

const closeQueue = async (queue: DrillQueue | null): Promise<void> => {
  await queue?.close();
};

const stateEquals = (
  left: ChainState,
  right: ChainState
): readonly string[] => {
  const differences: string[] = [];
  const leftJson = JSON.stringify({
    aanvraagReferenties: left.aanvraagReferenties,
    counts: left.counts,
    durableJobs: left.durableJobs,
    observationsByStatus: left.observationsByStatus,
    outboxUnprocessed: left.outboxUnprocessed,
    scrapeRuns: left.scrapeRuns,
    sourceRecordReferenties: left.sourceRecordReferenties,
  });
  const rightJson = JSON.stringify({
    aanvraagReferenties: right.aanvraagReferenties,
    counts: right.counts,
    durableJobs: right.durableJobs,
    observationsByStatus: right.observationsByStatus,
    outboxUnprocessed: right.outboxUnprocessed,
    scrapeRuns: right.scrapeRuns,
    sourceRecordReferenties: right.sourceRecordReferenties,
  });
  if (leftJson !== rightJson) {
    differences.push(`${leftJson} !== ${rightJson}`);
  }
  return differences;
};

interface DrillBodyResult {
  readonly exposureWindowMs: number | null;
  readonly rtoMs: number | null;
}

const runDrillBody = async (
  arguments_: DrillArguments,
  names: { sourceName: string; targetName: string },
  context: DrillContext
): Promise<DrillBodyResult> => {
  const creds = credentials();
  const { sourceName, targetName } = names;
  const workDir = mkdtempSync(path.join(os.tmpdir(), "ji-restore-drill-"));
  const admin = postgres(databaseUrl(creds, "admin", "postgres"), {
    connect_timeout: 5,
    max: 1,
  });

  const step = async <T>(
    name: string,
    operation: (record: StepReport) => Promise<T>
  ): Promise<T> => {
    const started = performance.now();
    const record: StepReport = {};
    try {
      const value = await operation(record);
      context.out.steps.push({
        durationMs: Math.round(performance.now() - started),
        exitCode: record.exitCode,
        name,
        status: "ok",
      });
      return value;
    } catch (error) {
      context.out.steps.push({
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - started),
        exitCode: record.exitCode,
        name,
        status: "failed",
      });
      throw error instanceof DrillStepError
        ? error
        : new DrillStepError(name, error);
    }
  };

  let sourceRuntime: PollBronRuntime | null = null;
  let sourceQueue: DrillQueue | null = null;
  let targetRuntime: PollBronRuntime | null = null;
  let targetQueue: DrillQueue | null = null;

  try {
    const { runBronIngestPipeline } = await step("load_pipeline", async () => {
      // @ji/db's index binds DATABASE_URL at module load; the drill never
      // uses that process-global client, so point it at a valid URL and
      // defer the import until it exists.
      process.env.DATABASE_URL ??= databaseUrl(creds, "app", "postgres");
      // Production runs the worker in onbox mode: the outbox commit is the
      // recoverable boundary and a separate projector drains it.
      process.env.SEARCH_PROJECTOR = "onbox";
      return await import("../../apps/worker/src/poll-bron-run");
    });

    const runner = await step("resolve_dump_tool", async () => {
      const resolved = await resolveDumpRunner(creds);
      if (!resolved) {
        throw new Error(
          "no pg_dump on PATH and no Postgres container publishing 5432; " +
            "set RESTORE_DRILL_PG_CONTAINER or install pg_dump"
        );
      }
      return resolved;
    });

    const itemA: FixtureListingItem = {
      bronReferentie: "ctp-632-a",
      title: "Synthetic Restore Drill Aanvraag A",
    };
    const itemB: FixtureListingItem = {
      bronReferentie: "ctp-632-b",
      title: "Synthetic Restore Drill Aanvraag B",
    };
    // Run 1 sees [A]. Run 2 sees [B] then a second page that fails —
    // runConnector retries discover under the default retry policy, so the
    // budget must outlast the in-run retries to leave the run `failed` with
    // a persisted checkpoint. Clearing it models the transient fault
    // recovering before the post-backup retake.
    const failureBudget = { remaining: 8 };
    const connectorRun1 = await createFixtureConnector({
      bronId: BRON_ID,
      pages: [[itemA]],
    });
    const connectorRun2 = await createFixtureConnector({
      bronId: BRON_ID,
      failDiscoverOnPage: 1,
      failureBudget,
      pages: [[itemB], []],
    });
    const connectorRun4 = await createFixtureConnector({
      bronId: BRON_ID,
      pages: [[itemA, itemB]],
    });
    const appUrlFor = (db: string): string => databaseUrl(creds, "app", db);
    const processJob =
      (
        runtime: () => PollBronRuntime | null
      ): ((job: BronIngestJob) => Promise<BronIngestPipelineResult>) =>
      async (job) => {
        const active = runtime();
        if (!active) {
          throw new Error("drill runtime closed");
        }
        return await runBronIngestPipeline(
          {
            bronId: job.bronId,
            // SAFETY: the drill only ever offers jobs with the fixture bron
            // slug; the schema decode in `take` preserves the offered value.
            bronSlug: job.bronSlug as typeof BRON_SLUG,
            scrapeRunId: job.scrapeRunId,
          },
          active,
          "poll"
        );
      };

    // SAFETY: crypto.randomUUID() emits RFC 4122 uuids, the ScrapeRunId
    // shape; every statement below uses a fresh drill-owned run id.
    const scrapeRun1 = crypto.randomUUID() as ScrapeRunId;
    // SAFETY: same randomUUID → ScrapeRunId narrowing as above.
    const scrapeRun2 = crypto.randomUUID() as ScrapeRunId;
    // SAFETY: same randomUUID → ScrapeRunId narrowing as above.
    const scrapeRun4 = crypto.randomUUID() as ScrapeRunId;

    await step("provision_source", () =>
      provisionMigratedDatabase(admin, creds, sourceName)
    );

    await step("seed_bron_and_run1", async () => {
      const appSql = postgres(appUrlFor(sourceName), { max: 2 });
      try {
        const db = drizzle(appSql);
        await db.insert(bron).values({
          actief: true,
          categorie: "aggregator",
          crawlDelayMs: 0,
          id: BRON_ID,
          ingestieType: "json-api",
          interval: "*/15 * * * *",
          naam: "Opdrachtoverheid restore drill fixture",
          rateLimitPerMinute: 600,
          retentionDays: 30,
          status: "ready",
          voorwaardenStatus: "toegestaan",
        });
      } finally {
        await appSql.end({ timeout: 3 });
      }
      sourceRuntime = buildRuntime(
        appUrlFor(sourceName),
        context.objectStore,
        connectorRun1
      );
      sourceQueue = await createBronIngestQueue(appUrlFor(sourceName), {
        lockExpiration: "1 seconds",
        lockRefreshInterval: "50 millis",
        pollInterval: "20 millis",
      });
      const job1: BronIngestJob = {
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        scrapeRunId: scrapeRun1,
      };
      await offerBronIngestJob(sourceQueue.queue, job1);
      await takeOnce(
        sourceQueue,
        processJob(() => sourceRuntime)
      );
    });

    await step("verify_run1", async () => {
      const sql = postgres(appUrlFor(sourceName), { max: 1 });
      try {
        const state = await collectState(sql);
        const [run] = state.scrapeRuns;
        if (run?.status !== "succeeded") {
          throw new Error(`run1 status=${run?.status ?? "missing"}`);
        }
        if (state.aanvraagReferenties.join(",") !== itemA.bronReferentie) {
          throw new Error(
            `expected aanvraag for ${itemA.bronReferentie}, got ${state.aanvraagReferenties}`
          );
        }
        if (state.counts.outboxEvent < 1) {
          throw new Error("no outbox event committed for run1");
        }
        return state;
      } finally {
        await sql.end({ timeout: 3 });
      }
    });

    await step("run2_attempt1_fails", async () => {
      if (!sourceRuntime || !sourceQueue) {
        throw new Error("source runtime unavailable");
      }
      const job2: BronIngestJob = {
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        scrapeRunId: scrapeRun2,
      };
      await offerBronIngestJob(sourceQueue.queue, job2);
      sourceRuntime.createConnector = () => connectorRun2;
      let thrown: unknown;
      try {
        await takeOnce(
          sourceQueue,
          processJob(() => sourceRuntime)
        );
      } catch (error) {
        thrown = error;
      }
      if (!thrown) {
        throw new Error("run2 attempt 1 unexpectedly succeeded");
      }
      // The transient upstream fault clears: the retake must succeed on the
      // persisted checkpoint rather than another scripted failure.
      failureBudget.remaining = 0;
    });

    const stateAtBackup = await step("snapshot_at_backup", async () => {
      const sql = postgres(appUrlFor(sourceName), { max: 1 });
      try {
        const state = await collectState(sql);
        const run2 = state.scrapeRuns.find((row) => row.id === scrapeRun2);
        const job2 = state.durableJobs.find((row) => row.id === scrapeRun2);
        if (run2?.status !== "failed") {
          throw new Error(`run2 status=${run2?.status ?? "missing"}`);
        }
        if (run2.checkpoint === null) {
          throw new Error("run2 has no persisted checkpoint");
        }
        if (job2?.completed !== false || job2.attempts !== 1) {
          throw new Error(
            `job2 expected open with attempts=1, got ${JSON.stringify(job2)}`
          );
        }
        return state;
      } finally {
        await sql.end({ timeout: 3 });
      }
    });
    context.out.counts.atBackup = stateAtBackup;

    const backup = await step("backup_pg_dump", async (record) => {
      const result = await pgDump(runner, creds, sourceName, workDir);
      record.exitCode = result.exitCode;
      return {
        bytes: result.bytes,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        method: result.method,
        sha256: result.sha256,
      };
    });
    context.out.backup = backup;
    context.out.rpo.backupCompletedAt = backup.completedAt;

    // The committed work between backup and loss: this is the window the
    // restore cannot contain and replay has to reproduce.
    await step("post_backup_commit", async () => {
      if (!sourceQueue) {
        throw new Error("source queue unavailable");
      }
      await takeOnce(
        sourceQueue,
        processJob(() => sourceRuntime)
      );
    });

    const stateBeforeLoss = await step("snapshot_before_loss", async () => {
      const sql = postgres(appUrlFor(sourceName), { max: 1 });
      try {
        const state = await collectState(sql);
        const run2 = state.scrapeRuns.find((row) => row.id === scrapeRun2);
        if (run2?.status !== "succeeded") {
          throw new Error(`run2 expected succeeded, got ${run2?.status}`);
        }
        return state;
      } finally {
        await sql.end({ timeout: 3 });
      }
    });
    context.out.counts.sourceBeforeLoss = stateBeforeLoss;

    // Outage: the source database is gone. Runtime/queue handles to it die
    // with the drop — close them first so the failure is the database's.
    await closeQueue(sourceQueue);
    await closeRuntime(sourceRuntime);
    sourceQueue = null;
    sourceRuntime = null;
    await step("outage_drop_source", async () => {
      await dropDatabase(admin, sourceName);
      context.out.rpo.lossAt = new Date().toISOString();
      context.out.rto.lossAt = context.out.rpo.lossAt;
    });

    await step("provision_target", async () => {
      await admin.unsafe(`CREATE DATABASE "${targetName}"`);
      await grantDatabaseRoles(admin, targetName, creds);
    });

    await step("restore_psql", async (record) => {
      if (!context.out.backup) {
        throw new Error("no backup artifact");
      }
      const dumpPath = path.join(workDir, `${sourceName}.dump.sql`);
      const result = await psqlRestore(runner, creds, targetName, dumpPath);
      record.exitCode = result.exitCode;
      if (result.exitCode !== 0) {
        throw new Error(
          `psql restore exited ${result.exitCode}: ${result.stderr.trim()}`
        );
      }
    });

    const stateRestored = await step("verify_restored", async () => {
      const sql = postgres(appUrlFor(targetName), { max: 1 });
      try {
        const state = await collectState(sql);
        const differences = stateEquals(stateAtBackup, state);
        if (differences.length > 0) {
          throw new Error(
            `restored state diverges from backup: ${differences[0]}`
          );
        }
        return state;
      } finally {
        await sql.end({ timeout: 3 });
      }
    });
    context.out.counts.restored = stateRestored;

    const lostWrites: string[] = [];
    const restoredRun2 = stateRestored.scrapeRuns.find(
      (row) => row.id === scrapeRun2
    );
    if (restoredRun2?.status === "failed") {
      lostWrites.push(
        `scrape_run ${scrapeRun2} completion (restored as 'failed')`
      );
    }
    if (!stateRestored.aanvraagReferenties.includes(itemB.bronReferentie)) {
      lostWrites.push(`curated.aanvraag for ${itemB.bronReferentie}`);
    }
    const restoredJob2 = stateRestored.durableJobs.find(
      (row) => row.id === scrapeRun2
    );
    if (restoredJob2 && restoredJob2.completed === false) {
      lostWrites.push(`durable_job ${scrapeRun2} ack (restored open)`);
    }
    context.out.lostWrites = lostWrites;

    // Reconstruct: the unfinished job survives the restore; retaking it
    // resumes the same scrape_run from its persisted checkpoint.
    await step("reconstruct_retake", async () => {
      targetRuntime = buildRuntime(
        appUrlFor(targetName),
        context.objectStore,
        connectorRun2
      );
      targetQueue = await createBronIngestQueue(appUrlFor(targetName), {
        lockExpiration: "1 seconds",
        lockRefreshInterval: "50 millis",
        pollInterval: "20 millis",
      });
      const result = await takeOnce(
        targetQueue,
        processJob(() => targetRuntime)
      );
      const resumed =
        result.completeness !== null &&
        result.completeness.complete === false &&
        result.completeness.reason === "resumed";
      if (!resumed) {
        throw new Error(
          `retake did not resume from checkpoint (completeness=${JSON.stringify(result.completeness)})`
        );
      }
      verify(
        context,
        "checkpoint_resume",
        `run ${scrapeRun2} resumed from persisted checkpoint and completed`
      );
    });

    // A fresh poll after restore: the rediscovered listing replays A and B
    // against the restored records — no new aanvragen, no duplicate rows.
    await step("post_restore_poll", async () => {
      if (!targetRuntime || !targetQueue) {
        throw new Error("target runtime unavailable");
      }
      targetRuntime.createConnector = () => connectorRun4;
      const job4: BronIngestJob = {
        bronId: BRON_ID,
        bronSlug: BRON_SLUG,
        scrapeRunId: scrapeRun4,
      };
      await offerBronIngestJob(targetQueue.queue, job4);
      await takeOnce(
        targetQueue,
        processJob(() => targetRuntime)
      );
    });

    const stateFinal = await step("verify_reconstructed", async () => {
      const sql = postgres(appUrlFor(targetName), { max: 1 });
      try {
        const state = await collectState(sql);
        const [appSql2] = [sql];
        const duplicateAanvragen = await appSql2<{ n: number }[]>`
          SELECT count(*)::int AS n FROM (
            SELECT bron_referentie FROM curated.aanvraag
            GROUP BY bron_referentie HAVING count(*) > 1
          ) d
        `;
        if ((duplicateAanvragen[0]?.n ?? 0) > 0) {
          throw new Error("duplicate curated.aanvraag rows after replay");
        }
        const duplicateRecords = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM (
            SELECT bron_referentie FROM staging.source_record
            GROUP BY bron_referentie HAVING count(*) > 1
          ) d
        `;
        if ((duplicateRecords[0]?.n ?? 0) > 0) {
          throw new Error("duplicate staging.source_record rows after replay");
        }
        const run2 = state.scrapeRuns.find((row) => row.id === scrapeRun2);
        const job2 = state.durableJobs.find((row) => row.id === scrapeRun2);
        if (run2?.status !== "succeeded" || job2?.completed !== true) {
          throw new Error(
            `run2/job2 not finished after retake: ${JSON.stringify({ job2, run2 })}`
          );
        }
        const expected = [
          itemA.bronReferentie,
          itemB.bronReferentie,
        ].toSorted();
        if (
          JSON.stringify(state.aanvraagReferenties) !== JSON.stringify(expected)
        ) {
          throw new Error(
            `expected aanvragen ${expected}, got ${state.aanvraagReferenties}`
          );
        }
        return state;
      } finally {
        await sql.end({ timeout: 3 });
      }
    });
    context.out.counts.reconstructed = stateFinal;
    context.out.rto.consistentAt = new Date().toISOString();

    verify(
      context,
      "durable_job_retake",
      `job ${scrapeRun2} restored open (attempts=1) and completed on retake (attempts=${stateFinal.durableJobs.find((row) => row.id === scrapeRun2)?.attempts})`
    );
    verify(
      context,
      "idempotent_replay",
      "no duplicate aanvraag or source_record rows; rediscovered A and B stay unchanged"
    );
    verify(
      context,
      "outbox_restored",
      `outbox restored: ${stateRestored.counts.outboxEvent} event(s), ${stateRestored.outboxUnprocessed} unprocessed; post-restore count ${stateFinal.counts.outboxEvent}`
    );
    context.out.searchProjection = {
      detail:
        "curated.outbox_event rows and the search_projection_checkpoint " +
        "table were restored and remain drainable; the on-box projector " +
        "and Manticore were not exercised — index state is honestly unknown.",
      status: "unknown",
    };
  } finally {
    await closeQueue(sourceQueue);
    await closeRuntime(sourceRuntime);
    await closeQueue(targetQueue);
    await closeRuntime(targetRuntime);
    if (!arguments_.keepDatabases) {
      // Cleanup is best-effort: a failed drop leaves one uniquely-named
      // orphan database, a cleanup task, not a correctness problem — but the
      // receipt must report whether it actually happened.
      const dropOrReport = async (name: string): Promise<boolean> =>
        await dropDatabase(admin, name)
          .then(() => true)
          .catch((cleanupError) => {
            console.error(
              `restore-drill: failed to drop '${name}': ${
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
              }`
            );
            return false;
          });
      context.out.cleanup.sourceDropped = await dropOrReport(sourceName);
      context.out.cleanup.targetDropped = await dropOrReport(targetName);
    }
    await admin.end({ timeout: 3 });
    if (!arguments_.keepDatabases) {
      rmSync(workDir, { force: true, recursive: true });
    }
  }

  const exposureWindowMs =
    context.out.rpo.backupCompletedAt && context.out.rpo.lossAt
      ? Date.parse(context.out.rpo.lossAt) -
        Date.parse(context.out.rpo.backupCompletedAt)
      : null;
  const rtoMs =
    context.out.rto.lossAt && context.out.rto.consistentAt
      ? Date.parse(context.out.rto.consistentAt) -
        Date.parse(context.out.rto.lossAt)
      : null;
  return { exposureWindowMs, rtoMs };
};

export interface DrillOutcome {
  readonly receipt: DrillReceipt;
  readonly sourceDatabase: string;
  readonly targetDatabase: string;
}

export const runDrill = async (
  arguments_: DrillArguments
): Promise<DrillOutcome> => {
  const context: DrillContext = {
    objectStore: new InMemoryObjectStore(),
    out: {
      backup: null,
      cleanup: { sourceDropped: null, targetDropped: null },
      counts: {
        atBackup: null,
        reconstructed: null,
        restored: null,
        sourceBeforeLoss: null,
      },
      lostWrites: [],
      rpo: { backupCompletedAt: null, lossAt: null },
      rto: { consistentAt: null, lossAt: null },
      searchProjection: {
        detail: "drill did not reach the projection check",
        status: "unknown",
      },
      steps: [],
      verifications: [],
    },
  };

  const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const names = {
    sourceName: `ji_restore_drill_src_${process.pid}_${runId}`,
    targetName: `ji_restore_drill_dst_${process.pid}_${runId}`,
  };
  let exposureWindowMs: number | null = null;
  let rtoMs: number | null = null;
  let failure: unknown;
  try {
    ({ exposureWindowMs, rtoMs } = await runDrillBody(
      arguments_,
      names,
      context
    ));
  } catch (error) {
    failure = error;
  }

  const receipt: DrillReceipt = {
    backup: context.out.backup,
    cleanup: context.out.cleanup,
    counts: context.out.counts,
    databases: {
      retained: arguments_.keepDatabases,
      source: names.sourceName,
      target: names.targetName,
    },
    environment: "local-dev-postgres-drill",
    generatedAt: new Date().toISOString(),
    gitSha: Bun.spawnSync(["git", "rev-parse", "HEAD"])
      .stdout.toString()
      .trim(),
    lostWrites: context.out.lostWrites,
    objectStore:
      "in-memory fixture held constant across the outage (mirrors S3 being outside the Postgres backup boundary)",
    result: failure ? "fail" : "pass",
    rpo: {
      backupCompletedAt: context.out.rpo.backupCompletedAt,
      exposureWindowMs,
      lossAt: context.out.rpo.lossAt,
      policyTargetMs: POLICY_RPO_MS,
      withinPolicy:
        exposureWindowMs === null ? null : exposureWindowMs <= POLICY_RPO_MS,
    },
    rto: {
      consistentAt: context.out.rto.consistentAt,
      lossAt: context.out.rto.lossAt,
      measuredMs: rtoMs,
      policyTargetMs: POLICY_RTO_MS,
      withinPolicy: rtoMs === null ? null : rtoMs <= POLICY_RTO_MS,
    },
    schemaVersion: 1,
    searchProjection: context.out.searchProjection,
    steps: context.out.steps,
    verifications: context.out.verifications,
  };

  const outputPath = path.resolve(arguments_.outputPath);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);

  return {
    receipt,
    sourceDatabase: names.sourceName,
    targetDatabase: names.targetName,
  };
};

const printSummary = (outcome: DrillOutcome): void => {
  const { receipt } = outcome;
  console.log("restore-drill receipt:");
  console.log(`  result:            ${receipt.result}`);
  console.log(
    `  RPO exposure:      ${receipt.rpo.exposureWindowMs ?? "n/a"} ms (policy <= ${POLICY_RPO_MS} ms)`
  );
  console.log(
    `  RTO measured:      ${receipt.rto.measuredMs ?? "n/a"} ms (policy <= ${POLICY_RTO_MS} ms)`
  );
  console.log(
    `  lost writes:       ${receipt.lostWrites.join("; ") || "none"}`
  );
  for (const stepRecord of receipt.steps) {
    console.log(
      `  step ${stepRecord.name}: ${stepRecord.status} (${stepRecord.durationMs} ms)`
    );
  }
  for (const verification of receipt.verifications) {
    console.log(`  verify ${verification.name}: ${verification.status}`);
  }
  console.log(`  search projection: ${receipt.searchProjection.status}`);
};

const main = async (): Promise<void> => {
  const arguments_ = parseArguments(Bun.argv.slice(2));
  const outcome = await runDrill(arguments_);
  printSummary(outcome);
  if (outcome.receipt.result === "fail") {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        reason: error instanceof Error ? error.message : "command_failed",
        status: "error",
      })
    );
    process.exitCode = 1;
  }
}
