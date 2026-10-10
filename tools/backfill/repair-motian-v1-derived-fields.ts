import { hashContent, RawObjectDigestMismatchError } from "@ji/connectors";
import { createRawObjectStore } from "@ji/connectors/s3-object-client";
import postgres from "postgres";
import { z } from "zod";

import {
  applyMotianV1DerivedFieldRepair,
  rollbackMotianV1DerivedFieldRepair,
} from "./motian-v1-derived-field-apply";
import type {
  MotianRepairApplyReason,
  MotianRepairApplyResult,
  MotianRepairRollbackResult,
} from "./motian-v1-derived-field-apply";
import {
  MOTIAN_DERIVED_FIELD_NAMES,
  MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
  planMotianV1DerivedFieldRepair,
  validateCurrentMotianV1DerivedFieldRepairCandidate,
} from "./motian-v1-derived-field-repair";
import type {
  CurrentMotianDerivedFieldRow,
  MotianDerivedFieldName,
  MotianDerivedFieldRepairManifestEntry,
  MotianDerivedFieldRepairPlan,
  MotianDerivedFieldRepairReason,
  RawObjectForMotianRepair,
} from "./motian-v1-derived-field-repair";

const MAX_MANIFEST_ENTRIES = 100;
const REPORT_STATEMENT_TIMEOUT_MS = 15_000;

export type MotianRepairOperation = "apply" | "report" | "rollback";

export interface CliArguments {
  readonly auditId?: string;
  readonly ingestQuiesced: boolean;
  readonly limit?: number;
  readonly manifestPath?: string;
  readonly operation: MotianRepairOperation;
}

const manifestEntrySchema = z
  .object({
    aanvraagId: z.string().trim().min(1),
    bronId: z.string().trim().min(1),
    bronReferentie: z.string().trim().min(1),
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu)
      .transform((value) => value.toLowerCase()),
    rawPayloadRef: z.string().trim().min(1),
    v1Id: z.string().trim().min(1),
  })
  .strict();

const repairManifestSchema = z
  .object({
    candidates: z.array(manifestEntrySchema).min(1).max(MAX_MANIFEST_ENTRIES),
    version: z.literal(MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION),
  })
  .strict();

type RepairManifest = z.infer<typeof repairManifestSchema>;

const parseManifest = (body: Uint8Array): RepairManifest => {
  const manifest = repairManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(body))
  );
  const { candidates } = manifest;
  const uniqueIds = new Set(candidates.map((candidate) => candidate.v1Id));
  const uniqueAanvraagIds = new Set(
    candidates.map((candidate) => candidate.aanvraagId)
  );
  if (
    uniqueIds.size !== candidates.length ||
    uniqueAanvraagIds.size !== candidates.length
  ) {
    throw new Error("Manifest must not contain duplicate v1Id or aanvraagId");
  }
  return manifest;
};

const valueFlags = new Set(["--audit-id", "--limit", "--manifest"]);
const booleanFlags = new Set(["--apply", "--ingest-quiesced", "--rollback"]);

const readValue = (
  values: ReadonlyMap<string, string>,
  option: string
): string => {
  const value = values.get(option);
  if (!value) {
    throw new Error(`${option} is required`);
  }
  return value;
};

