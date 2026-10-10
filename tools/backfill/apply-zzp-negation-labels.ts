/**
 * CTP-491 bounded correction for stored Freelance labels.
 *
 * The report tool (`report-zzp-negation-labels.ts`) finds curated aanvragen
 * labelled `freelance` whose own text refuses freelance work. This tool
 * corrects them, one explicitly approved row at a time.
 *
 * It is modelled on the RJC-394 repair lane and carries the same guarantees:
 * an explicit reviewed manifest, a quiescence acknowledgement, a re-read under
 * a row lock, one audit event and one `aanvraag.gewijzigd` outbox event per
 * changed row, and a rollback keyed on the audit event it wrote.
 *
 * Default mode is a dry run. Nothing is written without `--apply`.
 *
 * Output carries counts, row ids and reason codes only. Vacancy text, the
 * opdrachtgever, URLs and credentials never appear in it.
 */

import {
  classifyContractAndWork,
  matchFreelanceExclusion,
} from "@ji/application/normalise";
import type {
  ZzpNegationLabelAuditMetadata,
  ZzpNegationLabelBronAliasImage,
  ZzpNegationLabelRollbackAuditMetadata,
} from "@ji/application/registry";
import postgres from "postgres";
import { z } from "zod";

export const ZZP_NEGATION_APPLY_VERSION =
  "zzp-negation-label-apply/v1" as const;
export const ZZP_NEGATION_SCOPE_ID = "catapulze" as const;
export const ZZP_NEGATION_ACTOR_ID = "zzp-negation-label-apply" as const;
export const ZZP_NEGATION_APPLY_ACTION = "zzp_negation_label_apply" as const;
export const ZZP_NEGATION_ROLLBACK_ACTION =
  "zzp_negation_label_apply_rollback" as const;
export const ZZP_NEGATION_EVENT_TYPE = "aanvraag.gewijzigd" as const;

/** The label this lane exists to correct. Nothing else is ever touched. */
const CORRECTABLE_CONTRACTTYPE = "freelance" as const;
export const MAX_MANIFEST_ENTRIES = 100;
/**
 * The audit cap. A justification belongs in an audit event; a copy of the
 * vacancy does not. The manifest accepts whatever the report emits, because a
 * coordinated list can legitimately run past this, and the writer records
 * `matchedPhraseTruncated` when it had to cut.
 */
export const MAX_MATCHED_PHRASE_LENGTH = 200;

/**
 * The `bron_specifiek` keys `readAanvraagBronFacts` falls back to when the
 * promoted `contracttype` column is null. Clearing the column alone would let
 * these resurface the very label being corrected.
 */
export const BRON_CONTRACTTYPE_ALIASES = [
  "contracttype",
  "contract_type",
] as const;

export type BronContracttypeAlias = (typeof BRON_CONTRACTTYPE_ALIASES)[number];

/**
 * Alias values that would still read as freelance after the correction, either
 * through the API allowlist or the raw search document. Any other value names a
 * different contract form, and this lane has no evidence against it.
 */
const FREELANCE_FALLBACK_VALUES = new Set([
  "freelance",
  "freelancer",
  "freelancers",
  "zzp",
  "zzp'er",
  "zzp'ers",
  "zzp\u2019er",
  "zzp\u2019ers",
]);

/** Keep the transaction short enough that a stalled row cannot hold a lock indefinitely. */
export const ZZP_NEGATION_STATEMENT_TIMEOUT_MS = 15_000;
export const ZZP_NEGATION_LOCK_TIMEOUT_MS = 2000;
export const ZZP_NEGATION_IDLE_TRANSACTION_TIMEOUT_MS = 20_000;

export const isFreelanceFallback = (
  value: string | null | undefined
): value is string =>
  value !== null &&
  value !== undefined &&
  FREELANCE_FALLBACK_VALUES.has(value.trim().toLowerCase());

/**
 * Parses the two alias keys out of the curated JSON column, the same way
 * `readAanvraagBronFacts` does. Every other key in the column is dropped here
 * and never written back. A column that is not an object yields no aliases;
 * malformed aliases are ignored independently so a valid sibling can still be
 * corrected.
 */
