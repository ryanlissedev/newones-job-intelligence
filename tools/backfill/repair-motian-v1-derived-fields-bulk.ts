import { rename } from "node:fs/promises";

import { hashContent } from "@ji/connectors";
import postgres from "postgres";
import { z } from "zod";

import {
  MOTIAN_DERIVED_FIELD_NAMES,
  MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
} from "./motian-v1-derived-field-repair";
import type { MotianDerivedFieldRepairManifestEntry } from "./motian-v1-derived-field-repair";
import {
  MAX_MANIFEST_ENTRIES,
  parseManifest,
  readOptions,
  runApply,
  runReport,
} from "./repair-motian-v1-derived-fields";

export const MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION =
  "motian-v1-derived-field-repair-bulk/v1" as const;

export const BENIGN_BULK_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "raw_schema_not_motian",
]);

export const MOTIAN_BULK_CANDIDATE_NULL_COLUMNS: readonly string[] =
  MOTIAN_DERIVED_FIELD_NAMES.map((field) =>
    field.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)
  ).toSorted();

const NIL_CURSOR = "00000000-0000-0000-0000-000000000000";
const SELECT_STATEMENT_TIMEOUT_MS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type RepairManifest = ReturnType<typeof parseManifest>;

export interface BulkCliArguments {
  readonly apply: boolean;
  readonly batch: number;
  readonly cursor?: string;
  readonly maxBatches: number;
  readonly statePath: string;
}

export interface BulkBatchRecord {
  readonly auditIds: readonly string[];
  readonly finishedAt: string;
  readonly index: number;
  readonly manifestSha256: string;
  readonly patched?: number;
  readonly rejected: number;
  readonly rejectedReasons: Readonly<Record<string, number>>;
  readonly selected: number;
  readonly startedAt: string;
  readonly wouldPatch?: number;
}

export interface BulkTotals {
  readonly batches: number;
  readonly patched?: number;
  readonly rejected: number;
  readonly selected: number;
  readonly wouldPatch?: number;
}

export interface BulkRepairState {
  readonly batches: readonly BulkBatchRecord[];
  readonly cursor: string;
  readonly totals: BulkTotals;
  readonly version: typeof MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION;
}

export type BulkStopReason = "corpus_exhausted" | "max_batches" | "rejected";

export interface BulkRepairSummary {
  readonly blockingReasons: readonly string[];
  readonly mode: "apply" | "report";
  readonly state: BulkRepairState;
  readonly stopReason: BulkStopReason;
}

export interface BulkApplyOutcome {
  readonly applied: number;
  readonly candidates: readonly {
    readonly auditId?: string;
    readonly status: string;
  }[];
  readonly rejected: Readonly<Record<string, number | undefined>>;
  readonly selected: number;
}

export interface BulkReportOutcome {
  readonly projectionEventsRequired: number;
  readonly rejected: Readonly<Record<string, number | undefined>>;
  readonly selected: number;
}

export interface BulkRepairDependencies {
  readonly now: () => string;
  readonly readState: (statePath: string) => Promise<BulkRepairState | null>;
  readonly runApply: (input: {
    readonly limit: number;
    readonly manifest: RepairManifest;
    readonly manifestSha256: string;
  }) => Promise<BulkApplyOutcome>;
  readonly runReport: (input: {
    readonly limit: number;
    readonly manifest: RepairManifest;
    readonly manifestSha256: string;
  }) => Promise<BulkReportOutcome>;
  readonly selectCandidates: (input: {
    readonly batch: number;
    readonly cursor: string;
  }) => Promise<readonly MotianDerivedFieldRepairManifestEntry[]>;
  readonly writeState: (
    statePath: string,
    state: BulkRepairState
  ) => Promise<void>;
}

const batchRecordSchema = z
  .object({
    auditIds: z.array(z.string()),
    finishedAt: z.string(),
    index: z.number().int().nonnegative(),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    patched: z.number().int().nonnegative().optional(),
    rejected: z.number().int().nonnegative(),
    rejectedReasons: z.record(z.string(), z.number().int().nonnegative()),
    selected: z.number().int().nonnegative(),
    startedAt: z.string(),
    wouldPatch: z.number().int().nonnegative().optional(),
  })
  .strict();

