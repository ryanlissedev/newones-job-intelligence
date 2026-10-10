/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- Motian jobs/raw_payload I/O boundary: nested commercial keys are allowlisted from untyped Motian JSON before curated mapping. */
import { UNKNOWN } from "@ji/domain";
import type { TariefEenheid } from "@ji/domain";
import { z } from "zod";

import { formatHoursPerWeek } from "../normalise/hours";
import {
  findProvincieInText,
  toCanonicalProvincie,
} from "../normalise/provincie";
import type { Provincie } from "../normalise/provincie";
import { normaliseSkills } from "../normalise/skills";
import type { NeonV1JobRow } from "./neon-v1-types";

const nestedPayloadSchema = z
  .object({
    educationLevel: z.string().optional(),
    education_level: z.string().optional(),
    rateMax: z.union([z.number(), z.string()]).optional(),
    rateMin: z.union([z.number(), z.string()]).optional(),
    rate_max: z.union([z.number(), z.string()]).optional(),
    rate_min: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const toNumberOrNull = (
  value: number | string | null | undefined
): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readNestedPayload = (sourceRow: NeonV1JobRow["sourceRow"]) => {
  const raw = sourceRow?.raw_payload;
  const parsed = nestedPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export interface MotianRateBounds {
  readonly max: number | null;
  readonly min: number | null;
}

/** Top-level Motian `rate_*` wins; otherwise allowlisted nested rateMin/Max. */
export const rateBoundsForMotianJob = (job: NeonV1JobRow): MotianRateBounds => {
  if (job.rate_min !== null && job.rate_min !== undefined) {
    return { max: job.rate_max ?? null, min: job.rate_min };
  }
  if (job.rate_max !== null && job.rate_max !== undefined) {
    return { max: job.rate_max, min: job.rate_min ?? null };
  }
  const payload = readNestedPayload(job.sourceRow);
  if (payload === null) {
    return { max: null, min: null };
  }
  return {
    max: toNumberOrNull(payload.rateMax ?? payload.rate_max ?? null),
    min: toNumberOrNull(payload.rateMin ?? payload.rate_min ?? null),
  };
};

export const liftNestedRateBoundsFromRoot = (
  root: Readonly<Record<string, unknown>>,
  rateMin: number | null,
  rateMax: number | null
): MotianRateBounds => {
  if (rateMin !== null || rateMax !== null) {
    return { max: rateMax, min: rateMin };
  }
  const parsed = nestedPayloadSchema.safeParse(root.raw_payload);
  if (!parsed.success) {
    return { max: rateMax, min: rateMin };
  }
  return {
    max: toNumberOrNull(parsed.data.rateMax ?? parsed.data.rate_max ?? null),
    min: toNumberOrNull(parsed.data.rateMin ?? parsed.data.rate_min ?? null),
  };
};

const EDUCATION_TOKEN =
  /^(?<level>mbo|hbo|wo|vmbo|havo|vwo|phd|master|bachelor)(?:\+)?$/iu;

const normalizeEducationLevel = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const match = EDUCATION_TOKEN.exec(trimmed);
  if (match?.groups?.level) {
    return match.groups.level.toUpperCase();
  }
  if (trimmed.length <= 32 && !trimmed.includes("\n")) {
    return trimmed;
  }
  return null;
};

export const liftEducationLevelFromRoot = (
  root: Readonly<Record<string, unknown>>,
  column: string | null | undefined
): string | null => {
  const trimmed = typeof column === "string" ? column.trim() : "";
  if (trimmed !== "") {
    return normalizeEducationLevel(trimmed);
  }
  const parsed = nestedPayloadSchema.safeParse(root.raw_payload);
  if (!parsed.success) {
    return null;
  }
  const nested = parsed.data.educationLevel ?? parsed.data.education_level;
  if (typeof nested === "string" && nested.trim() !== "") {
    return normalizeEducationLevel(nested);
  }
  return null;
};

export const educationLevelForMotianJob = (
  job: NeonV1JobRow
): string | null => {
  const column = job.education_level?.trim();
  if (column) {
    return normalizeEducationLevel(column);
  }
  const payload = readNestedPayload(job.sourceRow);
  if (payload !== null) {
    const nested = payload.educationLevel ?? payload.education_level;
    if (typeof nested === "string") {
      const normalized = normalizeEducationLevel(nested);
      if (normalized !== null) {
        return normalized;
      }
    }
  }
  const requirementsSchema = z
    .object({ education: z.unknown().optional() })
    .passthrough();
  const parsedRequirements = requirementsSchema.safeParse(job.requirements);
  if (!parsedRequirements.success) {
    return null;
  }
  const { education } = parsedRequirements.data;
  if (typeof education === "string") {
    return normalizeEducationLevel(education);
  }
  if (Array.isArray(education) && education.length === 1) {
    const [only] = education;
    if (typeof only === "string") {
      return normalizeEducationLevel(only);
    }
  }
  return null;
};

export interface MotianWeeklyHours {
  readonly hours_per_week: number | null;
  readonly min_hours_per_week: number | null;
  readonly uren_per_week: string | null;
  readonly min_uren_per_week: string | null;
}

export const weeklyHoursForMotianJob = (
  job: NeonV1JobRow,
  sourceHours: {
    readonly hours_per_week: number | null;
    readonly min_hours_per_week: number | null;
  }
): MotianWeeklyHours => {
  const hours = sourceHours.hours_per_week ?? job.hours_per_week ?? null;
  const minHours =
    sourceHours.min_hours_per_week ?? job.min_hours_per_week ?? null;
  const publishedHours = hours === null ? null : String(hours);
  const weeklyHours =
    minHours === null ? publishedHours : formatHoursPerWeek(minHours, hours);
  return {
    hours_per_week: hours,
    min_hours_per_week: minHours,
    min_uren_per_week: minHours === null ? null : String(minHours),
    uren_per_week: weeklyHours,
  };
};

/**
 * Motian has no rate-unit column. Vast monthly salaris ranges (>= 1000) use
 * maand; other amounts stay UNKNOWN so labeled inhuur copy can set uur later.
 */
export const motianTariefEenheid = (
  job: NeonV1JobRow,
  min: number | null,
  max: number | null
): TariefEenheid | typeof UNKNOWN => {
  const amount = max ?? min;
  if (amount === null) {
    return UNKNOWN;
  }
  const contract = job.contract_type?.trim().toLowerCase() ?? "";
  if (contract === "vast" && amount >= 1000) {
    return "maand";
  }
  return UNKNOWN;
};

/** Motian platform slug whose vacancy titles carry the province. */
const WERKZOEKEN_PLATFORM = "werkzoeken";

/**
 * Canonical province for `bronSpecifiek.provincie` (F04). The Motian
 * `province` column is the only source for every platform. Werkzoeken alone
 * also publishes it in the vacancy title, so the title is scanned for that
 * platform only — elsewhere a title token like "Utrecht" is a work location,
 * and reading it would infer a province the source never stated. A city in
 * `location` is never consulted.
 */
export const provincieForMotianJob = (job: NeonV1JobRow): Provincie | null => {
  const column = toCanonicalProvincie(job.province);
  if (column !== null) {
    return column;
  }
  if (job.platform.trim().toLowerCase() !== WERKZOEKEN_PLATFORM) {
    return null;
  }
  return findProvincieInText(job.title);
};

const skillEntrySchema = z.record(z.string(), z.unknown());

/**
 * Structured skills for `bronSpecifiek.skills` (F15) from the Motian
 * `competences` column, the one list shape a captured Motian payload shows:
 * an array of objects carrying a `name`. `requirements` and `wishes` are not
 * read — the CTP-514 audit records those as prose more often than lists, and
 * mining prose is GAP_ENRICH (CTP-482). Shaping is delegated to the shared
 * {@link normaliseSkills}. Returns null when `competences` publishes no list,
 * so an absent column never becomes `[]`.
 */
export const skillsForMotianJob = (job: NeonV1JobRow): string[] | null => {
  if (!Array.isArray(job.competences)) {
    return null;
  }
  const names: string[] = [];
  for (const entry of job.competences) {
    const parsed = skillEntrySchema.safeParse(entry);
    if (parsed.success && typeof parsed.data.name === "string") {
      names.push(parsed.data.name);
    }
  }
  const skills = normaliseSkills(names);
  return skills.length === 0 ? null : skills;
};
