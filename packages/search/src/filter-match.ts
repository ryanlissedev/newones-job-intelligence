import type { SearchDocument, SearchFilters } from "./types";
import { documentLocatie } from "./types";

const matchesLocatieFilter = (
  document: SearchDocument,
  locations: SearchFilters["locatie"]
): boolean => {
  if (locations === undefined) {
    return true;
  }
  const location = documentLocatie(document);
  return location !== undefined && locations.includes(location);
};

const matchesLocatieLandFilter = (
  document: SearchDocument,
  lands: SearchFilters["locatieLand"]
): boolean => {
  if (lands === undefined) {
    return true;
  }
  // Explicit unknown location must not match any country filter, even when
  // legacy rows still carry a default locatieLand (RJC-449).
  if (document.locatie === null || document.locatieLand === null) {
    return false;
  }
  return lands.includes(document.locatieLand);
};

const matchesExactOptional = (
  value: string | null,
  allowed: readonly string[] | undefined
): boolean => {
  if (allowed === undefined) {
    return true;
  }
  return value !== null && allowed.includes(value);
};

const overlapsRange = (
  documentMin: number | null,
  documentMax: number | null,
  filterMin: number | undefined,
  filterMax: number | undefined
): boolean => {
  if (
    filterMin !== undefined &&
    (documentMax === null || documentMax < filterMin)
  ) {
    return false;
  }
  if (
    filterMax !== undefined &&
    (documentMin === null || documentMin > filterMax)
  ) {
    return false;
  }
  return true;
};

/** Inclusive API end date compiled as `< next UTC day`. */
export const publicatiedatumTotExclusiveUtc = (inclusiveEnd: Date): Date => {
  const exclusive = new Date(
    Date.UTC(
      inclusiveEnd.getUTCFullYear(),
      inclusiveEnd.getUTCMonth(),
      inclusiveEnd.getUTCDate() + 1
    )
  );
  return exclusive;
};

const asFilterDate = (value: Date | string): Date | null => {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const matchesPublicationRange = (
  document: SearchDocument,
  filters: SearchFilters
): boolean => {
  if (
    filters.publicatiedatumVanaf === undefined &&
    filters.publicatiedatumTot === undefined
  ) {
    return true;
  }
  if (document.publicatiedatum === null) {
    return false;
  }
  const posted = document.publicatiedatum.getTime();
  if (filters.publicatiedatumVanaf !== undefined) {
    const from = asFilterDate(filters.publicatiedatumVanaf);
    if (from === null || posted < from.getTime()) {
      return false;
    }
  }
  if (filters.publicatiedatumTot !== undefined) {
    const to = asFilterDate(filters.publicatiedatumTot);
    if (to === null) {
      return false;
    }
    const exclusive = publicatiedatumTotExclusiveUtc(to).getTime();
    if (posted >= exclusive) {
      return false;
    }
  }
  return true;
};

const matchesSkillsFilter = (
  document: SearchDocument,
  skills: SearchFilters["skills"]
): boolean => {
  if (skills === undefined) {
    return true;
  }
  if (skills.length === 0) {
    return true;
  }
  return skills.every((skill) => document.skills.includes(skill));
};

/** Shared in-process equivalent of Manticore's AND-ed attribute filters. */
export const matchesSearchFilters = (
  document: SearchDocument,
  filters: SearchFilters
): boolean => {
  if (filters.bronIds && !filters.bronIds.includes(document.bronId)) {
    return false;
  }

  if (filters.status && !filters.status.includes(document.status)) {
    return false;
  }

  if (!matchesLocatieLandFilter(document, filters.locatieLand)) {
    return false;
  }

  if (!matchesLocatieFilter(document, filters.locatie)) {
    return false;
  }

  if (
    filters.contracttype &&
    !filters.contracttype.includes(document.contracttype ?? "")
  ) {
    return false;
  }

  if (!matchesExactOptional(document.provincie, filters.provincies)) {
    return false;
  }

  if (!matchesExactOptional(document.werkvorm, filters.werkvormen)) {
    return false;
  }

  if (!matchesExactOptional(document.tariefEenheid, filters.tariefEenheid)) {
    return false;
  }

  if (!matchesSkillsFilter(document, filters.skills)) {
    return false;
  }

  if (
    !overlapsRange(
      document.tariefMin,
      document.tariefMax,
      filters.tariefMin,
      filters.tariefMax
    )
  ) {
    return false;
  }

  if (
    !overlapsRange(
      document.urenPerWeekMin,
      document.urenPerWeekMax,
      filters.urenPerWeekMin,
      filters.urenPerWeekMax
    )
  ) {
    return false;
  }

  if (!matchesPublicationRange(document, filters)) {
    return false;
  }

  if (filters.freshnessDays !== undefined) {
    const cutoff = Date.now() - filters.freshnessDays * 86_400_000;
    if (document.laatstGezienOp.getTime() < cutoff) {
      return false;
    }
  }

  return true;
};
