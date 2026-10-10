import type {
  MotianDerivedFieldRepairAuditFieldImage,
  MotianDerivedFieldRepairAuditMetadata,
  MotianDerivedFieldRepairRollbackAuditMetadata,
} from "@ji/application/registry";
import { RawObjectDigestMismatchError } from "@ji/connectors";
import type postgres from "postgres";
import { z } from "zod";

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
  RawObjectForMotianRepair,
} from "./motian-v1-derived-field-repair";

export const MOTIAN_REPAIR_SCOPE_ID = "catapulze" as const;
export const MOTIAN_REPAIR_ACTOR_ID = "motian-derived-field-repair" as const;
export const MOTIAN_REPAIR_APPLY_ACTION =
  "motian_derived_field_repair" as const;
export const MOTIAN_REPAIR_ROLLBACK_ACTION =
  "motian_derived_field_repair_rollback" as const;
export const MOTIAN_REPAIR_EVENT_TYPE = "aanvraag.gewijzigd" as const;

/** Keep the transaction short enough that a stalled row cannot hold a lock indefinitely. */
export const MOTIAN_REPAIR_STATEMENT_TIMEOUT_MS = 15_000;
export const MOTIAN_REPAIR_LOCK_TIMEOUT_MS = 2000;
export const MOTIAN_REPAIR_IDLE_TRANSACTION_TIMEOUT_MS = 20_000;

type MotianRepairSql = postgres.Sql | postgres.TransactionSql;

export type MotianRepairApplyReason =
  | "current_row_missing"
  | "current_row_mismatch"
  | "raw_missing"
  | "raw_content_type_invalid"
  | "raw_hash_mismatch"
  | "raw_read_failed"
  | "raw_ref_not_content_addressed"
  | "raw_schema_not_motian"
  | "source_identity_mismatch"
  | "transaction_failed";

export type MotianRepairRollbackReason =
  | "audit_event_missing"
  | "audit_metadata_invalid"
  | "audit_not_repair"
  | "current_row_missing"
  | "current_row_mismatch"
  | "rollback_transaction_failed";

export interface MotianRepairApplyResult {
  readonly auditId?: string;
  readonly changedFields?: readonly MotianDerivedFieldName[];
  readonly outboxId?: string;
  readonly reason?: MotianRepairApplyReason;
  readonly sourceAbsentFields?: readonly MotianDerivedFieldName[];
  readonly status: "applied" | "rejected" | "unchanged";
  readonly v1Id: string;
}

export interface MotianRepairRollbackResult {
  readonly auditId?: string;
  readonly outboxId?: string;
  readonly reason?: MotianRepairRollbackReason;
  readonly restoredFields?: readonly MotianDerivedFieldName[];
  readonly skippedFields?: readonly MotianDerivedFieldName[];
  readonly status: "rejected" | "rolled_back" | "unchanged";
}

interface RawReadResult {
  readonly raw: RawObjectForMotianRepair | null;
  readonly reason?: Extract<
    MotianRepairApplyReason,
    "raw_hash_mismatch" | "raw_read_failed"
  >;
}

interface StoredAuditRow {
  readonly action: string;
  readonly actorId: string | null;
  readonly auditClass: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly id: string;
  readonly metadata: unknown;
  readonly scopeId: string;
}

const repairFieldNameSchema = z.enum([
  "opdrachtgeverNaam",
  "contracttype",
  "publicatiedatum",
  "startDatum",
  "sluitingsdatum",
  "urenPerWeek",
  "tariefMin",
  "tariefMax",
  "tariefEenheid",
  "opleidingsniveau",
  "provincie",
  "skills",
]);

