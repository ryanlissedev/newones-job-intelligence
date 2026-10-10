import type { TitleFallbackDescriptionParts } from "../title-fallback-description";

export const ENRICHMENT_FIELDS = [
  "locatie",
  "tarief",
  "contract",
  "remote",
  "publicatiedatum",
  "beschrijving",
  "uren",
  "opleiding",
  "startdatum",
  "einddatum",
  "sluitingsdatum",
  "organisatie",
] as const;

export type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];

export const ENRICHMENT_SOURCES = ["deterministic", "llm"] as const;

export type EnrichmentSource = (typeof ENRICHMENT_SOURCES)[number];

/** Minimum confidence to show the "aangevuld" badge in the UI. */
export const AANGEVULD_MIN_CONFIDENCE = 0.8;

/** Minimum confidence to persist enrichment rows and emit outbox events. */
export const ENRICHMENT_APPLY_MIN_CONFIDENCE = 0.85;

export interface EnrichmentRawRef {
  readonly excerpt: string;
  readonly field: EnrichmentField;
  readonly sourcePath: string;
}

export interface EnrichmentLocatieValue {
  readonly locatieTekst: string;
}

export interface EnrichmentTariefValue {
  readonly eenheid: string;
  readonly max: string;
  readonly min: string;
  readonly valuta: string;
}

export interface EnrichmentContractValue {
  readonly contracttype: string;
}

export interface EnrichmentRemoteValue {
  readonly werkvorm: string;
}

export interface EnrichmentPublicatiedatumValue {
  readonly publicatiedatum: string;
}

export interface EnrichmentBeschrijvingValue {
  readonly beschrijving: string;
}

export interface EnrichmentUrenValue {
  readonly urenPerWeek: string;
}

export interface EnrichmentOpleidingValue {
  readonly opleidingsniveau: string;
}

export interface EnrichmentStartdatumValue {
  readonly startdatum: string;
}

export interface EnrichmentEinddatumValue {
  readonly einddatum: string;
}

export interface EnrichmentSluitingsdatumValue {
  readonly sluitingsdatum: string;
}

export interface EnrichmentOrganisatieValue {
  readonly organisatie: string;
}

export type EnrichmentFieldValue =
  | EnrichmentBeschrijvingValue
  | EnrichmentContractValue
  | EnrichmentEinddatumValue
  | EnrichmentLocatieValue
  | EnrichmentOpleidingValue
  | EnrichmentOrganisatieValue
  | EnrichmentPublicatiedatumValue
  | EnrichmentRemoteValue
  | EnrichmentSluitingsdatumValue
  | EnrichmentStartdatumValue
  | EnrichmentTariefValue
  | EnrichmentUrenValue;

export interface EnrichmentProposal {
  readonly confidence: number;
  readonly field: EnrichmentField;
  readonly rawRefs: readonly EnrichmentRawRef[];
  readonly source: EnrichmentSource;
  readonly value: EnrichmentFieldValue;
}

export interface EnrichmentRunInput {
  readonly aanvraagId: string;
  readonly beschrijving: string;
  readonly bronSpecifiek: unknown;
  readonly contracttype?: string | null;
  readonly eindDatum?: string | null;
  readonly enableLlmResidual?: boolean;
  readonly locatieTekst?: string | null;
  readonly opdrachtgeverNaam?: string | null;
  readonly publicatiedatum?: string | null;
  readonly rawHtml?: string | null;
  readonly sluitingsdatum?: string | null;
  readonly startDatum?: string | null;
  readonly titleFallbackParts?: TitleFallbackDescriptionParts | null;
  readonly tariefEenheid?: string | null;
  readonly tariefMax?: string | null;
  readonly tariefMin?: string | null;
  readonly urenPerWeek?: string | null;
  readonly werkvorm?: string | null;
}

export interface EnrichmentRunResult {
  readonly aanvraagId: string;
  readonly proposals: readonly EnrichmentProposal[];
}
