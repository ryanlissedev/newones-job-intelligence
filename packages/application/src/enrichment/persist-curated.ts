import { isTitleFallbackDescription } from "../title-fallback-description";
import type { TitleFallbackDescriptionParts } from "../title-fallback-description";
import { readDurableClearedKeys } from "./cleared-markers";
import { isClearedText, isMissingText } from "./gap-predicates";
import type {
  EnrichmentContractValue,
  EnrichmentBeschrijvingValue,
  EnrichmentEinddatumValue,
  EnrichmentField,
  EnrichmentFieldValue,
  EnrichmentLocatieValue,
  EnrichmentOrganisatieValue,
  EnrichmentProposal,
  EnrichmentPublicatiedatumValue,
  EnrichmentRemoteValue,
  EnrichmentSluitingsdatumValue,
  EnrichmentStartdatumValue,
  EnrichmentTariefValue,
  EnrichmentUrenValue,
} from "./types";
import { ENRICHMENT_APPLY_MIN_CONFIDENCE } from "./types";

/**
 * Curated commercial facts enrichment may fill. CLEARED means a true clear
 * tombstone from #213 coalesce — never resurrect those keys.
 */
export interface CuratedCommercialFacts {
  readonly beschrijving: string;
  readonly bronSpecifiek?: unknown;
  readonly contracttype: string | null;
  readonly eindDatum: string | null;
  readonly locatieTekst: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly publicatiedatum: string | null;
  readonly sluitingsdatum: string | null;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefMin: string | null;
  readonly tariefValuta: string | null;
  readonly titleFallbackParts?: TitleFallbackDescriptionParts | null;
  readonly urenPerWeek: string | null;
  readonly werkvorm: string | null;
}

export interface CuratedEnrichmentPatch {
  readonly beschrijving?: string;
  readonly contracttype?: string;
  readonly eindDatum?: string;
  readonly fields: readonly EnrichmentField[];
  readonly locatieTekst?: string;
  readonly opdrachtgeverNaam?: string;
  readonly publicatiedatum?: string;
  /** ISO date (`YYYY-MM-DD`) or ISO datetime; the store resolves it to the
   * closing instant via `closingMomentInstant` before writing timestamptz. */
  readonly sluitingsdatum?: string;
  readonly startDatum?: string;
  readonly tariefEenheid?: string;
  readonly tariefMax?: string;
  readonly tariefMin?: string;
  readonly tariefValuta?: string;
  readonly urenPerWeek?: string;
  readonly werkvorm?: string;
}

class PatchBuilder {
  beschrijving?: string;
  contracttype?: string;
  eindDatum?: string;
  locatieTekst?: string;
  opdrachtgeverNaam?: string;
  publicatiedatum?: string;
  sluitingsdatum?: string;
  startDatum?: string;
  tariefEenheid?: string;
  tariefMax?: string;
  tariefMin?: string;
  tariefValuta?: string;
  urenPerWeek?: string;
  werkvorm?: string;
  readonly fields: EnrichmentField[] = [];

  addLocatie(value: string): void {
    this.locatieTekst = value;
    this.fields.push("locatie");
  }

  addTarief(parts: {
    readonly eenheid: string | null;
    readonly max: string | null;
    readonly min: string | null;
    readonly valuta: string | null;
  }): void {
    if (parts.min !== null) {
      this.tariefMin = parts.min;
    }
    if (parts.max !== null) {
      this.tariefMax = parts.max;
    }
    if (parts.eenheid !== null) {
      this.tariefEenheid = parts.eenheid;
    }
    if (parts.valuta !== null) {
      this.tariefValuta = parts.valuta;
    }
    this.fields.push("tarief");
  }

  addContract(value: string): void {
    this.contracttype = value;
    this.fields.push("contract");
  }

  addRemote(value: string): void {
    this.werkvorm = value;
    this.fields.push("remote");
  }

  addPublicatiedatum(value: string): void {
    this.publicatiedatum = value;
    this.fields.push("publicatiedatum");
  }