const repairFieldImageSchema = z
  .object({
    contracttype: z.string().nullable(),
    opdrachtgeverNaam: z.string().nullable(),
    opleidingsniveau: z.string().nullable(),
    provincie: z.string().nullable(),
    publicatiedatum: z.string().nullable(),
    skills: z.string().nullable(),
    sluitingsdatum: z.string().datetime({ offset: true }).nullable(),
    startDatum: z.string().nullable(),
    tariefEenheid: z.string().nullable(),
    tariefMax: z.string().nullable(),
    tariefMin: z.string().nullable(),
    urenPerWeek: z.string().nullable(),
  })
  .strict();

const repairAuditMetadataSchema = z
  .object({
    aanvraagId: z.string().min(1),
    afterimage: repairFieldImageSchema,
    bronId: z.string().min(1),
    bronReferentie: z.string().min(1),
    changedFields: z.array(repairFieldNameSchema),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    preimage: repairFieldImageSchema,
    rawPayloadRef: z.string().min(1),
    repairVersion: z.literal(MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION),
    sourceAbsentFields: z.array(repairFieldNameSchema),
    v1Id: z.string().min(1),
  })
  .strict();

const rollbackAuditMetadataSchema = repairAuditMetadataSchema
  .extend({ rollbackOfAuditId: z.string().min(1) })
  .strict();

const repairMetadataSchema = z.union([
  repairAuditMetadataSchema,
  rollbackAuditMetadataSchema,
]);

const fieldToColumn = {
  contracttype: "contracttype",
  opdrachtgeverNaam: "opdrachtgever_naam",
  opleidingsniveau: "bron_specifiek",
  provincie: "bron_specifiek",
  publicatiedatum: "publicatiedatum",
  skills: "bron_specifiek",
  sluitingsdatum: "sluitingsdatum",
  startDatum: "start_datum",
  tariefEenheid: "tarief_eenheid",
  tariefMax: "tarief_max",
  tariefMin: "tarief_min",
  urenPerWeek: "uren_per_week",
} as const satisfies Record<MotianDerivedFieldName, string>;

/** One projection of every repairable derived field, shared by the read,
 * update and rollback statements so they can never drift apart. */
const DERIVED_FIELD_PROJECTION = `
        id::text AS "aanvraagId",
        bron_id::text AS "bronId",
        bron_referentie AS "bronReferentie",
        content_hash AS "contentHash",
        raw_payload_ref AS "rawPayloadRef",
        v1_id AS "v1Id",
        opdrachtgever_naam AS "opdrachtgeverNaam",
        contracttype,
        NULLIF(trim(bron_specifiek->>'opleidingsniveau'), '') AS "opleidingsniveau",
        NULLIF(trim(bron_specifiek->>'provincie'), '') AS "provincie",
        publicatiedatum,
        NULLIF(bron_specifiek->'skills', 'null'::jsonb)::text AS "skills",
        start_datum AS "startDatum",
        sluitingsdatum,
        tarief_eenheid AS "tariefEenheid",
        tarief_max::text AS "tariefMax",
        tarief_min::text AS "tariefMin",
        uren_per_week AS "urenPerWeek"`;

const readCurrentRow = async (
  sql: MotianRepairSql,
  aanvraagId: string,
  forUpdate = false
): Promise<CurrentMotianDerivedFieldRow | null> => {
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  const rows = await sql.unsafe<CurrentMotianDerivedFieldRow[]>(
    `
      SELECT
${DERIVED_FIELD_PROJECTION}
      FROM curated.aanvraag
      WHERE id::text = $1
      LIMIT 1${lockClause}
    `,
    [aanvraagId]
  );
  return rows[0] ?? null;
};

const readAudit = async (
  sql: MotianRepairSql,
  auditId: string
): Promise<StoredAuditRow | null> => {
  const rows = await sql<StoredAuditRow[]>`
    SELECT
      action,
      actor_id AS "actorId",
      audit_class AS "auditClass",
      entity_id AS "entityId",
      entity_type AS "entityType",
      id::text AS id,
      metadata,
      scope_id AS "scopeId"
    FROM curated.audit_event
    WHERE id::text = ${auditId}
    LIMIT 1
  `;
  return rows[0] ?? null;
};

