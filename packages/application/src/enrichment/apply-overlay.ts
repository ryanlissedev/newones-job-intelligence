import { UNKNOWN } from "@ji/domain";

import { parseWeeklyHoursRange } from "../normalise/hours";
import { closingMomentInstant } from "../normalise/types";
import { isTitleFallbackDescription } from "../title-fallback-description";
import type { TitleFallbackDescriptionParts } from "../title-fallback-description";
import { isClearedText, isFillableGap, isMissingText } from "./gap-predicates";
import type {
  EnrichmentBeschrijvingValue,
  EnrichmentContractValue,
  EnrichmentEinddatumValue,
  EnrichmentField,
  EnrichmentFieldValue,
  EnrichmentLocatieValue,
  EnrichmentOpleidingValue,
  EnrichmentOrganisatieValue,
  EnrichmentPublicatiedatumValue,
  EnrichmentRemoteValue,
  EnrichmentSluitingsdatumValue,
  EnrichmentSource,
  EnrichmentStartdatumValue,
  EnrichmentTariefValue,
  EnrichmentUrenValue,
} from "./types";
import { AANGEVULD_MIN_CONFIDENCE } from "./types";

export interface EnrichmentOverlayRow {
  readonly confidence: number;
  readonly field: EnrichmentField;
  readonly source: EnrichmentSource;
  readonly value: EnrichmentFieldValue;
}

export interface EnrichedFieldMeta {
  readonly confidence: number;
  readonly field: EnrichmentField;
  readonly source: EnrichmentSource;
}

export interface AanvraagEnrichmentFacts {
  beschrijving?: string;
  contracttype?: string | null;
  eindDatum?: string | null;
  locatie?: string | null;
  opdrachtgeverNaam?: string | null;
  opleidingsniveau?: string | null;
  publicatiedatum?: string | null;
  sluitingsdatum?: Date | null;
  startDatum?: string | null;
  tariefEenheid?: string | null;
  tariefMax?: number | null;
  tariefMin?: number | null;
  tariefValuta?: string | null;
  urenPerWeek?: string | null;
  werkvorm?: string | null;
  titleFallbackParts?: TitleFallbackDescriptionParts | null;
}

export interface SearchEnrichmentFacts {
  contracttype: string | null;
  locatie?: string | null;
  opdrachtgeverNaam?: string | null;
  sluitingsdatum?: Date | null;
  tariefEenheid?: string | null;
  tariefMax: number | null;
  tariefMin: number | null;
  urenPerWeekMax?: number | null;
  urenPerWeekMin?: number | null;
  werkvorm?: string | null;
}

const isMissingTarief = (facts: {
  readonly tariefEenheid?: string | null;
  readonly tariefMax?: number | null;
  readonly tariefMin?: number | null;
}): boolean =>
  (facts.tariefMin === null || facts.tariefMin === undefined) &&
  (facts.tariefMax === null || facts.tariefMax === undefined) &&
  isMissingText(facts.tariefEenheid);

const isClearedTariefFacts = (facts: {
  readonly tariefEenheid?: string | null;
  readonly tariefMax?: number | null;
  readonly tariefMin?: number | null;
}): boolean =>
  isClearedText(facts.tariefEenheid) ||
  isClearedText(
    facts.tariefMax === null || facts.tariefMax === undefined
      ? null
      : String(facts.tariefMax)
  ) ||
  isClearedText(
    facts.tariefMin === null || facts.tariefMin === undefined
      ? null
      : String(facts.tariefMin)
  );

const asLocatie = (
  value: EnrichmentFieldValue
): EnrichmentLocatieValue | null => ("locatieTekst" in value ? value : null);

const asBeschrijving = (
  value: EnrichmentFieldValue
): EnrichmentBeschrijvingValue | null =>
  "beschrijving" in value ? value : null;

const asTarief = (value: EnrichmentFieldValue): EnrichmentTariefValue | null =>
  "eenheid" in value && "valuta" in value ? value : null;

const asContract = (
  value: EnrichmentFieldValue
): EnrichmentContractValue | null =>
  "contracttype" in value && !("werkvorm" in value) ? value : null;

const asRemote = (value: EnrichmentFieldValue): EnrichmentRemoteValue | null =>
  "werkvorm" in value ? value : null;

const asPublicatiedatum = (
  value: EnrichmentFieldValue
): EnrichmentPublicatiedatumValue | null =>
  "publicatiedatum" in value && !("locatieTekst" in value) ? value : null;

const asUren = (value: EnrichmentFieldValue): EnrichmentUrenValue | null =>
  "urenPerWeek" in value ? value : null;

const asOpleiding = (
  value: EnrichmentFieldValue
): EnrichmentOpleidingValue | null =>
  "opleidingsniveau" in value ? value : null;

const asStartdatum = (
  value: EnrichmentFieldValue
): EnrichmentStartdatumValue | null => ("startdatum" in value ? value : null);

