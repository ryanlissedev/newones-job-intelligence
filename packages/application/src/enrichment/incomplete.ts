import { z } from "zod";

import { isTitleFallbackDescription } from "../title-fallback-description";
import type { TitleFallbackDescriptionParts } from "../title-fallback-description";
import {
  durableClearedIntersects,
  readDurableClearedKeys,
} from "./cleared-markers";
import { isClearedText, isFillableGap, isMissingText } from "./gap-predicates";
import type { EnrichmentField } from "./types";
import { ENRICHMENT_FIELDS } from "./types";

const sourceTextSchema = z
  .string()
  .refine((value) => value.trim() !== "")
  .nullable()
  .optional()
  // oxlint-disable-next-line promise/prefer-await-to-then -- Zod synchronous fallback API
  .catch(null);

const bronSpecifiekSchema = z.object({
  contract_type: sourceTextSchema,
  contracttype: sourceTextSchema,
  education_level: sourceTextSchema,
  opdrachtgeverNaam: sourceTextSchema,
  opdrachtgever_naam: sourceTextSchema,
  opleidingsniveau: sourceTextSchema,
  startDatum: sourceTextSchema,
  start_datum: sourceTextSchema,
  werkvorm: sourceTextSchema,
});

type ParsedBronSpecifiek = z.output<typeof bronSpecifiekSchema>;

interface ParsedBronFacts {
  readonly contracttype: string | null;
  readonly opleidingsniveau: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly startDatum: string | null;
  readonly werkvorm: string | null;
}

export interface IncompleteAanvraagFacts {
  readonly beschrijving: string;
  readonly bronSpecifiek: unknown;
  readonly contracttype?: string | null;
  readonly eindDatum: string | null;
  readonly locatieTekst: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly publicatiedatum?: string | null;
  readonly sluitingsdatum: string | null;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefMin: string | null;
  readonly urenPerWeek: string | null;
  readonly werkvorm?: string | null;
  readonly titleFallbackParts?: TitleFallbackDescriptionParts | null;
}

const isLocatieIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "locatie",
      "locatie_tekst",
      "locatieTekst",
    ])
  ) {
    return false;
  }
  return isFillableGap(facts.locatieTekst);
};

const isTariefIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  if (
    isClearedText(facts.tariefMin) ||
    isClearedText(facts.tariefMax) ||
    isClearedText(facts.tariefEenheid)
  ) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "tarief",
      "tarief_min",
      "tarief_max",
      "tarief_eenheid",
      "tariefMin",
      "tariefMax",
      "tariefEenheid",
    ])
  ) {
    return false;
  }
  return (
    isFillableGap(facts.tariefMin) &&
    isFillableGap(facts.tariefMax) &&
    isFillableGap(facts.tariefEenheid)
  );
};

const parseBronSpecifiek = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- curated JSON I/O boundary; parsed by bronSpecifiekSchema before field access
  bronSpecifiek: unknown
): ParsedBronSpecifiek | null => {
  const parsed = bronSpecifiekSchema.safeParse(bronSpecifiek);
  return parsed.success ? parsed.data : null;
};

const readBronFacts = (parsed: ParsedBronSpecifiek | null): ParsedBronFacts => {
  if (parsed === null) {
    return {
      contracttype: null,
      opdrachtgeverNaam: null,
      opleidingsniveau: null,
      startDatum: null,
      werkvorm: null,
    };
  }
  const contracttype =
    parsed.contracttype?.trim() || parsed.contract_type?.trim() || null;
  const opleidingsniveau =
    parsed.opleidingsniveau?.trim() || parsed.education_level?.trim() || null;
  const opdrachtgeverNaam =
    parsed.opdrachtgeverNaam?.trim() ||
    parsed.opdrachtgever_naam?.trim() ||
    null;
  const startDatum =
    parsed.startDatum?.trim() || parsed.start_datum?.trim() || null;
  const werkvorm = parsed.werkvorm?.trim() || null;
  return {
    contracttype,
    opdrachtgeverNaam,
    opleidingsniveau,
    startDatum,
    werkvorm,
  };
};

const isContractIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  if (isClearedText(facts.contracttype) || !isMissingText(facts.contracttype)) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, ["contracttype", "contract_type"])
  ) {
    return false;
  }
  const bronFacts = readBronFacts(parseBronSpecifiek(facts.bronSpecifiek));
  if (isClearedText(bronFacts.contracttype)) {
    return false;
  }
  return isMissingText(bronFacts.contracttype);
};

const isRemoteIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  if (isClearedText(facts.werkvorm) || !isMissingText(facts.werkvorm)) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (durableClearedIntersects(bronCleared, ["werkvorm"])) {
    return false;
  }
  const bronFacts = readBronFacts(parseBronSpecifiek(facts.bronSpecifiek));
  if (isClearedText(bronFacts.werkvorm)) {
    return false;
  }
  return isMissingText(bronFacts.werkvorm);
};