const isCurrentIdentityMatch = (
  current: CurrentMotianDerivedFieldRow,
  binding: MotianDerivedFieldRepairManifestEntry
): boolean =>
  current.aanvraagId === binding.aanvraagId &&
  current.bronId === binding.bronId &&
  current.bronReferentie === binding.bronReferentie &&
  current.contentHash === binding.contentHash &&
  current.rawPayloadRef === binding.rawPayloadRef &&
  current.v1Id === binding.v1Id;

const toFieldImage = (
  row: Pick<
    CurrentMotianDerivedFieldRow,
    | "contracttype"
    | "opdrachtgeverNaam"
    | "opleidingsniveau"
    | "provincie"
    | "publicatiedatum"
    | "skills"
    | "sluitingsdatum"
    | "startDatum"
    | "tariefEenheid"
    | "tariefMax"
    | "tariefMin"
    | "urenPerWeek"
  >
): MotianDerivedFieldRepairAuditFieldImage => ({
  contracttype: row.contracttype,
  opdrachtgeverNaam: row.opdrachtgeverNaam,
  opleidingsniveau: row.opleidingsniveau,
  provincie: row.provincie,
  publicatiedatum: row.publicatiedatum,
  skills: row.skills,
  sluitingsdatum: row.sluitingsdatum?.toISOString() ?? null,
  startDatum: row.startDatum,
  tariefEenheid: row.tariefEenheid,
  tariefMax: row.tariefMax,
  tariefMin: row.tariefMin,
  urenPerWeek: row.urenPerWeek,
});

const toManifestBinding = (
  metadata: MotianDerivedFieldRepairAuditMetadata
): MotianDerivedFieldRepairManifestEntry => ({
  aanvraagId: metadata.aanvraagId,
  bronId: metadata.bronId,
  bronReferentie: metadata.bronReferentie,
  contentHash: metadata.contentHash,
  rawPayloadRef: metadata.rawPayloadRef,
  v1Id: metadata.v1Id,
});

const readRaw = async (input: {
  readonly current: CurrentMotianDerivedFieldRow;
  readonly readRawObject: (
    rawPayloadRef: string
  ) => Promise<RawObjectForMotianRepair | null>;
}): Promise<RawReadResult> => {
  try {
    return { raw: await input.readRawObject(input.current.rawPayloadRef) };
  } catch (error) {
    if (error instanceof RawObjectDigestMismatchError) {
      return { raw: null, reason: "raw_hash_mismatch" };
    }
    return { raw: null, reason: "raw_read_failed" };
  }
};

const configureTransaction = async (
  transaction: postgres.TransactionSql
): Promise<void> => {
  await transaction.unsafe(
    `SET LOCAL statement_timeout = '${MOTIAN_REPAIR_STATEMENT_TIMEOUT_MS}ms'`
  );
  await transaction.unsafe(
    `SET LOCAL lock_timeout = '${MOTIAN_REPAIR_LOCK_TIMEOUT_MS}ms'`
  );
  await transaction.unsafe(
    `SET LOCAL idle_in_transaction_session_timeout = '${MOTIAN_REPAIR_IDLE_TRANSACTION_TIMEOUT_MS}ms'`
  );
};

/** Derived fields that live inside `bron_specifiek` rather than in a column. */
const BRON_SPECIFIEK_TEXT_FIELDS = new Set<MotianDerivedFieldName>([
  "opleidingsniveau",
  "provincie",
]);

const isBronSpecifiekField = (field: MotianDerivedFieldName): boolean =>
  BRON_SPECIFIEK_TEXT_FIELDS.has(field) || field === "skills";

/** One `bron_specifiek` write: a `jsonb_set` when `parameter` is set, else a key delete. */
interface BronSpecifiekOp {
  readonly json: boolean;
  readonly key: string;
  readonly parameter: number | null;
}

