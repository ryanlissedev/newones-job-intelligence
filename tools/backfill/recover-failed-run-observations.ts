/**
 * Scoped recovery of observations left behind by a failed or cancelled run
 * (CTP-625).
 *
 * `curateScrapeRun` only ever curates observations whose run `succeeded`. A
 * connector that records forty valid observations and then dies on page three
 * leaves all forty invisible: valid raw in the object store, valid payload in
 * `staging.aanvraag_observation`, and no path into `curated.aanvraag`. This
 * tool runs the ordinary curation pass over exactly one such run, so identity
 * ordering, dominated-duplicate handling, cleared fields and the
 * `curation_failed` parking rules are the runtime's, not a second copy.
 *
 * Eligibility, decided per run before any row is read:
 *
 * - `cancelled` runs are eligible. Cancellation is an operator or scheduler
 *   decision about the crawl, never a statement about the rows it recorded.
 * - `failed` runs are eligible when the failure is run-level: `fouten = 0`, or
 *   the failure code is one of `RUN_LEVEL_FAILURE_CODES` (discovery,
 *   checkpoint, completion, unexpected, legacy). A run that failed with
 *   per-record errors (`fouten > 0` under `FETCH_FAILED`,
 *   `RAW_STORE_WRITE_FAILED` or `OBSERVATION_WRITE_FAILED`) is ineligible:
 *   nothing here can tell which of its rows were the broken ones.
 * - `succeeded` and `running` runs are ineligible; the poll path owns them.
 *
 * The run's own status, counts and completeness are never touched. A
 * recovered run stays `failed`; lifecycle reconciliation keeps reading it as
 * incomplete, so recovery can never manufacture a disappearance.
 *
 * Report mode (default) is read-only and prints, per observation status, how
 * many rows the pass would consider, how many carry a payload that fails the
 * contract check, and how many of the first `--limit` candidates have no raw
 * object. `--apply` (which requires `--ingest-quiesced`) runs one bounded
 * pass. The observation status marker is the resume cursor: a row that
 * curated, superseded or parked leaves the recoverable set, so rerunning with
 * the same flags continues where the previous pass stopped and a run with
 * nothing left reports `curated: 0`. Infrastructure errors (object store
 * unreachable, transient Postgres) abort the pass with exit 1 and leave every
 * row in its previous status, exactly as the runtime does.
 *
 * Usage:
 *   DATABASE_URL=... bun tools/backfill/recover-failed-run-observations.ts --run <scrapeRunId>
 *   DATABASE_URL=... bun tools/backfill/recover-failed-run-observations.ts --run <scrapeRunId> --apply --ingest-quiesced --limit 100
 */
import { SOURCES } from "@ji/application/sources";
import type { SupportedBronSlug } from "@ji/application/sources";
import type { ObjectStore } from "@ji/connectors";
import { createRawObjectStore } from "@ji/connectors/s3-object-client";
import {
  curateScrapeRun,
  isValidCandidatePayload,
  RECOVERABLE_STATUSES,
} from "@ji/db/curate-scrape-run";
import type {
  CurateScrapeRunResult,
  EligibleRunStatus,
} from "@ji/db/curate-scrape-run";
import * as schema from "@ji/db/schema/index";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LIMIT = 100;
/** Matches `curateScrapeRun`'s `attemptLimit` ceiling. */
const MAX_LIMIT = 500;

/**
 * Failure codes from `scrape_run_failure_tuple_check` that describe the run
 * rather than a record. Every other code in that tuple is raised per record.
 */
export const RUN_LEVEL_FAILURE_CODES = [
  "DISCOVER_FAILED",
  "CHECKPOINT_WRITE_FAILED",
  "COMPLETE_WRITE_FAILED",
  "UNEXPECTED_FAILURE",
  "LEGACY_FAILURE",
] as const;

export type RunIneligibilityReason =
  | "per_record_failure"
  | "run_still_running"
  | "run_succeeded"
  | "unknown_run_status";

export type RunEligibility =
  | { readonly eligible: true; readonly status: "cancelled" | "failed" }
  | { readonly eligible: false; readonly reason: RunIneligibilityReason };

export const classifyRunEligibility = (run: {
  readonly failureCode: string | null;
  readonly fouten: number;
  readonly status: string;
}): RunEligibility => {
  switch (run.status) {
    case "cancelled": {
      return { eligible: true, status: "cancelled" };
    }
    case "failed": {
      const runLevel =
        run.fouten === 0 ||
        RUN_LEVEL_FAILURE_CODES.some((code) => code === run.failureCode);
      return runLevel
        ? { eligible: true, status: "failed" }
        : { eligible: false, reason: "per_record_failure" };
    }
    case "succeeded": {
      return { eligible: false, reason: "run_succeeded" };
    }
    case "running": {
      return { eligible: false, reason: "run_still_running" };
    }
    default: {
      return { eligible: false, reason: "unknown_run_status" };
    }
  }
};