const stateSchema = z
  .object({
    batches: z.array(batchRecordSchema),
    cursor: z.string().regex(UUID_PATTERN),
    totals: z
      .object({
        batches: z.number().int().nonnegative(),
        patched: z.number().int().nonnegative().optional(),
        rejected: z.number().int().nonnegative(),
        selected: z.number().int().nonnegative(),
        wouldPatch: z.number().int().nonnegative().optional(),
      })
      .strict(),
    version: z.literal(MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION),
  })
  .strict();

const bulkValueFlags = new Set([
  "--batch",
  "--cursor",
  "--max-batches",
  "--state",
]);
const bulkBooleanFlags = new Set(["--apply", "--ingest-quiesced"]);

const readPositiveInteger = (
  values: ReadonlyMap<string, string>,
  option: string,
  bounds: { readonly maximum: number; readonly minimum: number },
  fallback?: number
): number => {
  const text = values.get(option);
  if (text === undefined) {
    if (fallback === undefined) {
      throw new Error(`${option} is required`);
    }
    return fallback;
  }
  const message = `${option} must be an integer from ${bounds.minimum} through ${bounds.maximum}`;
  if (!/^\d+$/u.test(text)) {
    throw new Error(message);
  }
  const value = Number(text);
  if (
    !Number.isSafeInteger(value) ||
    value < bounds.minimum ||
    value > bounds.maximum
  ) {
    throw new Error(message);
  }
  return value;
};

export const parseBulkArguments = (
  arguments_: readonly string[]
): BulkCliArguments => {
  const { booleans, values } = readOptions(
    arguments_,
    bulkValueFlags,
    bulkBooleanFlags
  );
  const apply = booleans.has("--apply");
  if (apply !== booleans.has("--ingest-quiesced")) {
    throw new Error(
      "--apply requires --ingest-quiesced; report mode rejects it"
    );
  }
  const statePath = values.get("--state");
  if (!statePath) {
    throw new Error("--state is required");
  }
  const cursor = values.get("--cursor");
  if (cursor !== undefined && !UUID_PATTERN.test(cursor)) {
    throw new Error("--cursor must be an aanvraag uuid");
  }
  return {
    apply,
    batch: readPositiveInteger(
      values,
      "--batch",
      { maximum: MAX_MANIFEST_ENTRIES, minimum: 1 },
      MAX_MANIFEST_ENTRIES
    ),
    cursor,
    maxBatches: readPositiveInteger(values, "--max-batches", {
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 1,
    }),
    statePath,
  };
};

export interface StateFileIo {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly write: (path: string, body: string) => Promise<void>;
}

const defaultStateFileIo: StateFileIo = {
  rename: (from, to) => rename(from, to),
  write: async (path, body) => {
    await Bun.write(path, body);
  },
};

export const stateTemporaryPath = (statePath: string): string =>
  `${statePath}.tmp`;