/**
 * Folds every `bron_specifiek` write of one statement into a single assignment.
 * Postgres rejects an UPDATE that assigns the same column twice (42701), and
 * every SET expression is evaluated against the pre-update row, so separate
 * `jsonb_set` assignments can neither coexist nor accumulate: they must nest.
 */
const bronSpecifiekAssignment = (ops: readonly BronSpecifiekOp[]): string => {
  let expression = "COALESCE(bron_specifiek, '{}'::jsonb)";
  for (const op of ops) {
    // `::text::jsonb`, not `::jsonb`: a bare jsonb cast makes postgres.js
    // declare the parameter jsonb and JSON-encode the string, storing
    // `"[\"SQL\"]"` instead of `["SQL"]`.
    const value = op.json
      ? `$${op.parameter}::text::jsonb`
      : `to_jsonb($${op.parameter}::text)`;
    expression =
      op.parameter === null
        ? `(${expression} - '${op.key}')`
        : `jsonb_set(${expression}, '{${op.key}}', ${value}, true)`;
  }
  return `bron_specifiek = ${expression}`;
};

const updateDerivedFields = async (input: {
  readonly current: CurrentMotianDerivedFieldRow;
  readonly patch: Readonly<
    Partial<Record<MotianDerivedFieldName, string | Date | null>>
  >;
  readonly transaction: postgres.TransactionSql;
}): Promise<CurrentMotianDerivedFieldRow> => {
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  const bronSpecifiekOps: BronSpecifiekOp[] = [];
  let setTariefValuta = false;
  for (const field of MOTIAN_DERIVED_FIELD_NAMES) {
    const value = input.patch[field];
    if (value === undefined || input.current[field] !== null) {
      continue;
    }
    const rendered = value instanceof Date ? value.toISOString() : value;
    values.push(rendered);
    if (isBronSpecifiekField(field)) {
      bronSpecifiekOps.push({
        json: field === "skills",
        key: field,
        parameter: values.length,
      });
    } else {
      assignments.push(`"${fieldToColumn[field]}" = $${values.length}`);
      if (
        field === "tariefMin" ||
        field === "tariefMax" ||
        field === "tariefEenheid"
      ) {
        setTariefValuta = true;
      }
    }
  }
  if (bronSpecifiekOps.length > 0) {
    assignments.push(bronSpecifiekAssignment(bronSpecifiekOps));
  }
  if (setTariefValuta) {
    assignments.push(`"tarief_valuta" = 'EUR'`);
  }
  if (assignments.length === 0) {
    return input.current;
  }
  values.push(input.current.aanvraagId);
  const rows = await input.transaction.unsafe<CurrentMotianDerivedFieldRow[]>(
    `
      UPDATE curated.aanvraag
      SET ${assignments.join(", ")}
      WHERE id::text = $${values.length}
      RETURNING
${DERIVED_FIELD_PROJECTION}
    `,
    values
  );
  if (rows.length !== 1 || !rows[0]) {
    throw new Error("Derived-field repair update returned no unique row");
  }
  return rows[0];
};

const restoreDerivedFields = async (input: {
  readonly current: CurrentMotianDerivedFieldRow;
  readonly patch: Readonly<
    Partial<Record<MotianDerivedFieldName, string | Date | null>>
  >;
  readonly transaction: postgres.TransactionSql;
}): Promise<CurrentMotianDerivedFieldRow> => {
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  const bronSpecifiekOps: BronSpecifiekOp[] = [];
  for (const field of MOTIAN_DERIVED_FIELD_NAMES) {
    const value = input.patch[field];
    if (value === undefined) {
      continue;
    }
    if (isBronSpecifiekField(field)) {
      if (value === null) {
        bronSpecifiekOps.push({ json: false, key: field, parameter: null });
      } else {
        const rendered = value instanceof Date ? value.toISOString() : value;
        values.push(rendered);
        bronSpecifiekOps.push({
          json: field === "skills",
          key: field,
          parameter: values.length,
        });
      }
      continue;
    }
    const rendered = value instanceof Date ? value.toISOString() : value;
    values.push(rendered);
    assignments.push(`"${fieldToColumn[field]}" = $${values.length}`);
  }
  if (bronSpecifiekOps.length > 0) {
    assignments.push(bronSpecifiekAssignment(bronSpecifiekOps));
  }
  if (assignments.length === 0) {
    return input.current;
  }
  values.push(input.current.aanvraagId);
  const rows = await input.transaction.unsafe<CurrentMotianDerivedFieldRow[]>(
    `
      UPDATE curated.aanvraag
      SET ${assignments.join(", ")}
      WHERE id::text = $${values.length}
      RETURNING
${DERIVED_FIELD_PROJECTION}
    `,
    values
  );
  if (rows.length !== 1 || !rows[0]) {
    throw new Error(
      "Derived-field repair rollback update returned no unique row"
    );
  }
  return rows[0];
};

