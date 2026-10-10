import { normaliseSkills } from "@ji/application/normalise";
import type { JsonValue } from "@ji/application/normalise";
import {
  hashContent,
  parseContentAddressedRawObjectPath,
} from "@ji/connectors";
import type { RawContentType } from "@ji/connectors";
import { UNKNOWN } from "@ji/domain";
import { z } from "zod";

import { decodeMotianV1RawRow } from "../../packages/application/src/backfill/motian-neon-v1-source";
import {
  MOTIAN_V1_BRON_BINDINGS,
  normalizeMotianPlatform,
  resolveMotianV1Binding,
} from "../../packages/application/src/backfill/motian-v1-bindings";
import { mapV1JobToDraft } from "../../packages/application/src/backfill/neon-v1";

export const MOTIAN_V1_DERIVED_FIELD_REPAIR_VERSION =
  "motian-v1-derived-field-repair/v3" as const;

export const MOTIAN_DERIVED_FIELD_NAMES = [
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
] as const;

export type MotianDerivedFieldName =
  (typeof MOTIAN_DERIVED_FIELD_NAMES)[number];

export interface MotianDerivedFieldRepairManifestEntry {
  readonly aanvraagId: string;
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly contentHash: string;
  readonly rawPayloadRef: string;
  readonly v1Id: string;
}

export interface CurrentMotianDerivedFieldRow extends MotianDerivedFieldRepairManifestEntry {
  readonly contracttype: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly opleidingsniveau: string | null;
  readonly provincie: string | null;
  readonly publicatiedatum: string | null;
  /** `bron_specifiek.skills` as its canonical JSON array text, or null. */
  readonly skills: string | null;
  readonly sluitingsdatum: Date | null;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefMin: string | null;
  readonly urenPerWeek: string | null;
}

export interface RawObjectForMotianRepair {
  readonly body: Uint8Array;
  readonly contentType: RawContentType;
}

export type MotianDerivedFieldRepairReason =
  | "current_row_missing"
  | "current_row_mismatch"
  | "raw_missing"
  | "raw_content_type_invalid"
  | "raw_hash_mismatch"
  | "raw_ref_not_content_addressed"
  | "raw_schema_not_motian"
  | "source_identity_mismatch";

export interface MotianDerivedFieldRepairPatch {
  readonly contracttype?: string;
  readonly opdrachtgeverNaam?: string;
  readonly opleidingsniveau?: string;
  readonly provincie?: string;
  readonly publicatiedatum?: string;
  readonly skills?: string;
  readonly sluitingsdatum?: Date;
  readonly startDatum?: string;
  readonly tariefEenheid?: string;
  readonly tariefMax?: string;
  readonly tariefMin?: string;
  readonly urenPerWeek?: string;
}

type MutableMotianDerivedFieldRepairPatch = {
  -readonly [
    key in keyof MotianDerivedFieldRepairPatch
  ]: MotianDerivedFieldRepairPatch[key];
};

export type MotianDerivedFieldRepairPlan =
  | {
      readonly kind: "rejected";
      readonly reason: MotianDerivedFieldRepairReason;
      readonly v1Id: string;
    }
  | {
      readonly kind: "unchanged";
      readonly sourceAbsentFields: readonly MotianDerivedFieldName[];
      readonly v1Id: string;
    }
  | {
      readonly kind: "patch";
      readonly patch: MotianDerivedFieldRepairPatch;
      readonly sourceAbsentFields: readonly MotianDerivedFieldName[];
      readonly v1Id: string;
    };

type MotianDerivedFieldRepairRejection = Extract<
  MotianDerivedFieldRepairPlan,
  { readonly kind: "rejected" }
>;

const manifestMatchesCurrent = (
  manifest: MotianDerivedFieldRepairManifestEntry,
  current: CurrentMotianDerivedFieldRow
): boolean =>
  manifest.aanvraagId === current.aanvraagId &&
  manifest.bronId === current.bronId &&
  manifest.bronReferentie === current.bronReferentie &&
  manifest.contentHash === current.contentHash &&
  manifest.rawPayloadRef === current.rawPayloadRef &&
  manifest.v1Id === current.v1Id;

const sourceText = (value: string | typeof UNKNOWN): string | undefined =>
  value === UNKNOWN ? undefined : value;

const bronSpecifiekSchema = z.record(z.string(), z.unknown());
const sourceBronTextSchema = z.string().trim().min(1);

const sourceBronText = (
  value: JsonValue,
  key:
    | "contracttype"
    | "opleidingsniveau"
    | "provincie"
    | "publicatiedatum"
    | "uren_per_week"
): string | undefined => {
  const bronSpecifiek = bronSpecifiekSchema.safeParse(value);
  if (!bronSpecifiek.success) {
    return undefined;
  }
  return sourceBronTextSchema.safeParse(bronSpecifiek.data[key]).data;
};