export const writeStateFile = async (
  statePath: string,
  state: BulkRepairState,
  io: StateFileIo = defaultStateFileIo
): Promise<void> => {
  const temporaryPath = stateTemporaryPath(statePath);
  await io.write(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  await io.rename(temporaryPath, statePath);
};

export const readStateFile = async (
  statePath: string
): Promise<BulkRepairState | null> => {
  const file = Bun.file(statePath);
  if (!(await file.exists())) {
    return null;
  }
  return stateSchema.parse(JSON.parse(await file.text()));
};

export const buildBatchManifest = async (
  candidates: readonly MotianDerivedFieldRepairManifestEntry[]
): Promise<{
  readonly manifest: RepairManifest;
  readonly manifestSha256: string;
}> => {
  const body = new TextEncoder().encode(
    JSON.stringify(
      {
        candidates: candidates.map((candidate) => ({
          aanvraagId: candidate.aanvraagId,
          bronId: candidate.bronId,
          bronReferentie: candidate.bronReferentie,
          contentHash: candidate.contentHash,
          rawPayloadRef: candidate.rawPayloadRef,
          v1Id: candidate.v1Id,
        })),
        version: MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
      },
      null,
      2
    )
  );
  return {
    manifest: parseManifest(body),
    manifestSha256: await hashContent(body),
  };
};

const countRejected = (
  rejected: Readonly<Record<string, number | undefined>>
) => {
  const reasons: Record<string, number> = {};
  let total = 0;
  for (const [reason, count] of Object.entries(rejected)) {
    if (count === undefined || count === 0) {
      continue;
    }
    reasons[reason] = count;
    total += count;
  }
  return { reasons, total };
};

const blockingRejectionReasons = (
  reasons: Readonly<Record<string, number>>
): string[] =>
  Object.keys(reasons)
    .filter((reason) => !BENIGN_BULK_REJECTION_REASONS.has(reason))
    .toSorted();

interface BatchRunInput {
  readonly limit: number;
  readonly manifest: RepairManifest;
  readonly manifestSha256: string;
}

interface BatchProgress {
  readonly auditIds: readonly string[];
  readonly progressed:
    | { readonly patched: number }
    | { readonly wouldPatch: number };
  readonly rejected: Readonly<Record<string, number | undefined>>;
  readonly selected: number;
}

const runApplyBatch = async (
  dependencies: BulkRepairDependencies,
  input: BatchRunInput
): Promise<BatchProgress> => {
  const outcome = await dependencies.runApply(input);
  return {
    auditIds: outcome.candidates
      .map((candidate) => candidate.auditId)
      .filter((auditId): auditId is string => auditId !== undefined),
    progressed: { patched: outcome.applied },
    rejected: outcome.rejected,
    selected: outcome.selected,
  };
};

const runReportBatch = async (
  dependencies: BulkRepairDependencies,
  input: BatchRunInput
): Promise<BatchProgress> => {
  const outcome = await dependencies.runReport(input);
  return {
    auditIds: [],
    progressed: { wouldPatch: outcome.projectionEventsRequired },
    rejected: outcome.rejected,
    selected: outcome.selected,
  };
};

const emptyState = (cursor: string): BulkRepairState => ({
  batches: [],
  cursor,
  totals: { batches: 0, rejected: 0, selected: 0 },
  version: MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION,
});

const appendBatch = (
  state: BulkRepairState,
  cursor: string,
  record: BulkBatchRecord,
  apply: boolean
): BulkRepairState => {
  const batches = [...state.batches, record];
  const progressed = apply
    ? { patched: (state.totals.patched ?? 0) + (record.patched ?? 0) }
    : { wouldPatch: (state.totals.wouldPatch ?? 0) + (record.wouldPatch ?? 0) };
  return {
    batches,
    cursor,
    totals: {
      batches: batches.length,
      rejected: state.totals.rejected + record.rejected,
      selected: state.totals.selected + record.selected,
      ...progressed,
    },
    version: MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION,
  };
};

export const runBulkRepair = async (input: {
  readonly arguments_: BulkCliArguments;
  readonly dependencies: BulkRepairDependencies;
}): Promise<BulkRepairSummary> => {
  const { arguments_, dependencies } = input;
  const resumed = await dependencies.readState(arguments_.statePath);
  let state = resumed
    ? { ...resumed, cursor: arguments_.cursor ?? resumed.cursor }
    : emptyState(arguments_.cursor ?? NIL_CURSOR);
  let stopReason: BulkStopReason = "max_batches";
  let blocking: readonly string[] = [];

  for (let offset = 0; offset < arguments_.maxBatches; offset += 1) {
    /* oxlint-disable no-await-in-loop -- batches must commit and checkpoint in cursor order */
    const candidates = await dependencies.selectCandidates({
      batch: arguments_.batch,
      cursor: state.cursor,
    });
    if (candidates.length === 0) {
      stopReason = "corpus_exhausted";
      break;
    }
    const startedAt = dependencies.now();
    const { manifest, manifestSha256 } = await buildBatchManifest(candidates);
    const batchInput: BatchRunInput = {
      limit: arguments_.batch,
      manifest,
      manifestSha256,
    };
    const progress = arguments_.apply
      ? await runApplyBatch(dependencies, batchInput)
      : await runReportBatch(dependencies, batchInput);
    const rejected = countRejected(progress.rejected);
    const record: BulkBatchRecord = {
      auditIds: progress.auditIds,
      finishedAt: dependencies.now(),
      index: state.batches.length,
      manifestSha256,
      rejected: rejected.total,
      rejectedReasons: rejected.reasons,
      selected: progress.selected,
      startedAt,
      ...progress.progressed,
    };
    const nextCursor = candidates.at(-1)?.aanvraagId ?? state.cursor;
    state = appendBatch(state, nextCursor, record, arguments_.apply);
    await dependencies.writeState(arguments_.statePath, state);
    if (arguments_.apply) {
      const batchBlocking = blockingRejectionReasons(rejected.reasons);
      if (batchBlocking.length > 0) {
        blocking = batchBlocking;
        stopReason = "rejected";
        break;
      }
    }
    if (candidates.length < arguments_.batch) {
      stopReason = "corpus_exhausted";
      break;
    }
    /* oxlint-enable no-await-in-loop */
  }

  return {
    blockingReasons: blocking,
    mode: arguments_.apply ? "apply" : "report",
    state,
    stopReason,
  };
};

const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
};