export const readOptions = (
  arguments_: readonly string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>
) => {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    if (
      !argument ||
      (!valueOptions.has(argument) && !booleanOptions.has(argument))
    ) {
      throw new Error(`Unsupported option ${argument ?? ""}`);
    }
    if (values.has(argument) || booleans.has(argument)) {
      throw new Error(`Duplicate option ${argument}`);
    }
    if (booleanOptions.has(argument)) {
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

const parseArguments = (arguments_: readonly string[]): CliArguments => {
  const { values, booleans } = readOptions(
    arguments_,
    valueFlags,
    booleanFlags
  );
  const apply = booleans.has("--apply");
  const rollback = booleans.has("--rollback");
  if (apply && rollback) {
    throw new Error("--apply and --rollback are mutually exclusive");
  }
  const ingestQuiesced = booleans.has("--ingest-quiesced");
  if ((apply || rollback) !== ingestQuiesced) {
    throw new Error(
      "--apply and --rollback require --ingest-quiesced; report mode rejects it"
    );
  }

  if (rollback) {
    if (values.has("--limit") || values.has("--manifest")) {
      throw new Error(
        "--rollback accepts only --audit-id and --ingest-quiesced"
      );
    }
    return {
      auditId: readValue(values, "--audit-id"),
      ingestQuiesced,
      operation: "rollback",
    };
  }

  if (values.has("--audit-id")) {
    throw new Error("--audit-id requires --rollback");
  }
  const limitText = readValue(values, "--limit");
  if (!/^\d+$/u.test(limitText)) {
    throw new Error(
      `--limit must be an integer from 1 through ${MAX_MANIFEST_ENTRIES}`
    );
  }
  const limit = Number(limitText);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_MANIFEST_ENTRIES
  ) {
    throw new Error(
      `--limit must be an integer from 1 through ${MAX_MANIFEST_ENTRIES}`
    );
  }
  const operation: MotianRepairOperation = apply ? "apply" : "report";
  return {
    ingestQuiesced,
    limit,
    manifestPath: readValue(values, "--manifest"),
    operation,
  };
};

const loadManifest = async (
  manifestPath: string
): Promise<{
  readonly manifest: RepairManifest;
  readonly manifestSha256: string;
}> => {
  const body = new Uint8Array(await Bun.file(manifestPath).arrayBuffer());
  return {
    manifest: parseManifest(body),
    manifestSha256: await hashContent(body),
  };
};

const readCurrentRow = async (
  sql: postgres.Sql | postgres.TransactionSql,
  entry: MotianDerivedFieldRepairManifestEntry
): Promise<CurrentMotianDerivedFieldRow | null> => {
  const rows = await sql<CurrentMotianDerivedFieldRow[]>`
    SELECT
      id::text AS "aanvraagId",
      bron_id::text AS "bronId",
      bron_referentie AS "bronReferentie",
      content_hash AS "contentHash",
      raw_payload_ref AS "rawPayloadRef",
      v1_id AS "v1Id",
      opdrachtgever_naam AS "opdrachtgeverNaam",
      contracttype,
      publicatiedatum,
      start_datum AS "startDatum",
      sluitingsdatum
    FROM curated.aanvraag
    WHERE id::text = ${entry.aanvraagId}
      AND v1_id = ${entry.v1Id}
    LIMIT 1
  `;
  return rows[0] ?? null;
};

type ReportReason = MotianDerivedFieldRepairReason | "raw_read_failed";

interface RejectedCandidateReport {
  readonly reason: ReportReason;
  readonly status: "rejected";
  readonly v1Id: string;
}

interface UnchangedCandidateReport {
  readonly sourceAbsentFields: readonly MotianDerivedFieldName[];
  readonly status: "unchanged";
  readonly v1Id: string;
}

interface WouldPatchCandidateReport {
  readonly fields: readonly MotianDerivedFieldName[];
  readonly sourceAbsentFields: readonly MotianDerivedFieldName[];
  readonly status: "would_patch";
  readonly v1Id: string;
}

type CandidateReport =
  | RejectedCandidateReport
  | UnchangedCandidateReport
  | WouldPatchCandidateReport;

interface RepairReport {
  readonly candidates: readonly CandidateReport[];
  readonly manifestSha256: string;
  readonly planVersion: typeof MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION;
  readonly projectionEventsRequired: number;
  readonly rejected: Partial<Record<ReportReason, number>>;
  readonly selected: number;
  readonly unchanged: number;
  readonly wouldPatch: Record<MotianDerivedFieldName, number>;
}

const candidateReport = (
  plan: MotianDerivedFieldRepairPlan
): CandidateReport => {
  if (plan.kind === "rejected") {
    return { reason: plan.reason, status: "rejected", v1Id: plan.v1Id };
  }
  if (plan.kind === "unchanged") {
    return {
      sourceAbsentFields: plan.sourceAbsentFields,
      status: "unchanged",
      v1Id: plan.v1Id,
    };
  }
  return {
    fields: MOTIAN_DERIVED_FIELD_NAMES.filter(
      (field) => plan.patch[field] !== undefined
    ),
    sourceAbsentFields: plan.sourceAbsentFields,
    status: "would_patch",
    v1Id: plan.v1Id,
  };
};

export const planReportCandidate = async (input: {
  readonly current: CurrentMotianDerivedFieldRow | null;
  readonly manifest: MotianDerivedFieldRepairManifestEntry;
  readonly readRawObject: (
    rawPayloadRef: string
  ) => Promise<RawObjectForMotianRepair | null>;
}): Promise<CandidateReport> => {
  const { current, manifest, readRawObject } = input;
  const candidateValidation =
    validateCurrentMotianV1DerivedFieldRepairCandidate({ current, manifest });
  if (candidateValidation) {
    return candidateReport(candidateValidation);
  }
  if (!current) {
    return candidateReport({
      kind: "rejected",
      reason: "current_row_missing",
      v1Id: manifest.v1Id,
    });
  }
  let raw: RawObjectForMotianRepair | null;
  try {
    raw = await readRawObject(current.rawPayloadRef);
  } catch (error) {
    if (error instanceof RawObjectDigestMismatchError) {
      return {
        reason: "raw_hash_mismatch",
        status: "rejected",
        v1Id: manifest.v1Id,
      };
    }
    return {
      reason: "raw_read_failed",
      status: "rejected",
      v1Id: manifest.v1Id,
    };
  }
  return candidateReport(
    await planMotianV1DerivedFieldRepair({ current, manifest, raw })
  );
};

const createEmptyFieldCounts = () =>
  ({
    contracttype: 0,
    opdrachtgeverNaam: 0,
    opleidingsniveau: 0,
    provincie: 0,
    publicatiedatum: 0,
    skills: 0,
    sluitingsdatum: 0,
    startDatum: 0,
    tariefEenheid: 0,
    tariefMax: 0,
    tariefMin: 0,
    urenPerWeek: 0,
  }) satisfies Record<MotianDerivedFieldName, number>;

const runReport = async (input: {
  readonly limit: number;
  readonly manifest: RepairManifest;
  readonly manifestSha256: string;
}): Promise<RepairReport> => {
  if (input.manifest.candidates.length > input.limit) {
    throw new Error(
      "Manifest candidate count exceeds --limit; create an explicit smaller manifest"
    );
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the report-only diagnostic");
  }
  const rawObjectStore = createRawObjectStore({
    RAW_S3_ACCESS_KEY_ID: process.env.RAW_S3_ACCESS_KEY_ID,
    RAW_S3_BUCKET: process.env.RAW_S3_BUCKET,
    RAW_S3_ENDPOINT: process.env.RAW_S3_ENDPOINT,
    RAW_S3_REGION: process.env.RAW_S3_REGION,
    RAW_S3_SECRET_ACCESS_KEY: process.env.RAW_S3_SECRET_ACCESS_KEY,
  });
  if (rawObjectStore.kind !== "s3") {
    throw new Error(
      "RAW_S3_BUCKET is required; filesystem raw storage is refused"
    );
  }

  const sql = postgres(databaseUrl, {
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: true,
      statement_timeout: REPORT_STATEMENT_TIMEOUT_MS,
    },
    idle_timeout: 20,
    max: 1,
    max_lifetime: null,
  });
  const reports: CandidateReport[] = [];
  const wouldPatch = createEmptyFieldCounts();
  const rejected: Partial<Record<ReportReason, number>> = {};
  let unchanged = 0;

  try {
    await sql.begin(
      "isolation level repeatable read read only",
      async (readOnlySql) => {
        for (const manifestEntry of input.manifest.candidates) {
          /* oxlint-disable no-await-in-loop -- each approved source id is bounded and reported deterministically */
          const current = await readCurrentRow(readOnlySql, manifestEntry);
          const report = await planReportCandidate({
            current,
            manifest: manifestEntry,
            readRawObject: (rawPayloadRef) =>
              rawObjectStore.store.get(rawPayloadRef),
          });
          reports.push(report);
          if (report.status === "rejected") {
            rejected[report.reason] = (rejected[report.reason] ?? 0) + 1;
          } else if (report.status === "unchanged") {
            unchanged += 1;
          } else {
            for (const field of report.fields) {
              wouldPatch[field] += 1;
            }
          }
          /* oxlint-enable no-await-in-loop */
        }
      }
    );
  } finally {
    await sql.end({ timeout: 5 });
  }

  return {
    candidates: reports,
    manifestSha256: input.manifestSha256,
    planVersion: MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
    projectionEventsRequired: reports.filter(
      (report) => report.status === "would_patch"
    ).length,
    rejected,
    selected: reports.length,
    unchanged,
    wouldPatch,
  };
};