const sourceTextSchema = z
  .string()
  .refine((value) => value.trim() !== "")
  .nullable()
  .optional()
  // oxlint-disable-next-line promise/prefer-await-to-then -- Zod's synchronous fallback API, not Promise.catch
  .catch(null);

const bronAliasReadSchema = z
  .object({
    contract_type: sourceTextSchema,
    contracttype: sourceTextSchema,
  })
  // oxlint-disable-next-line promise/prefer-await-to-then -- Zod's synchronous fallback API, not Promise.catch
  .catch({});
const bronSpecifiekObjectSchema = z.record(z.string(), z.unknown());

/**
 * The alias keys that currently hold a freelance value, with those values.
 * An alias naming a different contract form is left alone: this lane has
 * evidence against freelance and none against detachering.
 */
/** The image under construction; the exported shape is readonly. */
interface MutableBronAliasImage {
  contract_type?: string;
  contracttype?: string;
}

export const readFreelanceAliases = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- curated JSON I/O boundary, parsed by bronAliasReadSchema before field access
  bronSpecifiek: unknown
): ZzpNegationLabelBronAliasImage => {
  const parsed = bronAliasReadSchema.parse(bronSpecifiek);
  const image: MutableBronAliasImage = {};
  if (isFreelanceFallback(parsed.contract_type)) {
    image.contract_type = parsed.contract_type;
  }
  if (isFreelanceFallback(parsed.contracttype)) {
    image.contracttype = parsed.contracttype;
  }
  return image;
};

/**
 * Checks raw JSON shape and key presence, rather than parsing values. A
 * foreign writer can repopulate an alias with null or a non-string while
 * leaving the hash and promoted column unchanged; either value still makes
 * the row unsafe to restore because `restoreContracttype` would overwrite
 * that key. An unknown JSON shape is also unsafe when there is an alias to
 * restore, because merging into it could discard data this lane cannot read.
 */
export const hasRestorableAliasConflict = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- raw JSON key-presence check at the database boundary
  bronSpecifiek: unknown,
  restoredAliases: ZzpNegationLabelBronAliasImage
): boolean => {
  const restoredKeys = Object.keys(restoredAliases);
  if (restoredKeys.length === 0) {
    return false;
  }
  const parsed = bronSpecifiekObjectSchema.safeParse(bronSpecifiek);
  if (!parsed.success) {
    return true;
  }
  return restoredKeys.some((key) => Object.hasOwn(parsed.data, key));
};

export type ZzpNegationOperation = "apply" | "report" | "rollback";

export interface CliArguments {
  readonly auditId?: string;
  readonly ingestQuiesced: boolean;
  readonly limit?: number;
  readonly manifestPath?: string;
  readonly operation: ZzpNegationOperation;
}

export type ZzpNegationApplyReason =
  | "already_rolled_back"
  | "classifier_still_freelance"
  | "contracttype_not_freelance"
  | "current_row_missing"
  | "text_no_longer_excludes"
  | "transaction_failed"
  | "versie_mismatch";

export type ZzpNegationRollbackReason =
  | "audit_event_missing"
  | "audit_metadata_invalid"
  | "audit_not_apply"
  | "content_hash_mismatch"
  | "current_row_missing"
  | "current_row_mismatch"
  | "rollback_transaction_failed"
  | "versie_mismatch";

export interface ZzpNegationApplyResult {
  readonly aanvraagId: string;
  readonly auditId?: string;
  readonly outboxId?: string;
  readonly reason?: ZzpNegationApplyReason;
  readonly status: "applied" | "rejected" | "unchanged" | "would_apply";
}

export interface ZzpNegationRollbackResult {
  readonly aanvraagId?: string;
  readonly auditId?: string;
  readonly outboxId?: string;
  readonly reason?: ZzpNegationRollbackReason;
  readonly status: "rejected" | "rolled_back" | "unchanged";
}

export interface CurrentAanvraagRow {
  readonly aanvraagId: string;
  readonly beschrijving: string;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- curated JSON column, read through readBronAliases
  readonly bronSpecifiek: unknown;
  readonly contentHash: string;
  readonly contracttype: string | null;
  readonly titel: string;
  readonly versie: number;
}