const insertAudit = async (input: {
  readonly metadata:
    | MotianDerivedFieldRepairAuditMetadata
    | MotianDerivedFieldRepairRollbackAuditMetadata;
  readonly action:
    | typeof MOTIAN_REPAIR_APPLY_ACTION
    | typeof MOTIAN_REPAIR_ROLLBACK_ACTION;
  readonly aanvraagId: string;
  readonly transaction: postgres.TransactionSql;
}): Promise<string> => {
  const metadata = repairMetadataSchema.parse(input.metadata);
  const rows = await input.transaction<[{ id: string }]>`
    INSERT INTO curated.audit_event (
      action,
      actor_id,
      actor_type,
      audit_class,
      entity_id,
      entity_type,
      metadata,
      scope_id
    ) VALUES (
      ${input.action},
      ${MOTIAN_REPAIR_ACTOR_ID},
      'service',
      'effect',
      ${input.aanvraagId},
      'aanvraag',
      ${JSON.stringify(metadata)}::text::jsonb,
      ${MOTIAN_REPAIR_SCOPE_ID}
    )
    RETURNING id::text AS id
  `;
  if (rows.length !== 1 || !rows[0]) {
    throw new Error("Derived-field repair audit insert returned no row");
  }
  return rows[0].id;
};

const insertOutbox = async (input: {
  readonly contentHash: string;
  readonly aanvraagId: string;
  readonly transaction: postgres.TransactionSql;
}): Promise<string> => {
  const rows = await input.transaction<[{ id: string }]>`
    INSERT INTO curated.outbox_event (
      aggregate_id,
      aggregate_type,
      event_type,
      payload
    ) VALUES (
      ${input.aanvraagId},
      'aanvraag',
      ${MOTIAN_REPAIR_EVENT_TYPE},
      ${JSON.stringify({
        content_hash: input.contentHash,
        parser_version: MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
      })}::text::jsonb
    )
    RETURNING id::text AS id
  `;
  if (rows.length !== 1 || !rows[0]) {
    throw new Error("Derived-field repair outbox insert returned no row");
  }
  return rows[0].id;
};

const readExistingApplyAudit = async (
  transaction: postgres.TransactionSql,
  binding: MotianDerivedFieldRepairManifestEntry,
  manifestSha256: string
): Promise<string | null> => {
  const rows = await transaction<[{ id: string }]>`
    SELECT id::text AS id
    FROM curated.audit_event
    WHERE action = ${MOTIAN_REPAIR_APPLY_ACTION}
      AND actor_id = ${MOTIAN_REPAIR_ACTOR_ID}
      AND entity_type = 'aanvraag'
      AND entity_id = ${binding.aanvraagId}
      AND scope_id = ${MOTIAN_REPAIR_SCOPE_ID}
      AND metadata->>'repairVersion' = ${MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION}
      AND metadata->>'manifestSha256' = ${manifestSha256}
      AND metadata->>'v1Id' = ${binding.v1Id}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
};

const readExistingRollbackAudit = async (
  transaction: postgres.TransactionSql,
  auditId: string,
  aanvraagId: string
): Promise<string | null> => {
  const rows = await transaction<[{ id: string }]>`
    SELECT id::text AS id
    FROM curated.audit_event
    WHERE action = ${MOTIAN_REPAIR_ROLLBACK_ACTION}
      AND actor_id = ${MOTIAN_REPAIR_ACTOR_ID}
      AND entity_type = 'aanvraag'
      AND entity_id = ${aanvraagId}
      AND scope_id = ${MOTIAN_REPAIR_SCOPE_ID}
      AND metadata->>'rollbackOfAuditId' = ${auditId}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
};