interface ApplyReport {
  readonly applied: number;
  readonly candidates: readonly MotianRepairApplyResult[];
  readonly manifestSha256: string;
  readonly planVersion: typeof MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION;
  readonly projectionEventsRequired: number;
  readonly rejected: Partial<Record<MotianRepairApplyReason, number>>;
  readonly selected: number;
  readonly unchanged: number;
}

interface RollbackReport {
  readonly auditId: string;
  readonly planVersion: typeof MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION;
  readonly result: MotianRepairRollbackResult;
}

const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
};

const createRawReader = (): ((
  rawPayloadRef: string
) => Promise<RawObjectForMotianRepair | null>) => {
  const rawObjectStore = createRawObjectStore({
    RAW_S3_ACCESS_KEY_ID: process.env.RAW_S3_ACCESS_KEY_ID,
    RAW_S3_BUCKET: process.env.RAW_S3_BUCKET,
    RAW_S3_ENDPOINT: process.env.RAW_S3_ENDPOINT,
    RAW_S3_REGION: process.env.RAW_S3_REGION,
    RAW_S3_SECRET_ACCESS_KEY: process.env.RAW_S3_SECRET_ACCESS_KEY,
  });
  if (rawObjectStore.kind !== "s3") {
    throw new Error(
      "RAW_S3_BUCKET is required; filesystem raw storage is refused"
    );
  }
  return (rawPayloadRef) => rawObjectStore.store.get(rawPayloadRef);
};