const createSelectionDatabase = (): postgres.Sql =>
  postgres(requireDatabaseUrl(), {
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: true,
      statement_timeout: SELECT_STATEMENT_TIMEOUT_MS,
    },
    idle_timeout: 20,
    max: 1,
    max_lifetime: null,
  });

export const selectBulkCandidates = async (input: {
  readonly batch: number;
  readonly cursor: string;
  readonly database: postgres.Sql;
}): Promise<readonly MotianDerivedFieldRepairManifestEntry[]> =>
  await input.database<MotianDerivedFieldRepairManifestEntry[]>`
    SELECT
      id::text AS "aanvraagId",
      bron_id::text AS "bronId",
      bron_referentie AS "bronReferentie",
      content_hash AS "contentHash",
      raw_payload_ref AS "rawPayloadRef",
      v1_id AS "v1Id"
    FROM curated.aanvraag
    WHERE v1_id IS NOT NULL
      AND raw_payload_ref LIKE 'raw/%' || content_hash || '.json'
      AND (
        contracttype IS NULL
        OR opdrachtgever_naam IS NULL
        OR publicatiedatum IS NULL
        OR sluitingsdatum IS NULL
        OR start_datum IS NULL
        OR uren_per_week IS NULL
        OR tarief_min IS NULL
        OR tarief_max IS NULL
        OR tarief_eenheid IS NULL
        OR NULLIF(trim(bron_specifiek->>'opleidingsniveau'), '') IS NULL
        OR NULLIF(trim(bron_specifiek->>'provincie'), '') IS NULL
        OR NULLIF(bron_specifiek->'skills', 'null'::jsonb) IS NULL
      )
      AND id > ${input.cursor}::uuid
    ORDER BY id
    LIMIT ${input.batch}
  `;

const createBulkDependencies = (
  database: postgres.Sql
): BulkRepairDependencies => ({
  now: () => new Date().toISOString(),
  readState: readStateFile,
  runApply,
  runReport,
  selectCandidates: ({ batch, cursor }) =>
    selectBulkCandidates({ batch, cursor, database }),
  writeState: (statePath, state) => writeStateFile(statePath, state),
});

const main = async (): Promise<void> => {
  const arguments_ = parseBulkArguments(Bun.argv.slice(2));
  const database = createSelectionDatabase();
  let summary: BulkRepairSummary;
  try {
    summary = await runBulkRepair({
      arguments_,
      dependencies: createBulkDependencies(database),
    });
  } finally {
    await database.end({ timeout: 5 });
  }
  console.log(
    JSON.stringify(
      {
        blockingReasons: summary.blockingReasons,
        mode: summary.mode,
        stopReason: summary.stopReason,
        ...summary.state,
      },
      null,
      2
    )
  );
  if (summary.stopReason === "rejected") {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(
      JSON.stringify({ reason: "command_failed", status: "error" })
    );
    process.exitCode = 1;
  }
}
