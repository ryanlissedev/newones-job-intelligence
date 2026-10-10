import type { AanvraagProvenanceMap, JsonValue } from "../normalise";

export type { JsonValue } from "../normalise";

export type BronSpecifiekJson = JsonValue;

export interface AanvraagSnapshot {
  beschrijving: string;
  bron_referentie: string;
  bron_specifiek: JsonValue;
  status: string;
  tarief_eenheid: string;
  tarief_max: string;
  tarief_min: string;
  titel: string;
}

export type ProvenanceMap = AanvraagProvenanceMap;

export type OutboxPayload = JsonValue;