  addBeschrijving(value: string): void {
    this.beschrijving = value;
    this.fields.push("beschrijving");
  }

  addUren(value: string): void {
    this.urenPerWeek = value;
    this.fields.push("uren");
  }

  addStartdatum(value: string): void {
    this.startDatum = value;
    this.fields.push("startdatum");
  }

  addEinddatum(value: string): void {
    this.eindDatum = value;
    this.fields.push("einddatum");
  }

  addSluitingsdatum(value: string): void {
    this.sluitingsdatum = value;
    this.fields.push("sluitingsdatum");
  }

  addOrganisatie(value: string): void {
    this.opdrachtgeverNaam = value;
    this.fields.push("organisatie");
  }

  build(): CuratedEnrichmentPatch | null {
    if (this.fields.length === 0) {
      return null;
    }
    const result: CuratedEnrichmentPatch = { fields: this.fields };
    if (this.beschrijving !== undefined) {
      Object.assign(result, { beschrijving: this.beschrijving });
    }
    if (this.locatieTekst !== undefined) {
      Object.assign(result, { locatieTekst: this.locatieTekst });
    }
    if (this.tariefEenheid !== undefined) {
      Object.assign(result, { tariefEenheid: this.tariefEenheid });
    }
    if (this.tariefMax !== undefined) {
      Object.assign(result, { tariefMax: this.tariefMax });
    }
    if (this.tariefMin !== undefined) {
      Object.assign(result, { tariefMin: this.tariefMin });
    }
    if (this.tariefValuta !== undefined) {
      Object.assign(result, { tariefValuta: this.tariefValuta });
    }
    if (this.contracttype !== undefined) {
      Object.assign(result, { contracttype: this.contracttype });
    }
    if (this.werkvorm !== undefined) {
      Object.assign(result, { werkvorm: this.werkvorm });
    }
    if (this.publicatiedatum !== undefined) {
      Object.assign(result, { publicatiedatum: this.publicatiedatum });
    }
    if (this.urenPerWeek !== undefined) {
      Object.assign(result, { urenPerWeek: this.urenPerWeek });
    }
    if (this.startDatum !== undefined) {
      Object.assign(result, { startDatum: this.startDatum });
    }
    if (this.eindDatum !== undefined) {
      Object.assign(result, { eindDatum: this.eindDatum });
    }
    if (this.sluitingsdatum !== undefined) {
      Object.assign(result, { sluitingsdatum: this.sluitingsdatum });
    }
    if (this.opdrachtgeverNaam !== undefined) {
      Object.assign(result, { opdrachtgeverNaam: this.opdrachtgeverNaam });
    }
    return result;
  }
}

const isMissingTarief = (facts: CuratedCommercialFacts): boolean =>
  isMissingText(facts.tariefMin) &&
  isMissingText(facts.tariefMax) &&
  isMissingText(facts.tariefEenheid);

const isClearedTarief = (facts: CuratedCommercialFacts): boolean =>
  isClearedText(facts.tariefMin) ||
  isClearedText(facts.tariefMax) ||
  isClearedText(facts.tariefEenheid);

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

const locatieCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.locatieTekst) ||
  bronCleared.has("locatie") ||
  bronCleared.has("locatie_tekst") ||
  bronCleared.has("locatieTekst");

const contractCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.contracttype) ||
  bronCleared.has("contracttype") ||
  bronCleared.has("contract_type");

const remoteCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean => isClearedText(facts.werkvorm) || bronCleared.has("werkvorm");

const publicatiedatumCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.publicatiedatum) ||
  bronCleared.has("publicatiedatum") ||
  bronCleared.has("gepubliceerd_op") ||
  bronCleared.has("publicatie_datum");

const urenCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.urenPerWeek) ||
  bronCleared.has("uren") ||
  bronCleared.has("uren_per_week") ||
  bronCleared.has("urenPerWeek");

const startdatumCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.startDatum) ||
  bronCleared.has("startdatum") ||
  bronCleared.has("start_datum") ||
  bronCleared.has("startDatum");

const einddatumCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.eindDatum) ||
  bronCleared.has("einddatum") ||
  bronCleared.has("eind_datum") ||
  bronCleared.has("eindDatum");

const sluitingsdatumCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.sluitingsdatum) ||
  bronCleared.has("sluitingsdatum") ||
  bronCleared.has("sluitings_datum") ||
  bronCleared.has("valid_through");

const organisatieCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedText(facts.opdrachtgeverNaam) ||
  bronCleared.has("organisatie") ||
  bronCleared.has("opdrachtgever") ||
  bronCleared.has("opdrachtgever_naam") ||
  bronCleared.has("opdrachtgeverNaam");

const tryAddBeschrijving = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (bronCleared.has("beschrijving")) {
    return;
  }
  if (
    !isTitleFallbackDescription(facts.beschrijving, facts.titleFallbackParts)
  ) {
    return;
  }
  const value = asBeschrijving(proposal.value);
  if (
    !value ||
    value.beschrijving.trim() === "" ||
    isTitleFallbackDescription(value.beschrijving, facts.titleFallbackParts)
  ) {
    return;
  }
  builder.addBeschrijving(value.beschrijving.trim());
};

const tariefCleared = (
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>
): boolean =>
  isClearedTarief(facts) ||
  bronCleared.has("tarief") ||
  bronCleared.has("tarief_min") ||
  bronCleared.has("tarief_max") ||
  bronCleared.has("tarief_eenheid") ||
  bronCleared.has("tariefMin") ||
  bronCleared.has("tariefMax") ||
  bronCleared.has("tariefEenheid");

const normalizeTariefPart = (raw: string): string | null => {
  if (isMissingText(raw) || isClearedText(raw)) {
    return null;
  }
  return raw.trim();
};

const tryAddLocatie = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (
    locatieCleared(facts, bronCleared) ||
    !isMissingText(facts.locatieTekst)
  ) {
    return;
  }
  const value = asLocatie(proposal.value);
  if (
    !value ||
    isMissingText(value.locatieTekst) ||
    isClearedText(value.locatieTekst)
  ) {
    return;
  }
  builder.addLocatie(value.locatieTekst.trim());
};

const tryAddTarief = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (tariefCleared(facts, bronCleared) || !isMissingTarief(facts)) {
    return;
  }
  const value = asTarief(proposal.value);
  if (!value) {
    return;
  }
  const min = normalizeTariefPart(value.min);
  const max = normalizeTariefPart(value.max);
  const eenheid = normalizeTariefPart(value.eenheid);
  const valuta = normalizeTariefPart(value.valuta);
  if (min === null && max === null && eenheid === null) {
    return;
  }
  builder.addTarief({ eenheid, max, min, valuta });
};

const tryAddContract = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (
    contractCleared(facts, bronCleared) ||
    !isMissingText(facts.contracttype)
  ) {
    return;
  }
  const value = asContract(proposal.value);
  if (
    !value ||
    isMissingText(value.contracttype) ||
    isClearedText(value.contracttype)
  ) {
    return;
  }
  builder.addContract(value.contracttype.trim());
};

const tryAddRemote = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (remoteCleared(facts, bronCleared) || !isMissingText(facts.werkvorm)) {
    return;
  }
  const value = asRemote(proposal.value);
  if (
    !value ||
    isMissingText(value.werkvorm) ||
    isClearedText(value.werkvorm)
  ) {
    return;
  }
  builder.addRemote(value.werkvorm.trim());
};

const tryAddPublicatiedatum = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (
    publicatiedatumCleared(facts, bronCleared) ||
    !isMissingText(facts.publicatiedatum)
  ) {
    return;
  }
  const value = asPublicatiedatum(proposal.value);
  if (
    !value ||
    isMissingText(value.publicatiedatum) ||
    isClearedText(value.publicatiedatum)
  ) {
    return;
  }
  builder.addPublicatiedatum(value.publicatiedatum.trim());
};

const tryAddUren = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (urenCleared(facts, bronCleared) || !isMissingText(facts.urenPerWeek)) {
    return;
  }
  const value = asUren(proposal.value);
  if (
    !value ||
    isMissingText(value.urenPerWeek) ||
    isClearedText(value.urenPerWeek)
  ) {
    return;
  }
  builder.addUren(value.urenPerWeek.trim());
};