const manifestCandidateSchema = z
  .object({
    bron: z.string().trim().min(1),
    id: z.string().uuid(),
    matchedPhrase: z.string().trim().min(1),
    titel: z.string(),
    versie: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Accepts the report tool's own output. Its summary keys are ignored rather
 * than rejected, so an operator can approve a report file by deleting the rows
 * that should not be corrected and passing the rest straight back in.
 */
const manifestSchema = z.object({
  candidates: z.array(manifestCandidateSchema).min(1).max(MAX_MANIFEST_ENTRIES),
});

export type ZzpNegationManifest = z.infer<typeof manifestSchema>;
export type ZzpNegationManifestEntry = z.infer<typeof manifestCandidateSchema>;

export const parseManifest = (body: Uint8Array): ZzpNegationManifest => {
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder().decode(body))
  );
  const uniqueIds = new Set(manifest.candidates.map((entry) => entry.id));
  if (uniqueIds.size !== manifest.candidates.length) {
    throw new Error("Manifest must not contain duplicate aanvraag ids");
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

export const parseArguments = (arguments_: readonly string[]): CliArguments => {
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
  return {
    ingestQuiesced,
    limit,
    manifestPath: readValue(values, "--manifest"),
    operation: apply ? "apply" : "report",
  };
};

export interface CorrectionPlan {
  readonly kind: "correct" | "rejected";
  readonly matchedPhrase?: string;
  readonly nextContracttype?: string | null;
  readonly reason?: ZzpNegationApplyReason;
}

/**
 * Decides what to do with one row, from the row as it is right now.
 *
 * Nothing here trusts the manifest beyond using it to bind the row: the label
 * must still be the one this lane corrects, the versie must still match what
 * the operator reviewed, and the CURRENT text must still refuse freelance
 * work. A row whose text has since changed is rejected, never patched.
 */
export const planCorrection = (input: {
  readonly current: CurrentAanvraagRow | null;
  readonly manifest: ZzpNegationManifestEntry;
}): CorrectionPlan => {
  const { current, manifest } = input;
  if (!current || current.aanvraagId !== manifest.id) {
    return { kind: "rejected", reason: "current_row_missing" };
  }
  if (current.contracttype !== CORRECTABLE_CONTRACTTYPE) {
    return { kind: "rejected", reason: "contracttype_not_freelance" };
  }
  if (current.versie !== manifest.versie) {
    return { kind: "rejected", reason: "versie_mismatch" };
  }
  const text = `${current.titel}\n${current.beschrijving}`;
  const matchedPhrase = matchFreelanceExclusion(text);
  if (matchedPhrase === null) {
    return { kind: "rejected", reason: "text_no_longer_excludes" };
  }
  const nextContracttype = classifyContractAndWork(
    current.titel,
    current.beschrijving
  ).contracttype;
  if (nextContracttype === CORRECTABLE_CONTRACTTYPE) {
    return { kind: "rejected", reason: "classifier_still_freelance" };
  }
  return {
    kind: "correct",
    matchedPhrase,
    nextContracttype,
  };
};

type ZzpNegationSql = postgres.Sql | postgres.TransactionSql;

const bronAliasImageSchema = z
  .object({
    contract_type: z.string().optional(),
    contracttype: z.string().optional(),
  })
  .strict();

const auditImageSchema = z
  .object({
    bronSpecifiek: bronAliasImageSchema,
    contracttype: z.string().nullable(),
  })
  .strict();

const applyAuditMetadataSchema = z
  .object({
    aanvraagId: z.string().min(1),
    afterimage: auditImageSchema,
    applyVersion: z.literal(ZZP_NEGATION_APPLY_VERSION),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    matchedPhrase: z.string().min(1).max(MAX_MATCHED_PHRASE_LENGTH),
    matchedPhraseTruncated: z.boolean(),
    preimage: auditImageSchema,
    versie: z.number().int().nonnegative(),
  })
  .strict();

const rollbackAuditMetadataSchema = applyAuditMetadataSchema
  .extend({ rollbackOfAuditId: z.string().min(1) })
  .strict();

const auditMetadataSchema = z.union([
  applyAuditMetadataSchema,
  rollbackAuditMetadataSchema,
]);

interface StoredAuditRow {
  readonly action: string;
  readonly actorId: string | null;
  readonly auditClass: string | null;
  readonly entityId: string;
  readonly entityType: string;
  readonly id: string;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- audit JSON column, parsed by applyAuditMetadataSchema
  readonly metadata: unknown;
  readonly scopeId: string | null;
}

const readCurrentRow = async (
  sql: ZzpNegationSql,
  aanvraagId: string,
  forUpdate = false
): Promise<CurrentAanvraagRow | null> => {
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  const rows = await sql.unsafe<CurrentAanvraagRow[]>(
    `
      SELECT
        id::text AS "aanvraagId",
        titel AS "titel",
        beschrijving AS "beschrijving",
        bron_specifiek AS "bronSpecifiek",
        contracttype,
        content_hash AS "contentHash",
        versie
      FROM curated.aanvraag
      WHERE id::text = $1
      LIMIT 1${lockClause}
    `,
    [aanvraagId]
  );
  return rows[0] ?? null;
};

const readAudit = async (
  sql: ZzpNegationSql,
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

const configureTransaction = async (
  transaction: postgres.TransactionSql
): Promise<void> => {
  await transaction.unsafe(
    `SET LOCAL statement_timeout = '${ZZP_NEGATION_STATEMENT_TIMEOUT_MS}ms'`
  );
  await transaction.unsafe(
    `SET LOCAL lock_timeout = '${ZZP_NEGATION_LOCK_TIMEOUT_MS}ms'`
  );
  await transaction.unsafe(
    `SET LOCAL idle_in_transaction_session_timeout = '${ZZP_NEGATION_IDLE_TRANSACTION_TIMEOUT_MS}ms'`
  );
};

const clearContracttype = async (input: {
  readonly aanvraagId: string;
  readonly removedAliases: ZzpNegationLabelBronAliasImage;
  readonly transaction: postgres.TransactionSql;
  readonly value: string | null;
}): Promise<void> => {
  // `- text[]` drops the alias keys; everything else in bron_specifiek stays.
  const aliasKeys = Object.keys(input.removedAliases);
  const rows = await input.transaction<{ id: string }[]>`
    UPDATE curated.aanvraag
    SET contracttype = ${input.value},
        bron_specifiek = bron_specifiek - ${aliasKeys}::text[]
    WHERE id::text = ${input.aanvraagId}
    RETURNING id::text AS id
  `;
  if (rows.length !== 1) {
    throw new Error("Freelance-label correction updated no unique row");
  }
};

const restoreContracttype = async (input: {
  readonly aanvraagId: string;
  readonly restoredAliases: ZzpNegationLabelBronAliasImage;
  readonly transaction: postgres.TransactionSql;
  readonly value: string | null;
}): Promise<void> => {
  const restoredKeys = Object.keys(input.restoredAliases);
  // Do not evaluate a JSONB merge for an empty preimage. Legacy rows can hold
  // scalar or array JSON, and `jsonb || '{}'` changes an array's shape even
  // though this rollback has no alias to restore.
  const rows =
    restoredKeys.length === 0
      ? await input.transaction<{ id: string }[]>`
          UPDATE curated.aanvraag
          SET contracttype = ${input.value}
          WHERE id::text = ${input.aanvraagId}
          RETURNING id::text AS id
        `
      : await input.transaction<{ id: string }[]>`
          UPDATE curated.aanvraag
          SET contracttype = ${input.value},
              bron_specifiek = bron_specifiek || ${JSON.stringify(
                input.restoredAliases
              )}::text::jsonb
          WHERE id::text = ${input.aanvraagId}
          RETURNING id::text AS id
        `;
  if (rows.length !== 1) {
    throw new Error("Freelance-label rollback updated no unique row");
  }
};

const insertAudit = async (input: {
  readonly aanvraagId: string;
  readonly action:
    | typeof ZZP_NEGATION_APPLY_ACTION
    | typeof ZZP_NEGATION_ROLLBACK_ACTION;
  readonly metadata:
    | ZzpNegationLabelAuditMetadata
    | ZzpNegationLabelRollbackAuditMetadata;
  readonly transaction: postgres.TransactionSql;
}): Promise<string> => {
  const metadata = auditMetadataSchema.parse(input.metadata);
  const rows = await input.transaction<{ id: string }[]>`
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
      ${ZZP_NEGATION_ACTOR_ID},
      'service',
      'effect',
      ${input.aanvraagId},
      'aanvraag',
      ${JSON.stringify(metadata)}::text::jsonb,
      ${ZZP_NEGATION_SCOPE_ID}
    )
    RETURNING id::text AS id
  `;
  const id = rows[0]?.id;
  if (rows.length !== 1 || !id) {
    throw new Error("Freelance-label correction audit insert returned no row");
  }
  return id;
};

const insertOutbox = async (input: {
  readonly aanvraagId: string;
  readonly contentHash: string;
  readonly transaction: postgres.TransactionSql;
}): Promise<string> => {
  const rows = await input.transaction<{ id: string }[]>`
    INSERT INTO curated.outbox_event (
      aggregate_id,
      aggregate_type,
      event_type,
      payload
    ) VALUES (
      ${input.aanvraagId},
      'aanvraag',
      ${ZZP_NEGATION_EVENT_TYPE},
      ${JSON.stringify({
        content_hash: input.contentHash,
        parser_version: ZZP_NEGATION_APPLY_VERSION,
      })}::text::jsonb
    )
    RETURNING id::text AS id
  `;
  const id = rows[0]?.id;
  if (rows.length !== 1 || !id) {
    throw new Error("Freelance-label correction outbox insert returned no row");
  }
  return id;
};

const readExistingApplyAudit = async (
  transaction: postgres.TransactionSql,
  aanvraagId: string,
  manifestSha256: string
): Promise<string | null> => {
  const rows = await transaction<{ id: string }[]>`
    SELECT applied.id::text AS id
    FROM curated.audit_event AS applied
    WHERE applied.action = ${ZZP_NEGATION_APPLY_ACTION}
      AND applied.actor_id = ${ZZP_NEGATION_ACTOR_ID}
      AND applied.entity_type = 'aanvraag'
      AND applied.entity_id = ${aanvraagId}
      AND applied.scope_id = ${ZZP_NEGATION_SCOPE_ID}
      AND applied.metadata->>'applyVersion' = ${ZZP_NEGATION_APPLY_VERSION}
      AND applied.metadata->>'manifestSha256' = ${manifestSha256}
      AND NOT EXISTS (
        SELECT 1
        FROM curated.audit_event AS reversed
        WHERE reversed.action = ${ZZP_NEGATION_ROLLBACK_ACTION}
          AND reversed.actor_id = ${ZZP_NEGATION_ACTOR_ID}
          AND reversed.entity_type = 'aanvraag'
          AND reversed.entity_id = applied.entity_id
          AND reversed.scope_id = ${ZZP_NEGATION_SCOPE_ID}
          AND reversed.metadata->>'rollbackOfAuditId' = applied.id::text
      )
    ORDER BY applied.created_at ASC, applied.id ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
};

const readExistingRollbackAudit = async (
  transaction: postgres.TransactionSql,
  auditId: string,
  aanvraagId: string
): Promise<string | null> => {
  const rows = await transaction<{ id: string }[]>`
    SELECT id::text AS id
    FROM curated.audit_event
    WHERE action = ${ZZP_NEGATION_ROLLBACK_ACTION}
      AND actor_id = ${ZZP_NEGATION_ACTOR_ID}
      AND entity_type = 'aanvraag'
      AND entity_id = ${aanvraagId}
      AND scope_id = ${ZZP_NEGATION_SCOPE_ID}
      AND metadata->>'rollbackOfAuditId' = ${auditId}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
};

/** Correct one approved row. The whole decision is retaken under the lock. */
export const applyZzpNegationLabel = async (input: {
  readonly database: postgres.Sql;
  readonly manifest: ZzpNegationManifestEntry;
  readonly manifestSha256: string;
}): Promise<ZzpNegationApplyResult> => {
  const { manifest } = input;
  try {
    return await input.database.begin(
      "isolation level read committed",
      async (transaction): Promise<ZzpNegationApplyResult> => {
        await configureTransaction(transaction);
        const locked = await readCurrentRow(transaction, manifest.id, true);
        if (!locked) {
          return {
            aanvraagId: manifest.id,
            reason: "current_row_missing",
            status: "rejected",
          };
        }

        // Before planning, not after. A correction makes its own row stop
        // qualifying, so replaying the same manifest would otherwise be
        // rejected as "not freelance" rather than recognised as already done.
        const existingAuditId = await readExistingApplyAudit(
          transaction,
          manifest.id,
          input.manifestSha256
        );
        if (existingAuditId) {
          return {
            aanvraagId: manifest.id,
            auditId: existingAuditId,
            status: "unchanged",
          };
        }

        const plan = planCorrection({ current: locked, manifest });
        if (plan.kind === "rejected") {
          return {
            aanvraagId: manifest.id,
            reason: plan.reason ?? "current_row_missing",
            status: "rejected",
          };
        }

        const nextContracttype = plan.nextContracttype ?? null;
        const removedAliases = readFreelanceAliases(locked.bronSpecifiek);
        await clearContracttype({
          aanvraagId: manifest.id,
          removedAliases,
          transaction,
          value: nextContracttype,
        });
        const matchedPhrase = plan.matchedPhrase ?? "";
        const metadata: ZzpNegationLabelAuditMetadata = {
          aanvraagId: manifest.id,
          afterimage: { bronSpecifiek: {}, contracttype: nextContracttype },
          applyVersion: ZZP_NEGATION_APPLY_VERSION,
          contentHash: locked.contentHash,
          manifestSha256: input.manifestSha256,
          matchedPhrase: matchedPhrase.slice(0, MAX_MATCHED_PHRASE_LENGTH),
          matchedPhraseTruncated:
            matchedPhrase.length > MAX_MATCHED_PHRASE_LENGTH,
          preimage: {
            bronSpecifiek: removedAliases,
            contracttype: locked.contracttype,
          },
          versie: locked.versie,
        };
        const auditId = await insertAudit({
          aanvraagId: manifest.id,
          action: ZZP_NEGATION_APPLY_ACTION,
          metadata,
          transaction,
        });
        const outboxId = await insertOutbox({
          aanvraagId: manifest.id,
          contentHash: locked.contentHash,
          transaction,
        });
        return {
          aanvraagId: manifest.id,
          auditId,
          outboxId,
          status: "applied",
        };
      }
    );
  } catch {
    return {
      aanvraagId: manifest.id,
      reason: "transaction_failed",
      status: "rejected",
    };
  }
};

/**
 * Restore the previous label for one apply audit event.
 *
 * Only rows this tool changed and has not changed since: the content hash must
 * still match what was recorded, the label must still equal the after-image,
 * and every alias key removed by the apply must still be absent. Otherwise
 * something else has written the row and the rollback is not ours to make.
 */
export const rollbackZzpNegationLabel = async (input: {
  readonly auditId: string;
  readonly database: postgres.Sql;
}): Promise<ZzpNegationRollbackResult> => {
  const audit = await readAudit(input.database, input.auditId);
  if (!audit) {
    return { reason: "audit_event_missing", status: "rejected" };
  }
  if (
    audit.action !== ZZP_NEGATION_APPLY_ACTION ||
    audit.actorId !== ZZP_NEGATION_ACTOR_ID ||
    audit.auditClass !== "effect" ||
    audit.entityType !== "aanvraag" ||
    audit.scopeId !== ZZP_NEGATION_SCOPE_ID
  ) {
    return { reason: "audit_not_apply", status: "rejected" };
  }
  const parsed = applyAuditMetadataSchema.safeParse(audit.metadata);
  if (!parsed.success) {
    return { reason: "audit_metadata_invalid", status: "rejected" };
  }
  const original = parsed.data;
  if (audit.entityId !== original.aanvraagId) {
    return { reason: "audit_metadata_invalid", status: "rejected" };
  }

  try {
    return await input.database.begin(
      "isolation level read committed",
      async (transaction): Promise<ZzpNegationRollbackResult> => {
        await configureTransaction(transaction);
        const locked = await readCurrentRow(
          transaction,
          original.aanvraagId,
          true
        );
        if (!locked) {
          return { reason: "current_row_missing", status: "rejected" };
        }
        // Before the value checks, for the same reason apply checks its audit
        // first: a completed rollback restores the pre-image, which no longer
        // equals the after-image it is compared against.
        const existingRollbackId = await readExistingRollbackAudit(
          transaction,
          input.auditId,
          original.aanvraagId
        );
        if (existingRollbackId) {
          return {
            aanvraagId: original.aanvraagId,
            auditId: existingRollbackId,
            status: "unchanged",
          };
        }

        if (locked.versie !== original.versie) {
          return {
            aanvraagId: original.aanvraagId,
            reason: "versie_mismatch",
            status: "rejected",
          };
        }

        if (locked.contentHash !== original.contentHash) {
          return {
            aanvraagId: original.aanvraagId,
            reason: "content_hash_mismatch",
            status: "rejected",
          };
        }
        if (locked.contracttype !== original.afterimage.contracttype) {
          return {
            aanvraagId: original.aanvraagId,
            reason: "current_row_mismatch",
            status: "rejected",
          };
        }
        if (
          hasRestorableAliasConflict(
            locked.bronSpecifiek,
            original.preimage.bronSpecifiek
          )
        ) {
          return {
            aanvraagId: original.aanvraagId,
            reason: "current_row_mismatch",
            status: "rejected",
          };
        }

        await restoreContracttype({
          aanvraagId: original.aanvraagId,
          restoredAliases: original.preimage.bronSpecifiek,
          transaction,
          value: original.preimage.contracttype,
        });
        const metadata: ZzpNegationLabelRollbackAuditMetadata = {
          ...original,
          afterimage: original.preimage,
          preimage: original.afterimage,
          rollbackOfAuditId: input.auditId,
        };
        const rollbackAuditId = await insertAudit({
          aanvraagId: original.aanvraagId,
          action: ZZP_NEGATION_ROLLBACK_ACTION,
          metadata,
          transaction,
        });
        const outboxId = await insertOutbox({
          aanvraagId: original.aanvraagId,
          contentHash: locked.contentHash,
          transaction,
        });
        return {
          aanvraagId: original.aanvraagId,
          auditId: rollbackAuditId,
          outboxId,
          status: "rolled_back",
        };
      }
    );
  } catch {
    return { reason: "rollback_transaction_failed", status: "rejected" };
  }
};

export interface ZzpNegationApplyReport {
  readonly applied: number;
  readonly candidates: readonly ZzpNegationApplyResult[];
  readonly manifestSha256: string;
  readonly applyVersion: typeof ZZP_NEGATION_APPLY_VERSION;
  readonly projectionEventsRequired: number;
  readonly rejected: Partial<Record<ZzpNegationApplyReason, number>>;
  readonly selected: number;
  readonly unchanged: number;
  readonly wouldApply: number;
}

export const summariseResults = (input: {
  readonly manifestSha256: string;
  readonly results: readonly ZzpNegationApplyResult[];
}): ZzpNegationApplyReport => {
  const rejected: Partial<Record<ZzpNegationApplyReason, number>> = {};
  let applied = 0;
  let unchanged = 0;
  let wouldApply = 0;
  for (const result of input.results) {
    if (result.status === "applied") {
      applied += 1;
    } else if (result.status === "unchanged") {
      unchanged += 1;
    } else if (result.status === "would_apply") {
      wouldApply += 1;
    } else if (result.reason) {
      rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
    }
  }
  return {
    applied,
    applyVersion: ZZP_NEGATION_APPLY_VERSION,
    candidates: input.results,
    manifestSha256: input.manifestSha256,
    projectionEventsRequired: applied,
    rejected,
    selected: input.results.length,
    unchanged,
    wouldApply,
  };
};

const hashBody = async (body: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(body));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Strips any `scheme://user:password@` prefix from a message before it is
 * printed. A driver error can quote the connection string it failed on, and
 * this tool's output is meant to be safe to paste into a ticket.
 */
export const redactCredentials = (text: string): string =>
  text.replaceAll(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/giu, "<redacted>@");

const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
};

const createDatabase = (readOnly: boolean): postgres.Sql =>
  postgres(requireDatabaseUrl(), {
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: readOnly,
      statement_timeout: ZZP_NEGATION_STATEMENT_TIMEOUT_MS,
    },
    idle_timeout: 20,
    max: 1,
    max_lifetime: null,
  });

const requireWithinLimit = (
  manifest: ZzpNegationManifest,
  limit: number
): void => {
  if (manifest.candidates.length > limit) {
    throw new Error(
      "Manifest candidate count exceeds --limit; create an explicit smaller manifest"
    );
  }
};

/** Dry run. One snapshot, no locks, no writes. */
export const runReport = async (input: {
  readonly limit: number;
  readonly manifest: ZzpNegationManifest;
  readonly manifestSha256: string;
}): Promise<ZzpNegationApplyReport> => {
  requireWithinLimit(input.manifest, input.limit);
  const database = createDatabase(true);
  const results: ZzpNegationApplyResult[] = [];
  try {
    await database.begin(
      "isolation level repeatable read read only",
      async (readOnlySql) => {
        for (const manifestEntry of input.manifest.candidates) {
          /* oxlint-disable no-await-in-loop -- each approved row is read deterministically */
          const current = await readCurrentRow(readOnlySql, manifestEntry.id);
          /* oxlint-enable no-await-in-loop */
          const plan = planCorrection({ current, manifest: manifestEntry });
          results.push(
            plan.kind === "correct"
              ? { aanvraagId: manifestEntry.id, status: "would_apply" }
              : {
                  aanvraagId: manifestEntry.id,
                  reason: plan.reason,
                  status: "rejected",
                }
          );
        }
      }
    );
  } finally {
    await database.end({ timeout: 5 });
  }
  return summariseResults({
    manifestSha256: input.manifestSha256,
    results,
  });
};

export const runApply = async (input: {
  readonly limit: number;
  readonly manifest: ZzpNegationManifest;
  readonly manifestSha256: string;
}): Promise<ZzpNegationApplyReport> => {
  requireWithinLimit(input.manifest, input.limit);
  const database = createDatabase(false);
  const results: ZzpNegationApplyResult[] = [];
  try {
    for (const manifestEntry of input.manifest.candidates) {
      /* oxlint-disable no-await-in-loop -- the row lock and bounded transaction are per approved candidate */
      results.push(
        await applyZzpNegationLabel({
          database,
          manifest: manifestEntry,
          manifestSha256: input.manifestSha256,
        })
      );
      /* oxlint-enable no-await-in-loop */
    }
  } finally {
    await database.end({ timeout: 5 });
  }
  return summariseResults({
    manifestSha256: input.manifestSha256,
    results,
  });
};

export const runRollback = async (input: {
  readonly auditId: string;
}): Promise<{
  readonly applyVersion: typeof ZZP_NEGATION_APPLY_VERSION;
  readonly auditId: string;
  readonly result: ZzpNegationRollbackResult;
}> => {
  const database = createDatabase(false);
  let result: ZzpNegationRollbackResult;
  try {
    result = await rollbackZzpNegationLabel({
      auditId: input.auditId,
      database,
    });
  } catch {
    result = { reason: "rollback_transaction_failed", status: "rejected" };
  } finally {
    await database.end({ timeout: 5 });
  }
  return {
    applyVersion: ZZP_NEGATION_APPLY_VERSION,
    auditId: input.auditId,
    result,
  };
};

const loadManifest = async (
  manifestPath: string
): Promise<{
  readonly manifest: ZzpNegationManifest;
  readonly manifestSha256: string;
}> => {
  const body = new Uint8Array(await Bun.file(manifestPath).arrayBuffer());
  return {
    manifest: parseManifest(body),
    manifestSha256: await hashBody(body),
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
    throw new Error("Correction arguments were incomplete");
  }
  const { manifest, manifestSha256 } = await loadManifest(
    arguments_.manifestPath
  );
  const run = arguments_.operation === "apply" ? runApply : runReport;
  console.log(
    JSON.stringify(
      await run({ limit: arguments_.limit, manifest, manifestSha256 }),
      null,
      2
    )
  );
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error
            ? {
                message: redactCredentials(error.message),
                name: error.name,
              }
            : {
                message: redactCredentials(String(error)),
                name: "UnknownError",
              },
        reason: "command_failed",
        status: "error",
      })
    );
    process.exitCode = 1;
  }
}