export interface CliArguments {
  readonly apply: boolean;
  readonly limit: number;
  readonly scrapeRunId: string;
}

const valueFlags = new Set(["--run", "--limit"]);
const booleanFlags = new Set(["--apply", "--ingest-quiesced"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const collectOptions = (arguments_: readonly string[]) => {
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
  return { booleans, values };
};

export const parseArguments = (arguments_: readonly string[]): CliArguments => {
  const { booleans, values } = collectOptions(arguments_);
  const scrapeRunId = values.get("--run")?.trim().toLowerCase();
  if (!scrapeRunId || !UUID_PATTERN.test(scrapeRunId)) {
    throw new Error("--run must be a scrape_run uuid");
  }
  const limitText = values.get("--limit") ?? String(DEFAULT_LIMIT);
  const limit = /^\d+$/u.test(limitText) ? Number(limitText) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 through ${MAX_LIMIT}`);
  }
  const apply = booleans.has("--apply");
  if (apply !== booleans.has("--ingest-quiesced")) {
    throw new Error(
      "--apply requires --ingest-quiesced; report mode rejects it"
    );
  }
  return { apply, limit, scrapeRunId };
};

interface RunRow {
  readonly bronId: string;
  readonly failureCode: string | null;
  readonly fouten: number;
  readonly status: string;
}

export interface RecoveryReport {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly eligibility: RunEligibility;
  readonly generatedAt: string;
  readonly limit: number;
  readonly missingRawInSample: number;
  readonly operation: "report";
  readonly parseInvalid: number;
  readonly recoverable: number;
  readonly sampled: number;
  readonly scrapeRunId: string;
}

export interface RecoveryReceipt {
  readonly eligibility: RunEligibility;
  readonly generatedAt: string;
  readonly limit: number;
  readonly operation: "apply";
  readonly result: CurateScrapeRunResult | null;
  readonly scrapeRunId: string;
}

const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
};

const openSql = (readOnly: boolean): postgres.Sql =>
  postgres(requireDatabaseUrl(), {
    connect_timeout: 10,
    connection: readOnly
      ? {
          default_transaction_read_only: true,
          statement_timeout: STATEMENT_TIMEOUT_MS,
        }
      : {
          lock_timeout: LOCK_TIMEOUT_MS,
          statement_timeout: STATEMENT_TIMEOUT_MS,
        },
    idle_timeout: 20,
    max: 1,
    max_lifetime: null,
  });

const openObjectStore = (): ObjectStore =>
  createRawObjectStore({
    RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
    RAW_S3_ACCESS_KEY_ID: process.env.RAW_S3_ACCESS_KEY_ID,
    RAW_S3_BUCKET: process.env.RAW_S3_BUCKET,
    RAW_S3_ENDPOINT: process.env.RAW_S3_ENDPOINT,
    RAW_S3_REGION: process.env.RAW_S3_REGION,
    RAW_S3_SECRET_ACCESS_KEY: process.env.RAW_S3_SECRET_ACCESS_KEY,
  }).store;

const readRun = async (
  sql: postgres.Sql,
  scrapeRunId: string
): Promise<RunRow> => {
  const [row] = await sql<RunRow[]>`
    SELECT bron_id::text AS "bronId",
           failure_code AS "failureCode",
           fouten,
           status
    FROM curated.scrape_run
    WHERE id = ${scrapeRunId}::uuid
  `;
  if (!row) {
    throw new Error(`scrape_run ${scrapeRunId} does not exist`);
  }
  return row;
};

const slugForBron = (bronId: string): SupportedBronSlug => {
  const entry = Object.entries(SOURCES).find(
    ([, source]) => source.bronId === bronId
  );
  if (!entry) {
    throw new Error(`No registered source owns bronId ${bronId}`);
  }
  // SAFETY: SOURCES is keyed by SupportedBronSlug, so every entry key is one.
  return entry[0] as SupportedBronSlug;
};

interface SampleRow {
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly contentHash: string;
  readonly payload: unknown;
  readonly rawPayloadRef: string | null;
  readonly runBronId: string;
  readonly scrapeRunId: string;
  readonly sourceRecordBronId: string;
  readonly sourceRecordId: string;
}

export const runReport = async (
  arguments_: CliArguments,
  dependencies: { objectStore: ObjectStore; sql: postgres.Sql }
): Promise<RecoveryReport> => {
  const run = await readRun(dependencies.sql, arguments_.scrapeRunId);
  const eligibility = classifyRunEligibility(run);
  const statusRows = await dependencies.sql<
    { count: string; status: string }[]
  >`
    SELECT o.status, count(*)::text AS count
    FROM staging.aanvraag_observation o
    WHERE o.scrape_run_id = ${arguments_.scrapeRunId}::uuid
    GROUP BY o.status
  `;
  const byStatus = Object.fromEntries(
    statusRows.map((row) => [row.status, Number(row.count)] as const)
  );
  const recoverable = RECOVERABLE_STATUSES.reduce(
    (total, status) => total + (byStatus[status] ?? 0),
    0
  );
  const sample = await dependencies.sql<SampleRow[]>`
    SELECT o.bron_id::text AS "bronId",
           sr.bron_referentie AS "bronReferentie",
           o.content_hash AS "contentHash",
           o.payload,
           o.payload->>'rawPayloadRef' AS "rawPayloadRef",
           r.bron_id::text AS "runBronId",
           o.scrape_run_id::text AS "scrapeRunId",
           sr.bron_id::text AS "sourceRecordBronId",
           o.source_record_id::text AS "sourceRecordId"
    FROM staging.aanvraag_observation o
    JOIN curated.scrape_run r ON r.id = o.scrape_run_id
    JOIN staging.source_record sr ON sr.id = o.source_record_id
    WHERE o.scrape_run_id = ${arguments_.scrapeRunId}::uuid
      AND o.status = ANY(${[...RECOVERABLE_STATUSES]})
    ORDER BY o.created_at ASC, o.id ASC
    LIMIT ${arguments_.limit}
  `;
  let parseInvalid = 0;
  let missingRawInSample = 0;
  /* oxlint-disable no-await-in-loop -- bounded by --limit; one raw lookup per row */
  for (const row of sample) {
    if (!isValidCandidatePayload(row)) {
      parseInvalid += 1;
      continue;
    }
    const stored = row.rawPayloadRef
      ? await dependencies.objectStore.get(row.rawPayloadRef)
      : null;
    if (stored === null) {
      missingRawInSample += 1;
    }
  }
  /* oxlint-enable no-await-in-loop */
  return {
    byStatus,
    eligibility,
    generatedAt: new Date().toISOString(),
    limit: arguments_.limit,
    missingRawInSample,
    operation: "report",
    parseInvalid,
    recoverable,
    sampled: sample.length,
    scrapeRunId: arguments_.scrapeRunId,
  };
};

export const runApply = async (
  arguments_: CliArguments,
  dependencies: { objectStore: ObjectStore; sql: postgres.Sql }
): Promise<RecoveryReceipt> => {
  const run = await readRun(dependencies.sql, arguments_.scrapeRunId);
  const eligibility = classifyRunEligibility(run);
  const generatedAt = new Date().toISOString();
  const base = {
    eligibility,
    generatedAt,
    limit: arguments_.limit,
    operation: "apply" as const,
    scrapeRunId: arguments_.scrapeRunId,
  };
  if (!eligibility.eligible) {
    return { ...base, result: null };
  }
  const eligibleRunStatuses: readonly EligibleRunStatus[] = [
    eligibility.status,
  ];
  // SAFETY: bronId comes from the scrape_run row, whose bron_id column is a
  // uuid foreign key, and scrapeRunId passed the uuid pattern in parseArguments.
  const result = await curateScrapeRun({
    attemptLimit: arguments_.limit,
    bronId: run.bronId as BronId,
    bronSlug: slugForBron(run.bronId),
    database: drizzle(dependencies.sql, { schema }),
    eligibleRunStatuses,
    objectStore: dependencies.objectStore,
    scopeToRun: true,
    scrapeRunId: arguments_.scrapeRunId as ScrapeRunId,
  });
  return { ...base, result };
};

const main = async (): Promise<void> => {
  const arguments_ = parseArguments(Bun.argv.slice(2));
  const sql = openSql(!arguments_.apply);
  try {
    const dependencies = { objectStore: openObjectStore(), sql };
    const output = arguments_.apply
      ? await runApply(arguments_, dependencies)
      : await runReport(arguments_, dependencies);
    console.log(JSON.stringify(output, null, 2));
    if (!output.eligibility.eligible) {
      process.exitCode = 2;
    }
  } finally {
    await sql.end({ timeout: 5 });
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