const tryAddStartdatum = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (
    startdatumCleared(facts, bronCleared) ||
    !isMissingText(facts.startDatum)
  ) {
    return;
  }
  const value = asStartdatum(proposal.value);
  if (
    !value ||
    isMissingText(value.startdatum) ||
    isClearedText(value.startdatum)
  ) {
    return;
  }
  builder.addStartdatum(value.startdatum.trim());
};

const tryAddEinddatum = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (einddatumCleared(facts, bronCleared) || !isMissingText(facts.eindDatum)) {
    return;
  }
  const value = asEinddatum(proposal.value);
  if (
    !value ||
    isMissingText(value.einddatum) ||
    isClearedText(value.einddatum)
  ) {
    return;
  }
  builder.addEinddatum(value.einddatum.trim());
};

const tryAddSluitingsdatum = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (
    sluitingsdatumCleared(facts, bronCleared) ||
    !isMissingText(facts.sluitingsdatum)
  ) {
    return;
  }
  const value = asSluitingsdatum(proposal.value);
  if (
    !value ||
    isMissingText(value.sluitingsdatum) ||
    isClearedText(value.sluitingsdatum)
  ) {
    return;
  }
  builder.addSluitingsdatum(value.sluitingsdatum.trim());
};

const tryAddOrganisatie = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (
    organisatieCleared(facts, bronCleared) ||
    !isMissingText(facts.opdrachtgeverNaam)
  ) {
    return;
  }
  const value = asOrganisatie(proposal.value);
  if (
    !value ||
    isMissingText(value.organisatie) ||
    isClearedText(value.organisatie)
  ) {
    return;
  }
  builder.addOrganisatie(value.organisatie.trim());
};

/** `opleidingsniveau` has no first-class curated column -- the persisted
 * aanvraag_enrichment row still surfaces it through the read overlay and the
 * aangevuld badge, so there is no curated-column write to plan. */
const tryAddOpleiding = (): void => {
  // Intentional no-op: see docblock above.
};

const fieldAppliers = {
  beschrijving: tryAddBeschrijving,
  contract: tryAddContract,
  einddatum: tryAddEinddatum,
  locatie: tryAddLocatie,
  opleiding: tryAddOpleiding,
  organisatie: tryAddOrganisatie,
  publicatiedatum: tryAddPublicatiedatum,
  remote: tryAddRemote,
  sluitingsdatum: tryAddSluitingsdatum,
  startdatum: tryAddStartdatum,
  tarief: tryAddTarief,
  uren: tryAddUren,
} satisfies Record<
  EnrichmentField,
  (
    builder: PatchBuilder,
    facts: CuratedCommercialFacts,
    bronCleared: ReadonlySet<string>,
    proposal: EnrichmentProposal
  ) => void
>;

const applyProposal = (
  builder: PatchBuilder,
  facts: CuratedCommercialFacts,
  bronCleared: ReadonlySet<string>,
  proposal: EnrichmentProposal
): void => {
  if (proposal.confidence < ENRICHMENT_APPLY_MIN_CONFIDENCE) {
    return;
  }
  fieldAppliers[proposal.field](builder, facts, bronCleared, proposal);
};

/**
 * Plan curated commercial column writes from high-confidence enrichment
 * proposals. #213 CLEARED coalesce wins: cleared keys and durable `_cleared`
 * markers (Slice 4) are never resurrected; published bron values are never
 * overwritten; only null/unknown gaps fill.
 */
export const planCuratedEnrichmentPatch = (
  facts: CuratedCommercialFacts,
  proposals: readonly EnrichmentProposal[]
): CuratedEnrichmentPatch | null => {
  const bronCleared = readDurableClearedKeys(facts.bronSpecifiek);
  const builder = new PatchBuilder();
  for (const proposal of proposals) {
    applyProposal(builder, facts, bronCleared, proposal);
  }
  return builder.build();
};
