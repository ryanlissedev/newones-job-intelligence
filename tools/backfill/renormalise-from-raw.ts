/**
 * Generic stored-raw re-normalise CLI (CTP-597 / CTP-535 residual).
 *
 * Report mode is default. `--apply` requires `--ingest-quiesced`.
 * Per patched row: UPDATE curated.aanvraag + audit_event + outbox aanvraag.gewijzigd
 * (Motian HIST_MIG pattern). Never invents Hero/Pro-Act provincie/skills when
 * the tip draft leaves them absent.
 */
import type { NormalisedAanvraagDraft } from "@ji/application/normalise";
import {
  isSupportedBronSlug,
  SOURCES,
  SUPPORTED_BRON_SLUGS,
} from "@ji/application/sources";
import type { SupportedBronSlug } from "@ji/application/sources";
import { hashContent, RawObjectDigestMismatchError } from "@ji/connectors";
import { createRawObjectStore } from "@ji/connectors/s3-object-client";
import { CLEARED, UNKNOWN } from "@ji/domain";
import postgres from "postgres";
import { z } from "zod";

export const RENORMALISE_VERSION = "renormalise-from-raw/v1" as const;
export const RENORMALISE_SCOPE_ID = "catapulze" as const;
export const RENORMALISE_ACTOR_ID = "renormalise-from-raw" as const;
export const RENORMALISE_APPLY_ACTION = "renormalise_from_raw" as const;
export const RENORMALISE_EVENT_TYPE = "aanvraag.gewijzigd" as const;

export const RENORMALISE_STATEMENT_TIMEOUT_MS = 15_000;
export const RENORMALISE_LOCK_TIMEOUT_MS = 2000;
export const RENORMALISE_IDLE_TRANSACTION_TIMEOUT_MS = 20_000;

export type RenormaliseOperation = "apply" | "report";

export interface RenormaliseCliArguments {
  readonly bronSlugs: readonly SupportedBronSlug[];
  readonly ingestQuiesced: boolean;
  readonly limit?: number;
  readonly operation: RenormaliseOperation;
}

const valueFlags = new Set(["--bron", "--limit"]);
const booleanFlags = new Set(["--apply", "--ingest-quiesced"]);

const bronSpecifiekValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const bronSpecifiekRecordSchema = z.record(
  z.string(),
  bronSpecifiekValueSchema
);

type BronSpecifiekRecord = z.infer<typeof bronSpecifiekRecordSchema>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- curated JSON I/O boundary, parsed by bronSpecifiekRecordSchema
const asBronSpecifiekRecord = (value: unknown): BronSpecifiekRecord => {
  const parsed = bronSpecifiekRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
};

const readOptions = (
  arguments_: readonly string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>
) => {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    if (
      !argument ||
      (!valueOptions.has(argument) && !booleanOptions.has(argument))
    ) {
      throw new Error(`Unsupported option ${argument ?? ""}`);
    }
    if (booleanOptions.has(argument)) {
      if (booleans.has(argument)) {
        throw new Error(`Duplicate option ${argument}`);
      }
      booleans.add(argument);
      continue;
    }
    const value = normalized[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    const existing = values.get(argument) ?? [];
    existing.push(value);
    values.set(argument, existing);
    index += 1;
  }

  return { booleans, values };
};

const parseBronSlugs = (
  rawValues: readonly string[] | undefined
): readonly SupportedBronSlug[] => {
  if (!rawValues || rawValues.length === 0) {
    throw new Error(
      `--bron is required (one of: ${SUPPORTED_BRON_SLUGS.join(", ")})`
    );
  }
  const slugs: SupportedBronSlug[] = [];
  for (const raw of rawValues) {
    for (const part of raw.split(",")) {
      const slug = part.trim();
      if (!slug) {
        continue;
      }
      if (!isSupportedBronSlug(slug)) {
        throw new Error(
          `Unknown --bron ${slug} (supported: ${SUPPORTED_BRON_SLUGS.join(", ")})`
        );
      }
      if (!slugs.includes(slug)) {
        slugs.push(slug);
      }
    }
  }
  if (slugs.length === 0) {
    throw new Error("--bron is required");
  }
  return slugs;
};