const asEinddatum = (
  value: EnrichmentFieldValue
): EnrichmentEinddatumValue | null => ("einddatum" in value ? value : null);

const asSluitingsdatum = (
  value: EnrichmentFieldValue
): EnrichmentSluitingsdatumValue | null =>
  "sluitingsdatum" in value ? value : null;

const asOrganisatie = (
  value: EnrichmentFieldValue
): EnrichmentOrganisatieValue | null => ("organisatie" in value ? value : null);

const parseTariefNumber = (raw: string): number | null => {
  if (raw.trim() === "" || raw.trim() === UNKNOWN) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/** UI/API provenance entries — only rows at or above the aangevuld threshold. */
export const toEnrichedFieldMeta = (
  rows: readonly EnrichmentOverlayRow[]
): readonly EnrichedFieldMeta[] =>
  rows
    .filter((row) => row.confidence >= AANGEVULD_MIN_CONFIDENCE)
    .map((row) => ({
      confidence: row.confidence,
      field: row.field,
      source: row.source,
    }));

/**
 * Overlay persisted enrichment onto curated aanvraag facts without inventing
 * values when curated already published them.
 */
// oxlint-disable-next-line eslint/complexity -- one branch per enrichment field
export const applyEnrichmentOverlayToAanvraagFacts = (
  facts: AanvraagEnrichmentFacts,
  rows: readonly EnrichmentOverlayRow[]
): AanvraagEnrichmentFacts & {
  readonly enrichedFields: readonly EnrichedFieldMeta[];
} => {
  const next: AanvraagEnrichmentFacts = {
    beschrijving: facts.beschrijving,
    contracttype: facts.contracttype,
    eindDatum: facts.eindDatum,
    locatie: facts.locatie,
    opdrachtgeverNaam: facts.opdrachtgeverNaam,
    opleidingsniveau: facts.opleidingsniveau,
    publicatiedatum: facts.publicatiedatum,
    sluitingsdatum: facts.sluitingsdatum,
    startDatum: facts.startDatum,
    tariefEenheid: facts.tariefEenheid,
    tariefMax: facts.tariefMax,
    tariefMin: facts.tariefMin,
    tariefValuta: facts.tariefValuta,
    titleFallbackParts: facts.titleFallbackParts,
    urenPerWeek: facts.urenPerWeek,
    werkvorm: facts.werkvorm,
  };

  for (const row of rows) {
    if (
      row.field === "beschrijving" &&
      isTitleFallbackDescription(
        next.beschrijving ?? "",
        next.titleFallbackParts
      )
    ) {
      const value = asBeschrijving(row.value);
      if (
        value &&
        value.beschrijving.trim() !== "" &&
        !isTitleFallbackDescription(value.beschrijving, next.titleFallbackParts)
      ) {
        next.beschrijving = value.beschrijving;
      }
      continue;
    }
    if (row.field === "locatie" && isFillableGap(next.locatie)) {
      const value = asLocatie(row.value);
      if (value && !isMissingText(value.locatieTekst)) {
        next.locatie = value.locatieTekst;
      }
      continue;
    }
    if (
      row.field === "tarief" &&
      isMissingTarief(next) &&
      !isClearedTariefFacts(next)
    ) {
      const value = asTarief(row.value);
      if (!value) {
        continue;
      }
      next.tariefEenheid = isMissingText(value.eenheid) ? null : value.eenheid;
      next.tariefMax = parseTariefNumber(value.max);
      next.tariefMin = parseTariefNumber(value.min);
      next.tariefValuta = isMissingText(value.valuta) ? null : value.valuta;
      continue;
    }
    if (row.field === "contract" && isFillableGap(next.contracttype)) {
      const value = asContract(row.value);
      if (value && !isMissingText(value.contracttype)) {
        next.contracttype = value.contracttype;
      }
      continue;
    }
    if (row.field === "remote" && isFillableGap(next.werkvorm)) {
      const value = asRemote(row.value);
      if (value && !isMissingText(value.werkvorm)) {
        next.werkvorm = value.werkvorm;
      }
      continue;
    }
    if (
      row.field === "publicatiedatum" &&
      isFillableGap(next.publicatiedatum)
    ) {
      const value = asPublicatiedatum(row.value);
      if (value && !isMissingText(value.publicatiedatum)) {
        next.publicatiedatum = value.publicatiedatum;
      }
      continue;
    }
    if (row.field === "uren" && isFillableGap(next.urenPerWeek)) {
      const value = asUren(row.value);
      if (value && !isMissingText(value.urenPerWeek)) {
        next.urenPerWeek = value.urenPerWeek;
      }
      continue;
    }
    if (row.field === "opleiding" && isFillableGap(next.opleidingsniveau)) {
      const value = asOpleiding(row.value);
      if (value && !isMissingText(value.opleidingsniveau)) {
        next.opleidingsniveau = value.opleidingsniveau;
      }
      continue;
    }
    if (row.field === "startdatum" && isFillableGap(next.startDatum)) {
      const value = asStartdatum(row.value);
      if (value && !isMissingText(value.startdatum)) {
        next.startDatum = value.startdatum;
      }
      continue;
    }
    if (row.field === "einddatum" && isFillableGap(next.eindDatum)) {
      const value = asEinddatum(row.value);
      if (value && !isMissingText(value.einddatum)) {
        next.eindDatum = value.einddatum;
      }
      continue;
    }
    if (
      row.field === "sluitingsdatum" &&
      (next.sluitingsdatum === null || next.sluitingsdatum === undefined)
    ) {
      const value = asSluitingsdatum(row.value);
      const instant = value
        ? closingMomentInstant(value.sluitingsdatum)
        : undefined;
      if (value && instant) {
        next.sluitingsdatum = instant;
      }
      continue;
    }
    if (row.field === "organisatie" && isFillableGap(next.opdrachtgeverNaam)) {
      const value = asOrganisatie(row.value);
      if (value && !isMissingText(value.organisatie)) {
        next.opdrachtgeverNaam = value.organisatie;
      }
    }
  }

  return {
    ...facts,
    ...next,
    enrichedFields: toEnrichedFieldMeta(rows),
  };
};

/** Overlay enrichment onto a search document before projection/index writes. */
// oxlint-disable-next-line eslint/complexity -- one branch per enrichment field
export const applyEnrichmentOverlayToSearchFacts = (
  facts: SearchEnrichmentFacts,
  rows: readonly EnrichmentOverlayRow[]
): SearchEnrichmentFacts => {
  const next: SearchEnrichmentFacts = {
    contracttype: facts.contracttype,
    locatie: facts.locatie,
    opdrachtgeverNaam: facts.opdrachtgeverNaam,
    sluitingsdatum: facts.sluitingsdatum,
    tariefEenheid: facts.tariefEenheid ?? null,
    tariefMax: facts.tariefMax,
    tariefMin: facts.tariefMin,
    urenPerWeekMax: facts.urenPerWeekMax,
    urenPerWeekMin: facts.urenPerWeekMin,
    werkvorm: facts.werkvorm ?? null,
  };

  for (const row of rows) {
    if (row.field === "locatie" && isFillableGap(next.locatie)) {
      const value = asLocatie(row.value);
      if (value && !isMissingText(value.locatieTekst)) {
        next.locatie = value.locatieTekst;
      }
      continue;
    }
    if (
      row.field === "tarief" &&
      next.tariefMin === null &&
      next.tariefMax === null
    ) {
      const value = asTarief(row.value);
      if (!value) {
        continue;
      }
      next.tariefMax = parseTariefNumber(value.max);
      next.tariefMin = parseTariefNumber(value.min);
      if (isFillableGap(next.tariefEenheid) && !isMissingText(value.eenheid)) {
        next.tariefEenheid = value.eenheid;
      }
      continue;
    }
    if (row.field === "contract" && isFillableGap(next.contracttype)) {
      const value = asContract(row.value);
      if (value && !isMissingText(value.contracttype)) {
        next.contracttype = value.contracttype;
      }
      continue;
    }
    if (row.field === "remote" && isFillableGap(next.werkvorm)) {
      const value = asRemote(row.value);
      if (value && !isMissingText(value.werkvorm)) {
        next.werkvorm = value.werkvorm;
      }
      continue;
    }
    if (
      row.field === "uren" &&
      (next.urenPerWeekMin === null || next.urenPerWeekMin === undefined) &&
      (next.urenPerWeekMax === null || next.urenPerWeekMax === undefined)
    ) {
      const value = asUren(row.value);
      if (!value || isMissingText(value.urenPerWeek)) {
        continue;
      }
      const hours = parseWeeklyHoursRange(value.urenPerWeek);
      if (hours.min === null && hours.max === null) {
        continue;
      }
      next.urenPerWeekMin = hours.min;
      next.urenPerWeekMax = hours.max;
      continue;
    }
    if (row.field === "organisatie" && isFillableGap(next.opdrachtgeverNaam)) {
      const value = asOrganisatie(row.value);
      if (value && !isMissingText(value.organisatie)) {
        next.opdrachtgeverNaam = value.organisatie;
      }
      continue;
    }
    if (
      row.field === "sluitingsdatum" &&
      (next.sluitingsdatum === null || next.sluitingsdatum === undefined)
    ) {
      const value = asSluitingsdatum(row.value);
      const instant = value
        ? closingMomentInstant(value.sluitingsdatum)
        : undefined;
      if (value && instant) {
        next.sluitingsdatum = instant;
      }
    }
  }

  return {
    ...facts,
    ...next,
  };
};