const createApplyMetadata = (input: {
  readonly after: CurrentMotianDerivedFieldRow;
  readonly before: CurrentMotianDerivedFieldRow;
  readonly changedFields: readonly MotianDerivedFieldName[];
  readonly manifest: MotianDerivedFieldRepairManifestEntry;
  readonly manifestSha256: string;
  readonly sourceAbsentFields: readonly MotianDerivedFieldName[];
}): MotianDerivedFieldRepairAuditMetadata => ({
  aanvraagId: input.manifest.aanvraagId,
  afterimage: toFieldImage(input.after),
  bronId: input.manifest.bronId,
  bronReferentie: input.manifest.bronReferentie,
  changedFields: [...input.changedFields],
  contentHash: input.manifest.contentHash,
  manifestSha256: input.manifestSha256,
  preimage: toFieldImage(input.before),
  rawPayloadRef: input.manifest.rawPayloadRef,
  repairVersion: MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
  sourceAbsentFields: [...input.sourceAbsentFields],
  v1Id: input.manifest.v1Id,
});

const createRollbackMetadata = (input: {
  readonly after: CurrentMotianDerivedFieldRow;
  readonly auditId: string;
  readonly before: CurrentMotianDerivedFieldRow;
  readonly changedFields: readonly MotianDerivedFieldName[];
  readonly original: MotianDerivedFieldRepairAuditMetadata;
}): MotianDerivedFieldRepairRollbackAuditMetadata => ({
  aanvraagId: input.original.aanvraagId,
  afterimage: toFieldImage(input.after),
  bronId: input.original.bronId,
  bronReferentie: input.original.bronReferentie,
  changedFields: [...input.changedFields],
  contentHash: input.original.contentHash,
  manifestSha256: input.original.manifestSha256,
  preimage: toFieldImage(input.before),
  rawPayloadRef: input.original.rawPayloadRef,
  repairVersion: MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION,
  rollbackOfAuditId: input.auditId,
  sourceAbsentFields: [...input.original.sourceAbsentFields],
  v1Id: input.original.v1Id,
});

const fieldValueMatches = (
  field: MotianDerivedFieldName,
  row: CurrentMotianDerivedFieldRow,
  image: MotianDerivedFieldRepairAuditFieldImage
): boolean => {
  if (field === "sluitingsdatum") {
    const expected = image.sluitingsdatum;
    return (
      (row.sluitingsdatum === null && expected === null) ||
      (row.sluitingsdatum !== null &&
        expected !== null &&
        row.sluitingsdatum.toISOString() === expected)
    );
  }
  return row[field] === image[field];
};

const resultForPlan = (
  plan: Awaited<ReturnType<typeof planMotianV1DerivedFieldRepair>>,
  v1Id: string
): MotianRepairApplyResult => {
  if (plan.kind === "rejected") {
    return { reason: plan.reason, status: "rejected", v1Id };
  }
  if (plan.kind === "unchanged") {
    return {
      sourceAbsentFields: plan.sourceAbsentFields,
      status: "unchanged",
      v1Id,
    };
  }
  return {
    changedFields: MOTIAN_DERIVED_FIELD_NAMES.filter(
      (field) => plan.patch[field] !== undefined
    ),
    sourceAbsentFields: plan.sourceAbsentFields,
    status: "applied",
    v1Id,
  };
};