const createRepairDatabase = (readOnly: boolean): postgres.Sql =>
  postgres(requireDatabaseUrl(), {
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: readOnly,
      statement_timeout: REPORT_STATEMENT_TIMEOUT_MS,
    },
    idle_timeout: 20,
    max: 1,
    max_lifetime: null,
  });

export const runApply = async (input: {
  readonly limit: number;
  readonly manifest: RepairManifest;
  readonly manifestSha256: string;
}): Promise<ApplyReport> => {
  if (input.manifest.candidates.length > input.limit) {
    throw new Error(
      "Manifest candidate count exceeds --limit; create an explicit smaller manifest"
    );
  }
  const readRawObject = createRawReader();
  const database = createRepairDatabase(false);
  const candidates: MotianRepairApplyResult[] = [];
  const rejected: Partial<Record<MotianRepairApplyReason, number>> = {};
  let applied = 0;
  let unchanged = 0;

  try {
    for (const manifestEntry of input.manifest.candidates) {
      let result: MotianRepairApplyResult;
      try {
        /* oxlint-disable no-await-in-loop -- the row lock and bounded transaction are per approved candidate */
        result = await applyMotianV1DerivedFieldRepair({
          database,
          manifest: manifestEntry,
          manifestSha256: input.manifestSha256,
          readRawObject,
        });
        /* oxlint-enable no-await-in-loop */
      } catch {
        result = {
          reason: "transaction_failed",
          status: "rejected",
          v1Id: manifestEntry.v1Id,
        };
      }
      candidates.push(result);
      if (result.status === "applied") {
        applied += 1;
      } else if (result.status === "unchanged") {
        unchanged += 1;
      } else if (result.reason) {
        rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
      }
    }
  } finally {
    await database.end({ timeout: 5 });
  }

  return {
    applied,
    candidates,
    manifestSha256: input.manifestSha256,
    planVersion: MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
    projectionEventsRequired: applied,
    rejected,
    selected: candidates.length,
    unchanged,
  };
};

export const runRollback = async (input: {
  readonly auditId: string;
}): Promise<RollbackReport> => {
  const database = createRepairDatabase(false);
  let result: MotianRepairRollbackResult;
  try {
    try {
      result = await rollbackMotianV1DerivedFieldRepair({
        auditId: input.auditId,
        database,
      });
    } catch {
      result = {
        reason: "rollback_transaction_failed",
        status: "rejected",
      };
    }
  } finally {
    await database.end({ timeout: 5 });
  }
  return {
    auditId: input.auditId,
    planVersion: MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
    result,
  };
};

const main = async (): Promise<void> => {
  const arguments_ = parseArguments(Bun.argv.slice(2));
  if (arguments_.operation === "rollback") {
    if (!arguments_.auditId) {
      throw new Error("Rollback arguments were incomplete");
    }
    console.log(
      JSON.stringify(
        await runRollback({ auditId: arguments_.auditId }),
        null,
        2
      )
    );
    return;
  }
  if (!arguments_.manifestPath || arguments_.limit === undefined) {
    throw new Error("Repair arguments were incomplete");
  }
  const { manifest, manifestSha256 } = await loadManifest(
    arguments_.manifestPath
  );
  const result =
    arguments_.operation === "apply"
      ? await runApply({
          limit: arguments_.limit,
          manifest,
          manifestSha256,
        })
      : await runReport({
          limit: arguments_.limit,
          manifest,
          manifestSha256,
        });
  console.log(JSON.stringify(result, null, 2));
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

export { MAX_MANIFEST_ENTRIES, parseArguments, parseManifest, runReport };