const isPublicatiedatumIncomplete = (
  facts: IncompleteAanvraagFacts
): boolean => {
  if (
    isClearedText(facts.publicatiedatum) ||
    !isMissingText(facts.publicatiedatum)
  ) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "publicatiedatum",
      "gepubliceerd_op",
      "publicatie_datum",
    ])
  ) {
    return false;
  }
  return true;
};

const isBeschrijvingIncomplete = (facts: IncompleteAanvraagFacts): boolean =>
  !isClearedText(facts.beschrijving) &&
  isTitleFallbackDescription(facts.beschrijving, facts.titleFallbackParts);

/**
 * `uren_per_week` is read from the curated column only (no bron_specifiek
 * fallback on the read path), so the gap is the column alone.
 */
const isUrenIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  if (isClearedText(facts.urenPerWeek)) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "uren",
      "uren_per_week",
      "urenPerWeek",
    ])
  ) {
    return false;
  }
  return isFillableGap(facts.urenPerWeek);
};

/**
 * `opleidingsniveau` has no curated column -- the read path surfaces it from
 * bron_specifiek (`opleidingsniveau`/`education_level`), so the gap is
 * exactly that bron fact.
 */
const isOpleidingIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "opleiding",
      "opleidingsniveau",
      "education_level",
    ])
  ) {
    return false;
  }
  const bronFacts = readBronFacts(parseBronSpecifiek(facts.bronSpecifiek));
  if (isClearedText(bronFacts.opleidingsniveau)) {
    return false;
  }
  return isMissingText(bronFacts.opleidingsniveau);
};

/** `start_datum` reads column first, then the bron fact fallback. */
const isStartdatumIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  if (isClearedText(facts.startDatum) || !isMissingText(facts.startDatum)) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "startdatum",
      "start_datum",
      "startDatum",
    ])
  ) {
    return false;
  }
  const bronFacts = readBronFacts(parseBronSpecifiek(facts.bronSpecifiek));
  if (isClearedText(bronFacts.startDatum)) {
    return false;
  }
  return isMissingText(bronFacts.startDatum);
};

/** `eind_datum` is read from the curated column only. */
const isEinddatumIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  if (isClearedText(facts.eindDatum)) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "einddatum",
      "eind_datum",
      "eindDatum",
    ])
  ) {
    return false;
  }
  return isFillableGap(facts.eindDatum);
};

/** `sluitingsdatum` is read from the curated timestamp column only. */
const isSluitingsdatumIncomplete = (
  facts: IncompleteAanvraagFacts
): boolean => {
  if (isClearedText(facts.sluitingsdatum)) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "sluitingsdatum",
      "sluitings_datum",
      "valid_through",
    ])
  ) {
    return false;
  }
  return isFillableGap(facts.sluitingsdatum);
};

/** `opdrachtgever_naam` reads column first, then the bron fact fallback. */
const isOrganisatieIncomplete = (facts: IncompleteAanvraagFacts): boolean => {
  if (
    isClearedText(facts.opdrachtgeverNaam) ||
    !isMissingText(facts.opdrachtgeverNaam)
  ) {
    return false;
  }
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  if (
    durableClearedIntersects(bronCleared, [
      "organisatie",
      "opdrachtgever",
      "opdrachtgever_naam",
      "opdrachtgeverNaam",
    ])
  ) {
    return false;
  }
  const bronFacts = readBronFacts(parseBronSpecifiek(facts.bronSpecifiek));
  if (isClearedText(bronFacts.opdrachtgeverNaam)) {
    return false;
  }
  return isMissingText(bronFacts.opdrachtgeverNaam);
};

const fieldIncomplete = {
  beschrijving: isBeschrijvingIncomplete,
  contract: isContractIncomplete,
  einddatum: isEinddatumIncomplete,
  locatie: isLocatieIncomplete,
  opleiding: isOpleidingIncomplete,
  organisatie: isOrganisatieIncomplete,
  publicatiedatum: isPublicatiedatumIncomplete,
  remote: isRemoteIncomplete,
  sluitingsdatum: isSluitingsdatumIncomplete,
  startdatum: isStartdatumIncomplete,
  tarief: isTariefIncomplete,
  uren: isUrenIncomplete,
} satisfies Record<
  EnrichmentField,
  (facts: IncompleteAanvraagFacts) => boolean
>;

export const listMissingEnrichmentFields = (
  facts: IncompleteAanvraagFacts
): readonly EnrichmentField[] =>
  ENRICHMENT_FIELDS.filter((field) => fieldIncomplete[field](facts));