/** Apply one manifest candidate. Raw storage is read before the row lock. */
export const applyMotianV1DerivedFieldRepair = async (input: {
  readonly database: postgres.Sql;
  readonly manifest: MotianDerivedFieldRepairManifestEntry;
  readonly manifestSha256: string;
  readonly readRawObject: (
    rawPayloadRef: string
  ) => Promise<RawObjectForMotianRepair | null>;
}): Promise<MotianRepairApplyResult> => {
  const { database, manifest } = input;
  const current = await readCurrentRow(database, manifest.aanvraagId);
  const candidateValidation =
    validateCurrentMotianV1DerivedFieldRepairCandidate({
      current,
      manifest,
    });
  if (candidateValidation) {
    return {
      reason: candidateValidation.reason,
      status: "rejected",
      v1Id: manifest.v1Id,
    };
  }
  if (!current) {
    return {
      reason: "current_row_missing",
      status: "rejected",
      v1Id: manifest.v1Id,
    };
  }

  // This is deliberately before begin()/FOR UPDATE: S3 latency must never be
  // able to extend the database lock interval.
  const rawResult = await readRaw({
    current,
    readRawObject: input.readRawObject,
  });
  if (rawResult.reason) {
    return {
      reason: rawResult.reason,
      status: "rejected",
      v1Id: manifest.v1Id,
    };
  }
  const { raw } = rawResult;
  if (!raw) {
    return { reason: "raw_missing", status: "rejected", v1Id: manifest.v1Id };
  }

  try {
    return await database.begin(
      "isolation level read committed",
      async (transaction): Promise<MotianRepairApplyResult> => {
        await configureTransaction(transaction);
        const locked = await readCurrentRow(
          transaction,
          manifest.aanvraagId,
          true
        );
        if (!locked) {
          return {
            reason: "current_row_missing",
            status: "rejected",
            v1Id: manifest.v1Id,
          };
        }
        const lockedValidation =
          validateCurrentMotianV1DerivedFieldRepairCandidate({
            current: locked,
            manifest,
          });
        if (lockedValidation) {
          return {
            reason: lockedValidation.reason,
            status: "rejected",
            v1Id: manifest.v1Id,
          };
        }

        const plan = await planMotianV1DerivedFieldRepair({
          current: locked,
          manifest,
          raw,
        });
        if (plan.kind === "rejected") {
          return resultForPlan(plan, manifest.v1Id);
        }

        const existingAuditId = await readExistingApplyAudit(
          transaction,
          manifest,
          input.manifestSha256
        );
        if (existingAuditId) {
          return {
            auditId: existingAuditId,
            status: "unchanged",
            v1Id: manifest.v1Id,
          };
        }
        if (plan.kind === "unchanged") {
          return resultForPlan(plan, manifest.v1Id);
        }

        const patch: Partial<
          Record<MotianDerivedFieldName, string | Date | null>
        > = {};
        for (const field of MOTIAN_DERIVED_FIELD_NAMES) {
          const value = plan.patch[field];
          if (value !== undefined && locked[field] === null) {
            patch[field] = value;
          }
        }
        const changedFields = MOTIAN_DERIVED_FIELD_NAMES.filter(
          (field) => patch[field] !== undefined
        );
        if (changedFields.length === 0) {
          return {
            sourceAbsentFields: plan.sourceAbsentFields,
            status: "unchanged",
            v1Id: manifest.v1Id,
          };
        }
        const updated = await updateDerivedFields({
          current: locked,
          patch,
          transaction,
        });
        const metadata = createApplyMetadata({
          after: updated,
          before: locked,
          changedFields,
          manifest,
          manifestSha256: input.manifestSha256,
          sourceAbsentFields: plan.sourceAbsentFields,
        });
        const auditId = await insertAudit({
          aanvraagId: manifest.aanvraagId,
          action: MOTIAN_REPAIR_APPLY_ACTION,
          metadata,
          transaction,
        });
        const outboxId = await insertOutbox({
          aanvraagId: manifest.aanvraagId,
          contentHash: locked.contentHash,
          transaction,
        });
        return {
          auditId,
          changedFields,
          outboxId,
          sourceAbsentFields: plan.sourceAbsentFields,
          status: "applied",
          v1Id: manifest.v1Id,
        };
      }
    );
  } catch {
    return {
      reason: "transaction_failed",
      status: "rejected",
      v1Id: manifest.v1Id,
    };
  }
};