/**
 * `bron_specifiek.skills` as canonical JSON array text, or undefined when the
 * draft publishes no list. The array is carried as text so the repair/apply
 * pipeline keeps one uniform string parameter shape.
 */
const sourceBronSkills = (value: JsonValue): string | undefined => {
  const bronSpecifiek = bronSpecifiekSchema.safeParse(value);
  if (!bronSpecifiek.success) {
    return undefined;
  }
  const skills = normaliseSkills(bronSpecifiek.data.skills);
  return skills.length === 0 ? undefined : JSON.stringify(skills);
};

const rejectedPlan = (
  reason: MotianDerivedFieldRepairReason,
  v1Id: string
): MotianDerivedFieldRepairRejection => ({ kind: "rejected", reason, v1Id });

const hasExpectedMotianV1JsonRawPayloadRef = (
  current: CurrentMotianDerivedFieldRow
): boolean => {
  const binding = MOTIAN_V1_BRON_BINDINGS.find(
    (candidate) => candidate.bronId === current.bronId
  );
  const addressed = parseContentAddressedRawObjectPath(current.rawPayloadRef);
  return (
    binding !== undefined &&
    addressed?.contentHash === current.contentHash &&
    current.rawPayloadRef.startsWith(`raw/${binding.platform}/`) &&
    current.rawPayloadRef.endsWith(`/${current.contentHash}.json`)
  );
};

/** Validates the current row and its manifest binding before any raw read. */
export const validateCurrentMotianV1DerivedFieldRepairCandidate = (input: {
  readonly current: CurrentMotianDerivedFieldRow | null;
  readonly manifest: MotianDerivedFieldRepairManifestEntry;
}): MotianDerivedFieldRepairRejection | undefined => {
  const { current, manifest } = input;
  if (!current) {
    return rejectedPlan("current_row_missing", manifest.v1Id);
  }
  if (!manifestMatchesCurrent(manifest, current)) {
    return rejectedPlan("current_row_mismatch", manifest.v1Id);
  }
  if (!hasExpectedMotianV1JsonRawPayloadRef(current)) {
    return rejectedPlan("raw_ref_not_content_addressed", current.v1Id);
  }
  return undefined;
};

const validateRawObject = async (input: {
  readonly current: CurrentMotianDerivedFieldRow;
  readonly raw: RawObjectForMotianRepair;
}): Promise<MotianDerivedFieldRepairPlan | undefined> => {
  const { current, raw } = input;
  if (raw.contentType !== "json") {
    return rejectedPlan("raw_content_type_invalid", current.v1Id);
  }
  if ((await hashContent(raw.body)) !== current.contentHash) {
    return rejectedPlan("raw_hash_mismatch", current.v1Id);
  }
  return undefined;
};

const mapMotianRawObject = (
  raw: RawObjectForMotianRepair,
  current: CurrentMotianDerivedFieldRow
): MotianDerivedFieldRepairPlan | ReturnType<typeof decodeMotianV1RawRow> => {
  try {
    return decodeMotianV1RawRow(raw.body);
  } catch {
    return rejectedPlan("raw_schema_not_motian", current.v1Id);
  }
};

const applyNullableSourceField = <T extends string>(input: {
  readonly current: T | null;
  readonly field: MotianDerivedFieldName;
  readonly patch: MutableMotianDerivedFieldRepairPatch;
  readonly sourceAbsentFields: MotianDerivedFieldName[];
  readonly value: T | undefined;
  readonly write: (value: T) => void;
}): void => {
  if (input.value === undefined) {
    input.sourceAbsentFields.push(input.field);
    return;
  }
  if (input.current === null) {
    input.write(input.value);
  }
};

const planFields = (
  current: CurrentMotianDerivedFieldRow,
  job: ReturnType<typeof decodeMotianV1RawRow>
): Pick<
  MotianDerivedFieldRepairPlan & { kind: "patch" },
  "patch" | "sourceAbsentFields"