export const parseRenormaliseArguments = (
  arguments_: readonly string[]
): RenormaliseCliArguments => {
  const { values, booleans } = readOptions(
    arguments_,
    valueFlags,
    booleanFlags
  );
  const apply = booleans.has("--apply");
  const ingestQuiesced = booleans.has("--ingest-quiesced");
  if (apply !== ingestQuiesced) {
    throw new Error(
      "--apply requires --ingest-quiesced; report mode rejects it"
    );
  }
  let limit: number | undefined;
  const limitRaw = values.get("--limit")?.[0];
  if (limitRaw !== undefined) {
    if ((values.get("--limit")?.length ?? 0) > 1) {
      throw new Error("Duplicate option --limit");
    }
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error("--limit must be a positive integer");
    }
    limit = parsed;
  }
  return {
    bronSlugs: parseBronSlugs(values.get("--bron")),
    ingestQuiesced,
    limit,
    operation: apply ? "apply" : "report",
  };
};

export interface StoredRenormaliseRow {
  readonly aanvraagId: string;
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly bronSpecifiek: BronSpecifiekRecord;
  readonly contentHash: string;
  readonly laatstGezienOp: Date;
  readonly rawPayloadRef: string;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefEnriched: boolean;
  readonly tariefMin: string | null;
  readonly urenPerWeek: string | null;
}

export type RenormalisePatchField =
  | "employment_type"
  | "provincie"
  | "skills"
  | "start_datum"
  | "tarief"
  | "uren_per_week";

export interface RenormaliseFieldPatch {
  readonly field: RenormalisePatchField;
  readonly from: unknown;
  readonly to: unknown;
}

export interface RenormalisePlan {
  readonly patches: readonly RenormaliseFieldPatch[];
  readonly status: "unchanged" | "would_patch";
}

const draftText = (
  value: string | typeof UNKNOWN | typeof CLEARED
): string | null => (value === UNKNOWN || value === CLEARED ? null : value);

const readText = (record: BronSpecifiekRecord, key: string): string | null => {
  const value = record[key];
  // oxlint-disable-next-line promise/prefer-await-to-then -- Zod sync catch, not Promise
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const trimmed = parsed.data.trim();
  return trimmed === "" ? null : trimmed;
};

const readSkills = (record: BronSpecifiekRecord): readonly string[] | null => {
  const value = record.skills;
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success || parsed.data.length === 0) {
    return null;
  }
  return parsed.data;
};

