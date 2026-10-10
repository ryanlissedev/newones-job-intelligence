/**
 * Canonical mapping from a source's raw `contract_type` / `employmentType`
 * token to the web `JobContractType` vocabulary (CTP-514, F06).
 *
 * Sources publish tokens the web layer does not understand: Dutch prose
 * ("tijdelijk"), English enums ("CONTRACTOR"), and JSON-LD `employmentType`
 * values that describe hours or employment rather than contract form
 * ("FULL_TIME", "PART_TIME"). Only an explicit, unambiguous token maps to a
 * {@link ClassifiedContractType}; everything else -- including tokens that
 * describe something other than contract form -- yields null so the caller
 * may fall back to the prose classifier or leave the column empty.
 */

import type { ClassifiedContractType } from "./classify-contract-work";

const CONTRACT_TYPE_TOKENS = new Map<string, ClassifiedContractType>(
  Object.entries({
    contractor: "freelance",
    detachering: "detachering",
    freelance: "freelance",
    interim: "interim",
    permanent: "vast",
    temporary: "interim",
    tijdelijk: "interim",
    vast: "vast",
    "vast dienstverband": "vast",
    zzp: "freelance",
  })
);

/**
 * Maps a source's raw contract-type token to the canonical vocabulary,
 * case/whitespace-insensitive. Returns null for absent input and for any
 * token not in the explicit map (e.g. `FULL_TIME`, `PART_TIME`, `OTHER`).
 */
export const toCanonicalContractType = (
  token?: string | null
): ClassifiedContractType | null => {
  if (token === null || token === undefined) {
    return null;
  }
  const key = token.trim().toLowerCase();
  return CONTRACT_TYPE_TOKENS.get(key) ?? null;
};

/**
 * Maps a schema.org `employmentType` list to one canonical contract form.
 * Sources publish arrays mixing contract-form tokens with hours/employment
 * tokens (["TEMPORARY", "FULL_TIME"]). Tokens that describe something other
 * than contract form are ignored; the list yields a canonical form only when
 * its mappable tokens all agree. ["TEMPORARY", "CONTRACTOR"] is an explicit
 * either/or the source published, not a single contract form, and yields
 * null so the caller falls back to the prose classifier.
 */
export const toCanonicalEmploymentTypes = (
  tokens: readonly string[]
): ClassifiedContractType | null => {
  const canonical = new Set<ClassifiedContractType>();
  for (const token of tokens) {
    const mapped = toCanonicalContractType(token);
    if (mapped !== null) {
      canonical.add(mapped);
    }
  }
  const [single] = canonical;
  return canonical.size === 1 ? (single ?? null) : null;
};

export const resolveCanonicalContractType = (
  contracttype?: string | null,
  contractType?: string | null,
  employmentType?: string | null
): ClassifiedContractType | null => {
  const direct = [contracttype, contractType].find(
    (value) => value !== null && value !== undefined && value.trim() !== ""
  );
  if (direct !== undefined) {
    return toCanonicalContractType(direct);
  }
  if (!employmentType?.trim()) {
    return null;
  }
  return toCanonicalEmploymentTypes(
    employmentType.split(",").map((token) => token.trim())
  );
};