> => {
  const draft = mapV1JobToDraft(job);
  const patch: MutableMotianDerivedFieldRepairPatch = {};
  const sourceAbsentFields: MotianDerivedFieldName[] = [];
  const bronSpecifiek = draft.bronSpecifiek.value;

  applyNullableSourceField({
    current: current.opdrachtgeverNaam,
    field: "opdrachtgeverNaam",
    patch,
    sourceAbsentFields,
    value: sourceText(draft.opdrachtgeverNaam.value),
    write: (value) => {
      patch.opdrachtgeverNaam = value;
    },
  });
  applyNullableSourceField({
    current: current.contracttype,
    field: "contracttype",
    patch,
    sourceAbsentFields,
    value: sourceBronText(bronSpecifiek, "contracttype"),
    write: (value) => {
      patch.contracttype = value;
    },
  });
  applyNullableSourceField({
    current: current.publicatiedatum,
    field: "publicatiedatum",
    patch,
    sourceAbsentFields,
    value: sourceBronText(bronSpecifiek, "publicatiedatum"),
    write: (value) => {
      patch.publicatiedatum = value;
    },
  });
  applyNullableSourceField({
    current: current.startDatum,
    field: "startDatum",
    patch,
    sourceAbsentFields,
    value: sourceText(draft.startDatum.value),
    write: (value) => {
      patch.startDatum = value;
    },
  });
  if (draft.sluitingsdatum === undefined) {
    sourceAbsentFields.push("sluitingsdatum");
  } else if (current.sluitingsdatum === null) {
    patch.sluitingsdatum = draft.sluitingsdatum;
  }

  applyNullableSourceField({
    current: current.urenPerWeek,
    field: "urenPerWeek",
    patch,
    sourceAbsentFields,
    value: sourceBronText(bronSpecifiek, "uren_per_week"),
    write: (value) => {
      patch.urenPerWeek = value;
    },
  });
  applyNullableSourceField({
    current: current.opleidingsniveau,
    field: "opleidingsniveau",
    patch,
    sourceAbsentFields,
    value: sourceBronText(bronSpecifiek, "opleidingsniveau"),
    write: (value) => {
      patch.opleidingsniveau = value;
    },
  });

  applyNullableSourceField({
    current: current.provincie,
    field: "provincie",
    patch,
    sourceAbsentFields,
    value: sourceBronText(bronSpecifiek, "provincie"),
    write: (value) => {
      patch.provincie = value;
    },
  });
  applyNullableSourceField({
    current: current.skills,
    field: "skills",
    patch,
    sourceAbsentFields,
    value: sourceBronSkills(bronSpecifiek),
    write: (value) => {
      patch.skills = value;
    },
  });

  const tariefMin = sourceText(draft.tarief.min);
  const tariefMax = sourceText(draft.tarief.max);
  const tariefEenheid = sourceText(draft.tarief.eenheid);
  if (tariefMin === undefined && tariefMax === undefined) {
    sourceAbsentFields.push("tariefMin", "tariefMax", "tariefEenheid");
  } else if (
    current.tariefMin === null &&
    current.tariefMax === null &&
    current.tariefEenheid === null
  ) {
    if (tariefMin !== undefined) {
      patch.tariefMin = tariefMin;
    }
    if (tariefMax !== undefined) {
      patch.tariefMax = tariefMax;
    }
    if (tariefEenheid !== undefined) {
      patch.tariefEenheid = tariefEenheid;
    }
  }

  return { patch, sourceAbsentFields };
};

/**
 * Builds a set-only plan from one manifest-approved current row and its
 * immutable raw object. The plan retains source values only in memory; the
 * CLI reduces it to field names and counts before reporting.
 */
export const planMotianV1DerivedFieldRepair = async (input: {
  readonly current: CurrentMotianDerivedFieldRow | null;
  readonly manifest: MotianDerivedFieldRepairManifestEntry;
  readonly raw: RawObjectForMotianRepair | null;
}): Promise<MotianDerivedFieldRepairPlan> => {
  const { current, manifest, raw } = input;
  const candidateValidation =
    validateCurrentMotianV1DerivedFieldRepairCandidate({
      current,
      manifest,
    });
  if (candidateValidation) {
    return candidateValidation;
  }
  if (!current) {
    return rejectedPlan("current_row_missing", manifest.v1Id);
  }
  if (!raw) {
    return rejectedPlan("raw_missing", current.v1Id);
  }
  const rawValidation = await validateRawObject({ current, raw });
  if (rawValidation) {
    return rawValidation;
  }
  const job = mapMotianRawObject(raw, current);
  if ("kind" in job) {
    return job;
  }
  const binding = resolveMotianV1Binding(
    MOTIAN_V1_BRON_BINDINGS,
    normalizeMotianPlatform(job.platform)
  );
  if (
    job.id !== current.v1Id ||
    job.external_id !== current.bronReferentie ||
    binding?.bronId !== current.bronId
  ) {
    return rejectedPlan("source_identity_mismatch", manifest.v1Id);
  }

  const { patch, sourceAbsentFields } = planFields(current, job);

  const hasPatch = MOTIAN_DERIVED_FIELD_NAMES.some(
    (field) => patch[field] !== undefined
  );
  if (!hasPatch) {
    return {
      kind: "unchanged",
      sourceAbsentFields,
      v1Id: manifest.v1Id,
    };
  }
  return {
    kind: "patch",
    patch,
    sourceAbsentFields,
    v1Id: manifest.v1Id,
  };
};
