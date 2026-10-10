/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- JobPosting JSON-LD HTML I/O boundary: keys are allowlisted from untyped schema.org nodes before commercial mapping. */
import { extractJobPosting } from "@ji/connectors/json-ld";
import { UNKNOWN } from "@ji/domain";
import { z } from "zod";

import type { NormalisedTarief } from "./types";

const jobPostingNodeSchema = z.record(z.string(), z.unknown());

const asText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const eenheidFromUnitText = (unit: string): "maand" | "dag" | "uur" | null => {
  if (unit === "MONTH" || unit === "MON" || unit === "MAAND") {
    return "maand";
  }
  if (unit === "DAY" || unit === "DAG") {
    return "dag";
  }
  if (unit === "HOUR" || unit === "HR" || unit === "UUR") {
    return "uur";
  }
  return null;
};

export interface JobPostingCommercialFacts {
  readonly educationLevel: string | null;
  readonly publicatiedatum: string | null;
  readonly tarief: NormalisedTarief | null;
  readonly urenPerWeek: string | null;
}

const tariefFromBaseSalary = (
  jobPosting: Readonly<Record<string, unknown>>
): NormalisedTarief | null => {
  const baseParsed = jobPostingNodeSchema.safeParse(jobPosting.baseSalary);
  if (!baseParsed.success) {
    return null;
  }
  const baseSalary = baseParsed.data;
  const valueParsed = jobPostingNodeSchema.safeParse(baseSalary.value);
  const valueNode = valueParsed.success ? valueParsed.data : baseSalary;
  const unit = (asText(valueNode.unitText) ?? "").toUpperCase();
  const min = asFiniteNumber(valueNode.minValue ?? valueNode.value);
  const max = asFiniteNumber(valueNode.maxValue ?? valueNode.value);
  if (min === null && max === null) {
    return null;
  }
  const eenheid = eenheidFromUnitText(unit);
  if (eenheid === null) {
    return null;
  }
  return {
    eenheid,
    max: max === null ? UNKNOWN : String(max),
    min: min === null ? UNKNOWN : String(min),
    valuta: asText(baseSalary.currency) ?? "EUR",
  };
};

const educationFromJobPosting = (
  jobPosting: Readonly<Record<string, unknown>>,
  html: string
): string | null => {
  const labeled = html.match(
    /Opleidingsniveau:\s*(?<level>MBO|HBO|WO|VMBO|HAVO|VWO)\b/iu
  );
  if (labeled?.groups?.level) {
    return labeled.groups.level.toUpperCase();
  }
  const requirements = jobPostingNodeSchema.safeParse(
    jobPosting.educationRequirements
  );
  if (!requirements.success) {
    return null;
  }
  return asText(requirements.data.credentialCategory);
};

/**
 * Shared commercial facts from a JobPosting JSON-LD block embedded in HTML.
 * Used by enrich + Motian publicatie repair — never invents when LD is absent.
 */
export const extractJobPostingCommercialFacts = (
  html: string
): JobPostingCommercialFacts => {
  const jobPosting = extractJobPosting(html);
  if (jobPosting === null) {
    return {
      educationLevel: null,
      publicatiedatum: null,
      tarief: null,
      urenPerWeek: null,
    };
  }
  // SAFETY: extractJobPosting returns a schema.org JobPosting object; we treat
  // it as a string-keyed record of unknown values at this HTML I/O boundary.
  const record = jobPosting as Readonly<Record<string, unknown>>;
  return {
    educationLevel: educationFromJobPosting(record, html),
    publicatiedatum: asText(record.datePosted),
    tarief: tariefFromBaseSalary(record),
    urenPerWeek: asText(record.workHours),
  };
};