const skillsEqual = (
  left: readonly string[] | null,
  right: readonly string[] | null
): boolean => {
  if (left === null && right === null) {
    return true;
  }
  if (left === null || right === null || left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
};

/**
 * The exact rate BlueTrail's constant JobPosting.baseSalary filler produced
 * (value "100" per hour) before the normaliser stopped reading it. Clearing
 * only this signature, and skipping rows with a tarief enrichment, keeps a real
 * rate from being wiped when the draft is merely silent about tarief.
 */
const isBlueTrailFillerTarief = (stored: StoredRenormaliseRow): boolean =>
  stored.bronId === SOURCES.bluetrail.bronId &&
  !stored.tariefEnriched &&
  Number(stored.tariefMin) === 100 &&
  Number(stored.tariefMax) === 100 &&
  stored.tariefEenheid === "uur";

/**
 * Pure planner: tip draft vs stored curated row. Only emits patches for
 * concrete draft values (never invents absent provincie/skills).
 */
export const planRenormalisePatch = (
  draft: NormalisedAanvraagDraft,
  stored: StoredRenormaliseRow
): RenormalisePlan => {
  const patches: RenormaliseFieldPatch[] = [];
  const draftBron = asBronSpecifiekRecord(draft.bronSpecifiek.value);

  const startDatum = draftText(draft.startDatum.value);
  if (startDatum !== null && startDatum !== stored.startDatum) {
    patches.push({
      field: "start_datum",
      from: stored.startDatum,
      to: startDatum,
    });
  }

  const urenRaw =
    readText(draftBron, "uren_per_week") ??
    readText(draftBron, "uren_per_week_raw");
  const uren = urenRaw === "0" ? null : urenRaw;
  if (uren !== null && uren !== stored.urenPerWeek) {
    patches.push({
      field: "uren_per_week",
      from: stored.urenPerWeek,
      to: uren,
    });
  }

  const provincie = readText(draftBron, "provincie");
  const storedProvincie = readText(stored.bronSpecifiek, "provincie");
  if (provincie !== null && provincie !== storedProvincie) {
    patches.push({
      field: "provincie",
      from: storedProvincie,
      to: provincie,
    });
  }

  const skills = readSkills(draftBron);
  const storedSkills = readSkills(stored.bronSpecifiek);
  if (skills !== null && !skillsEqual(skills, storedSkills)) {
    patches.push({
      field: "skills",
      from: storedSkills,
      to: skills,
    });
  }

  const draftHasEmployment =
    readText(draftBron, "employment_type") !== null ||
    readText(draftBron, "contract_type") !== null;
  const storedEmployment = readText(stored.bronSpecifiek, "employment_type");
  if (!draftHasEmployment && storedEmployment !== null) {
    patches.push({
      field: "employment_type",
      from: storedEmployment,
      to: null,
    });
  }

  if (
    draft.tarief.min === UNKNOWN &&
    draft.tarief.max === UNKNOWN &&
    isBlueTrailFillerTarief(stored)
  ) {
    patches.push({
      field: "tarief",
      from: {
        eenheid: stored.tariefEenheid,
        max: stored.tariefMax,
        min: stored.tariefMin,
      },
      to: null,
    });
  }

  return patches.length === 0
    ? { patches: [], status: "unchanged" }
    : { patches, status: "would_patch" };
};

const TARIEF_BRON_SPECIFIEK_KEYS: ReadonlySet<string> = new Set([
  "tarief_eenheid",
  "tarief_max",
  "tarief_min",
  "tariefEenheid",
  "tariefMax",
  "tariefMin",
]);

export const applyPlanToBronSpecifiek = (
  stored: BronSpecifiekRecord,
  patches: readonly RenormaliseFieldPatch[]
): BronSpecifiekRecord => {
  let dropEmploymentType = false;
  let dropTarief = false;
  const overlays: BronSpecifiekRecord = {};
  for (const patch of patches) {
    switch (patch.field) {
      case "provincie": {
        const parsed = z.string().safeParse(patch.to);
        if (parsed.success) {
          overlays.provincie = parsed.data;
        }
        break;
      }
      case "skills": {
        const parsed = z.array(z.string()).safeParse(patch.to);
        if (parsed.success) {
          overlays.skills = parsed.data;
        }
        break;
      }
      case "employment_type": {
        dropEmploymentType = true;
        break;
      }
      case "tarief": {
        dropTarief = true;
        break;
      }
      default: {
        break;
      }
    }
  }
  const next: BronSpecifiekRecord = {};
  for (const [key, value] of Object.entries(stored)) {
    if (dropEmploymentType && key === "employment_type") {
      continue;
    }
    if (dropTarief && TARIEF_BRON_SPECIFIEK_KEYS.has(key)) {
      continue;
    }
    next[key] = value;
  }
  return { ...next, ...overlays };
};

interface CandidateRow {
  readonly aanvraagId: string;
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly bronSpecifiek: unknown;
  readonly contentHash: string;
  readonly laatstGezienOp: Date;
  readonly rawPayloadRef: string;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefEnriched: boolean;
  readonly tariefMin: string | null;
  readonly urenPerWeek: string | null;
}

const toStored = (row: CandidateRow): StoredRenormaliseRow => ({
  aanvraagId: row.aanvraagId,
  bronId: row.bronId,
  bronReferentie: row.bronReferentie,
  bronSpecifiek: asBronSpecifiekRecord(row.bronSpecifiek),
  contentHash: row.contentHash,
  laatstGezienOp: row.laatstGezienOp,
  rawPayloadRef: row.rawPayloadRef,
  startDatum: row.startDatum,
  tariefEenheid: row.tariefEenheid,
  tariefEnriched: row.tariefEnriched,
  tariefMax: row.tariefMax,
  tariefMin: row.tariefMin,
  urenPerWeek: row.urenPerWeek,
});

const selectCandidates = async (
  sql: postgres.Sql,
  bronIds: readonly string[],
  limit: number | undefined
): Promise<readonly CandidateRow[]> => {
  const rows = await sql<CandidateRow[]>`
    SELECT
      id::text AS "aanvraagId",
      bron_id::text AS "bronId",
      bron_referentie AS "bronReferentie",
      bron_specifiek AS "bronSpecifiek",
      content_hash AS "contentHash",
      laatst_gezien_op AS "laatstGezienOp",
      raw_payload_ref AS "rawPayloadRef",
      start_datum AS "startDatum",
      tarief_eenheid AS "tariefEenheid",
      tarief_max::text AS "tariefMax",
      EXISTS (
        SELECT 1 FROM curated.aanvraag_enrichment enrichment
        WHERE enrichment.aanvraag_id = curated.aanvraag.id
          AND enrichment.field = 'tarief'
      ) AS "tariefEnriched",
      tarief_min::text AS "tariefMin",
      uren_per_week AS "urenPerWeek"
    FROM curated.aanvraag
    WHERE bron_id = ANY(${bronIds}::uuid[])
      AND raw_payload_ref IS NOT NULL
      AND content_hash IS NOT NULL
    ORDER BY id ASC
    ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
  `;
  return rows;
};

const readRawBody = async (
  store: ReturnType<typeof createRawObjectStore>,
  rawPayloadRef: string,
  contentHash: string
): Promise<
  | { readonly body: Uint8Array; readonly status: "ok" }
  | {
      readonly reason: "raw_hash_mismatch" | "raw_missing" | "raw_read_failed";
      readonly status: "rejected";
    }
> => {
  try {
    const object = await store.store.get(rawPayloadRef);
    if (!object) {
      return { reason: "raw_missing", status: "rejected" };
    }
    const digested = await hashContent(object.body);
    if (digested !== contentHash.toLowerCase()) {
      return { reason: "raw_hash_mismatch", status: "rejected" };
    }
    return { body: object.body, status: "ok" };
  } catch (error) {
    if (error instanceof RawObjectDigestMismatchError) {
      return { reason: "raw_hash_mismatch", status: "rejected" };
    }
    return { reason: "raw_read_failed", status: "rejected" };
  }
};

const applyRow = async (input: {
  readonly contentHash: string;
  readonly patches: readonly RenormaliseFieldPatch[];
  readonly sql: postgres.Sql;
  readonly stored: StoredRenormaliseRow;
}): Promise<{ readonly auditId: string; readonly outboxId: string }> => {
  const nextBron = applyPlanToBronSpecifiek(
    input.stored.bronSpecifiek,
    input.patches
  );
  const startPatch = input.patches.find(
    (patch) => patch.field === "start_datum"
  );
  const urenPatch = input.patches.find(
    (patch) => patch.field === "uren_per_week"
  );
  const nextStartDatum =
    startPatch === undefined ? input.stored.startDatum : String(startPatch.to);
  const nextUrenPerWeek =
    urenPatch === undefined ? input.stored.urenPerWeek : String(urenPatch.to);
  const clearTarief = input.patches.some((patch) => patch.field === "tarief");

  return await input.sql.begin(async (transaction) => {
    await transaction`
      SELECT set_config('statement_timeout', ${String(RENORMALISE_STATEMENT_TIMEOUT_MS)}, true)
    `;
    await transaction`
      SELECT set_config('lock_timeout', ${String(RENORMALISE_LOCK_TIMEOUT_MS)}, true)
    `;
    await transaction`
      SELECT set_config(
        'idle_in_transaction_session_timeout',
        ${String(RENORMALISE_IDLE_TRANSACTION_TIMEOUT_MS)},
        true
      )
    `;

    await transaction`
      UPDATE curated.aanvraag
      SET
        start_datum = ${nextStartDatum},
        uren_per_week = ${nextUrenPerWeek},
        bron_specifiek = ${JSON.stringify(nextBron)}::text::jsonb
        ${
          clearTarief
            ? transaction`, tarief_min = NULL, tarief_max = NULL, tarief_eenheid = NULL`
            : transaction``
        }
      WHERE id::text = ${input.stored.aanvraagId}
      RETURNING id::text AS id
    `;

    const auditRows = await transaction<{ id: string }[]>`
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
        ${RENORMALISE_APPLY_ACTION},
        ${RENORMALISE_ACTOR_ID},
        'service',
        'effect',
        ${input.stored.aanvraagId},
        'aanvraag',
        ${JSON.stringify({
          bronId: input.stored.bronId,
          bronReferentie: input.stored.bronReferentie,
          contentHash: input.contentHash,
          patches: input.patches,
          rawPayloadRef: input.stored.rawPayloadRef,
          repairVersion: RENORMALISE_VERSION,
        })}::text::jsonb,
        ${RENORMALISE_SCOPE_ID}
      )
      RETURNING id::text AS id
    `;
    const auditId = auditRows[0]?.id;
    if (!auditId) {
      throw new Error("renormalise audit insert returned no row");
    }

    const outboxRows = await transaction<{ id: string }[]>`
      INSERT INTO curated.outbox_event (
        aggregate_id,
        aggregate_type,
        event_type,
        payload
      ) VALUES (
        ${input.stored.aanvraagId},
        'aanvraag',
        ${RENORMALISE_EVENT_TYPE},
        ${JSON.stringify({
          content_hash: input.contentHash,
          parser_version: RENORMALISE_VERSION,
        })}::text::jsonb
      )
      RETURNING id::text AS id
    `;
    const outboxId = outboxRows[0]?.id;
    if (!outboxId) {
      throw new Error("renormalise outbox insert returned no row");
    }
    return { auditId, outboxId };
  });
};

export const runRenormaliseFromRaw = async (
  arguments_: RenormaliseCliArguments
): Promise<{
  readonly applied: number;
  readonly operation: RenormaliseOperation;
  readonly rejected: number;
  readonly samples: readonly unknown[];
  readonly selected: number;
  readonly wouldPatch: number;
}> => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const bronIds = arguments_.bronSlugs.map((slug) => SOURCES[slug].bronId);
  const sql = postgres(databaseUrl, { max: 1 });
  const rawObjectStore = createRawObjectStore({
    RAW_S3_ACCESS_KEY_ID: process.env.RAW_S3_ACCESS_KEY_ID,
    RAW_S3_BUCKET: process.env.RAW_S3_BUCKET,
    RAW_S3_ENDPOINT: process.env.RAW_S3_ENDPOINT,
    RAW_S3_REGION: process.env.RAW_S3_REGION,
    RAW_S3_SECRET_ACCESS_KEY: process.env.RAW_S3_SECRET_ACCESS_KEY,
  });

  try {
    const candidates = await selectCandidates(sql, bronIds, arguments_.limit);
    let wouldPatch = 0;
    let applied = 0;
    let rejected = 0;
    const samples: unknown[] = [];

    /* oxlint-disable no-await-in-loop -- each candidate is bounded and reported deterministically */
    for (const candidate of candidates) {
      const stored = toStored(candidate);
      const slug = arguments_.bronSlugs.find(
        (item) => SOURCES[item].bronId === stored.bronId
      );
      if (!slug) {
        rejected += 1;
        continue;
      }
      const raw = await readRawBody(
        rawObjectStore,
        stored.rawPayloadRef,
        stored.contentHash
      );
      if (raw.status === "rejected") {
        rejected += 1;
        if (samples.length < 10) {
          samples.push({
            aanvraagId: stored.aanvraagId,
            reason: raw.reason,
            status: "rejected",
          });
        }
        continue;
      }
      let draft: NormalisedAanvraagDraft;
      try {
        draft = SOURCES[slug].normalise(raw.body, stored.contentHash, {
          observedAt: stored.laatstGezienOp,
        });
      } catch {
        rejected += 1;
        if (samples.length < 10) {
          samples.push({
            aanvraagId: stored.aanvraagId,
            reason: "normalise_failed",
            status: "rejected",
          });
        }
        continue;
      }
      const plan = planRenormalisePatch(draft, stored);
      if (plan.status === "unchanged") {
        continue;
      }
      wouldPatch += 1;
      if (samples.length < 10) {
        samples.push({
          aanvraagId: stored.aanvraagId,
          bronReferentie: stored.bronReferentie,
          patches: plan.patches,
          status: "would_patch",
        });
      }
      if (arguments_.operation === "apply") {
        await applyRow({
          contentHash: stored.contentHash,
          patches: plan.patches,
          sql,
          stored,
        });
        applied += 1;
      }
    }
    /* oxlint-enable no-await-in-loop */

    return {
      applied,
      operation: arguments_.operation,
      rejected,
      samples,
      selected: candidates.length,
      wouldPatch,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
};

const main = async (): Promise<void> => {
  const args = parseRenormaliseArguments(process.argv.slice(2));
  const report = await runRenormaliseFromRaw(args);
  console.log(JSON.stringify(report, null, 2));
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error
            ? { message: error.message, name: error.name }
            : { message: String(error), name: "UnknownError" },
        reason: "command_failed",
        status: "error",
      })
    );
    process.exitCode = 1;
  }
}