/** Roll back one repair audit, restoring only fields that still equal its after-image. */
export const rollbackMotianV1DerivedFieldRepair = async (input: {
  readonly auditId: string;
  readonly database: postgres.Sql;
}): Promise<MotianRepairRollbackResult> => {
  const audit = await readAudit(input.database, input.auditId);
  if (!audit) {
    return { reason: "audit_event_missing", status: "rejected" };
  }
  if (
    audit.action !== MOTIAN_REPAIR_APPLY_ACTION ||
    audit.actorId !== MOTIAN_REPAIR_ACTOR_ID ||
    audit.auditClass !== "effect" ||
    audit.entityType !== "aanvraag" ||
    audit.scopeId !== MOTIAN_REPAIR_SCOPE_ID
  ) {
    return { reason: "audit_not_repair", status: "rejected" };
  }
  const parsed = repairAuditMetadataSchema.safeParse(audit.metadata);
  if (!parsed.success) {
    return { reason: "audit_metadata_invalid", status: "rejected" };
  }
  const original = parsed.data;
  if (audit.entityId !== original.aanvraagId) {
    return { reason: "audit_metadata_invalid", status: "rejected" };
  }
  const manifest = toManifestBinding(original);

  try {
    return await input.database.begin(
      "isolation level read committed",
      async (transaction): Promise<MotianRepairRollbackResult> => {
        await configureTransaction(transaction);
        const locked = await readCurrentRow(
          transaction,
          original.aanvraagId,
          true
        );
        if (!locked) {
          return { reason: "current_row_missing", status: "rejected" };
        }
        if (!isCurrentIdentityMatch(locked, manifest)) {
          return { reason: "current_row_mismatch", status: "rejected" };
        }

        const existingRollbackId = await readExistingRollbackAudit(
          transaction,
          input.auditId,
          original.aanvraagId
        );
        if (existingRollbackId) {
          return { auditId: existingRollbackId, status: "unchanged" };
        }

        const restoredFields: MotianDerivedFieldName[] = [];
        const skippedFields: MotianDerivedFieldName[] = [];
        const patch: Partial<
          Record<MotianDerivedFieldName, string | Date | null>
        > = {};
        for (const field of original.changedFields) {
          if (!fieldValueMatches(field, locked, original.afterimage)) {
            skippedFields.push(field);
            continue;
          }
          const value = original.preimage[field];
          if (field === "sluitingsdatum") {
            patch[field] = value === null ? null : new Date(value);
          } else {
            patch[field] = value;
          }
          restoredFields.push(field);
        }
        if (restoredFields.length === 0) {
          return {
            skippedFields,
            status: "unchanged",
          };
        }
        const updated = await restoreDerivedFields({
          current: locked,
          patch,
          transaction,
        });
        const metadata = createRollbackMetadata({
          after: updated,
          auditId: input.auditId,
          before: locked,
          changedFields: restoredFields,
          original,
        });
        const rollbackAuditId = await insertAudit({
          aanvraagId: original.aanvraagId,
          action: MOTIAN_REPAIR_ROLLBACK_ACTION,
          metadata,
          transaction,
        });
        const outboxId = await insertOutbox({
          aanvraagId: original.aanvraagId,
          contentHash: locked.contentHash,
          transaction,
        });
        return {
          auditId: rollbackAuditId,
          outboxId,
          restoredFields,
          skippedFields,
          status: "rolled_back",
        };
      }
    );
  } catch {
    return { reason: "rollback_transaction_failed", status: "rejected" };
  }
};
