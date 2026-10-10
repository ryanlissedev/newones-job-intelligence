import { boundBronReferentie } from "@ji/connectors";
import type {
  AanvraagLifecycle,
  AanvraagId,
  BronId,
  Contactpersoon,
  ScrapeRunId,
} from "@ji/domain";
import { CLEARED, CLEARED_BRON_MARKER_KEY, UNKNOWN } from "@ji/domain";
import { timeCriticalPathPhase } from "@ji/performance";
import { z } from "zod";

import type { NormalisedAanvraagDraft } from "../normalise";
import {
  buildDedupKey,
  buildProvenanceMap,
  toValidPublicationDate,
} from "../normalise";
import { classifyContractAndWork } from "../normalise/classify-contract-work";
import { mergeContactpersoonPipelineVelden } from "../normalise/contactpersonen";
import {
  resolveCanonicalContractType,
  toCanonicalContractType,
} from "../normalise/contract-type";
import type {
  AanvraagSnapshot,
  BronSpecifiekJson,
  OutboxPayload,
  ProvenanceMap,
} from "./json-types";

export type ObservationProcessingStatus =
  | "curated"
  | "quarantined"
  | "unchanged";

export interface StoredAanvraag {
  aanvraagId: AanvraagId;
  beschrijving: string;
  bronId: BronId;
  bronReferentie: string;
  bronSpecifiek: BronSpecifiekJson;
  bronUrl: string | null;
  /** CTP-610: source-published contactpersonen (0..n). Empty for bronnen
   * without contact fields or with `contactpersoon_beleid.extractie` off. */
  contactpersonen: Contactpersoon[];
  contentHash: string;
  contracttype: string | null;
  dedupGroepId: string | null;
  extractieMethode: string;
  eersteGezienOp: Date;
  eindDatum: string | null;
  laatstGezienOp: Date;
  locatieLand: string;
  locatieTekst: string | null;
  opdrachtgeverNaam: string | null;
  parserVersion: string;
  provenance: ProvenanceMap;
  publicatiedatum: string | null;
  rawPayloadRef: string;
  scrapeRunId: ScrapeRunId;
  sluitingsdatum: Date | null;
  startDatum: string | null;
  status: AanvraagLifecycle;
  tariefEenheid: string | null;
  tariefMax: string | null;
  tariefMin: string | null;
  tariefValuta: string;
  titel: string;
  urenPerWeek: string | null;
  versie: number;
  werkvorm: string | null;
}

export interface StoredAanvraagVersie {
  aanvraagId: AanvraagId;
  contentHash: string;
  geldigTot: Date | null;
  geldigVan: Date;
  rawPayloadRef: string;
  scrapeRunId: ScrapeRunId;
  snapshot: AanvraagSnapshot;
  versie: number;
  versieId: string;
}

export interface StoredDedupGroep {
  dedupGroepId: string;
  dedupKey: string;
  handmatigBevestigd: boolean;
  status: "reviewable";
}

export interface StoredOutboxEvent {
  aggregateId: AanvraagId;
  aggregateType: "aanvraag";
  eventType: string;
  id: string;
  payload: OutboxPayload;
}

export interface CurateStore {
  findAanvraagByIdentity: (
    bronId: BronId,
    bronReferentie: string
  ) => Promise<StoredAanvraag | null>;
  /**
   * Returns the one group for `dedupKey`, creating it when absent. Must be
   * safe under concurrency: two callers racing on the same key — in
   * separate transactions — both get the same group. The Postgres store
   * leans on the unique index `dedup_groep_dedup_key_uidx` for this
   * (insert ... on conflict do nothing, then re-select); a find-then-insert
   * under READ COMMITTED is not enough.
   */
  ensureDedupGroep: (input: { dedupKey: string }) => Promise<StoredDedupGroep>;
  findDedupGroepByKey: (dedupKey: string) => Promise<StoredDedupGroep | null>;
  insertAanvraag: (
    input: Omit<StoredAanvraag, "aanvraagId">
  ) => Promise<StoredAanvraag>;
  insertOutboxEvent: (
    input: Omit<StoredOutboxEvent, "id">
  ) => Promise<StoredOutboxEvent>;
  insertVersie: (
    input: Omit<StoredAanvraagVersie, "versieId">
  ) => Promise<StoredAanvraagVersie>;
  linkAanvraagToDedupGroep: (
    aanvraagId: AanvraagId,
    dedupGroepId: string
  ) => Promise<void>;
  splitDedupGroep: (dedupGroepId: string) => Promise<void>;
  updateAanvraag: (
    aanvraagId: AanvraagId,
    patch: Partial<StoredAanvraag>
  ) => Promise<StoredAanvraag>;
  closeOpenVersie: (aanvraagId: AanvraagId, closedAt: Date) => Promise<void>;
  /**
   * Runs `fn` against a store whose writes commit together or not at all
   * (RJC-399). A throw inside `fn` rolls every write back, so the SCD2
   * status write and its outbox event can never be split by a crash —
   * without the event the projector would keep the old status forever,
   * because a later same-content event is skipped by the projection hash.
   */
  withTransaction: <T>(fn: (store: CurateStore) => Promise<T>) => Promise<T>;
}

export interface CurateObservationInput {
  bronId: BronId;
  draft: NormalisedAanvraagDraft;
  observedAt: Date;
  rawPayloadRef: string;
  scrapeRunId: ScrapeRunId;
}

export interface CurateObservationResult {
  aanvraagId?: AanvraagId;
  dedupGroepId?: string;
  outboxEventId?: string;
  reason?: string;
  status: ObservationProcessingStatus;
  versie?: number;
}

/** Content change on an already-curated aanvraag; the projector reloads and upserts. */
export const AANVRAAG_GEWIJZIGD_EVENT = "aanvraag.gewijzigd";

/** Status change that carries no new content. Lives here so both writers share it. */
export const AANVRAAG_STATUS_GEWIJZIGD_EVENT = "aanvraag.status_gewijzigd";

const tariefColumn = (
  value: string | typeof UNKNOWN | typeof CLEARED
): string | null => (value === UNKNOWN || value === CLEARED ? null : value);

const bronSpecifiekRecordSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
  ])
);

type BronSpecifiekRecord = z.infer<typeof bronSpecifiekRecordSchema>;

const asBronSpecifiekRecord = (
  value: BronSpecifiekJson
): BronSpecifiekRecord => {
  const parsed = bronSpecifiekRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
};

const readExistingText = (
  record: BronSpecifiekRecord,
  ...keys: readonly string[]
): string | null => {
  for (const key of keys) {
    const value = record[key];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Zod record values are a union; string is the only commercial text shape we copy
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
};

const applyDraftTextOrCleared = (
  base: BronSpecifiekRecord,
  value: string | typeof UNKNOWN | typeof CLEARED,
  aliases: readonly string[],
  primaryKey: string
): void => {
  if (value === CLEARED) {
    for (const key of aliases) {
      base[key] = CLEARED;
    }
    return;
  }
  if (value === UNKNOWN) {
    return;
  }
  if (readExistingText(base, ...aliases) === null) {
    base[primaryKey] = value;
  }
};

const applyDraftTariefClears = (
  base: BronSpecifiekRecord,
  draft: NormalisedAanvraagDraft
): void => {
  applyDraftTextOrCleared(
    base,
    draft.tarief.min,
    ["tarief_min", "tariefMin"],
    "tarief_min"
  );
  applyDraftTextOrCleared(
    base,
    draft.tarief.max,
    ["tarief_max", "tariefMax"],
    "tarief_max"
  );
  applyDraftTextOrCleared(
    base,
    draft.tarief.eenheid,
    ["tarief_eenheid", "tariefEenheid"],
    "tarief_eenheid"
  );
  if (
    draft.tarief.min === CLEARED ||
    draft.tarief.max === CLEARED ||
    draft.tarief.eenheid === CLEARED
  ) {
    base.tarief = CLEARED;
  }
};

/**
 * Persist commercial facts that the draft already computed but that have no
 * curated column yet: merge into bron_specifiek under the keys the reader
 * already understands, and fill contracttype/werkvorm via the shared
 * classifier when the normaliser left them blank.
 */
const commercialBronSpecifiek = (
  draft: NormalisedAanvraagDraft
): BronSpecifiekJson => {
  const base: BronSpecifiekRecord = {
    ...asBronSpecifiekRecord(draft.bronSpecifiek.value),
  };
  applyDraftTextOrCleared(
    base,
    draft.opdrachtgeverNaam.value,
    ["opdrachtgever_naam", "opdrachtgeverNaam"],
    "opdrachtgever_naam"
  );
  applyDraftTextOrCleared(
    base,
    draft.startDatum.value,
    ["start_datum", "startDatum"],
    "start_datum"
  );
  // Emit CLEARED into bron_specifiek so strip/merge can write durable markers
  // for enrichment commercial fields (columns themselves store null after clear).
  applyDraftTextOrCleared(
    base,
    draft.locatieTekst.value,
    ["locatie", "locatie_tekst", "locatieTekst"],
    "locatie_tekst"
  );
  applyDraftTariefClears(base, draft);
  const classified = classifyContractAndWork(
    draft.titel.value,
    draft.beschrijving.value
  );
  const directContractType = readExistingText(
    base,
    "contracttype",
    "contract_type"
  );
  const employmentType = readExistingText(base, "employment_type");
  const hasEmploymentContractType =
    employmentType
      ?.split(",")
      .some((token) => toCanonicalContractType(token) !== null) ?? false;
  if (
    classified.contracttype &&
    directContractType === null &&
    !hasEmploymentContractType
  ) {
    base.contracttype = classified.contracttype;
  }
  if (classified.werkvorm && readExistingText(base, "werkvorm") === null) {
    base.werkvorm = classified.werkvorm;
  }
  // SAFETY: BronSpecifiekRecord is a string-keyed JSON object produced by Zod;
  // BronSpecifiekJson is the same JsonValue object shape at the curate boundary.
  return base as BronSpecifiekJson;
};

type CoalescePatch<T> =
  | { tag: "absent" }
  | { tag: "clear" }
  | { tag: "set"; value: T };

const coalescePatchFromDraft = (
  value: string | typeof UNKNOWN | typeof CLEARED
): CoalescePatch<string> => {
  if (value === CLEARED) {
    return { tag: "clear" };
  }
  if (value === UNKNOWN) {
    return { tag: "absent" };
  }
  return { tag: "set", value };
};

const applyCoalesce = <T>(
  patch: CoalescePatch<T>,
  existing: T | null
): T | null => {
  switch (patch.tag) {
    case "absent": {
      return existing;
    }
    case "clear": {
      return null;
    }
    case "set": {
      return patch.value;
    }
    default: {
      const _exhaustive: never = patch;
      return _exhaustive;
    }
  }
};

/** Sparse null keeps the prior value; use CLEARED at the draft boundary for a true clear. */
const coalesceNullable = <T>(
  incoming: T | null,
  existing: T | null
): T | null => incoming ?? existing;

const draftTextColumn = (
  value: string | typeof UNKNOWN | typeof CLEARED
): string | null => (value === UNKNOWN || value === CLEARED ? null : value);

const readBronText = (
  record: BronSpecifiekRecord,
  ...keys: readonly string[]
): string | null => {
  const value = readExistingText(record, ...keys);
  if (value === null || value === CLEARED || value === UNKNOWN) {
    return null;
  }
  return value;
};

const explicitBronText = (
  draft: NormalisedAanvraagDraft,
  ...keys: readonly string[]
): string | null =>
  readBronText(asBronSpecifiekRecord(draft.bronSpecifiek.value), ...keys);

const resolveBronContractType = (record: BronSpecifiekRecord) =>
  resolveCanonicalContractType(
    readExistingText(record, "contracttype"),
    readExistingText(record, "contract_type"),
    readExistingText(record, "employment_type")
  );

/** Hours text "0" is absent for fill/overwrite (CTP-599 / CTP-526 residual). */
const isAbsentUrenText = (value: string | null): boolean =>
  value === null || value.trim() === "" || value.trim() === "0";

const readUrenBronText = (
  record: BronSpecifiekRecord,
  ...keys: readonly string[]
): string | null => {
  const value = readBronText(record, ...keys);
  return isAbsentUrenText(value) ? null : value;
};

const coalesceUrenPerWeek = (
  incoming: string | null,
  existing: string | null
): string | null => {
  if (incoming !== null) {
    return incoming;
  }
  return isAbsentUrenText(existing) ? null : existing;
};

const UREN_BRON_KEY_SET: ReadonlySet<string> = new Set([
  "uren_max",
  "uren_min",
  "uren_per_week",
  "uren_per_week_raw",
]);

/** Raw bron_specifiek uren values may be string or number (Inhuurdesk min/max). */
type BronSpecifiekValue = BronSpecifiekRecord[string];

const isAbsentUrenBronValue = (
  value: BronSpecifiekValue | undefined
): boolean => {
  if (value === null || value === undefined) {
    return true;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Zod record union; number 0 is absent hours
  if (typeof value === "number") {
    return value === 0 || Number.isNaN(value);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- string hours use the CTP-599 text rule
  if (typeof value === "string") {
    return isAbsentUrenText(value);
  }
  return false;
};

const stripAbsentUrenBronKeys = (
  record: BronSpecifiekRecord
): BronSpecifiekRecord => {
  const next: BronSpecifiekRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (UREN_BRON_KEY_SET.has(key) && isAbsentUrenBronValue(value)) {
      continue;
    }
    next[key] = value;
  }
  return next;
};

/** Alias groups for durable CLEARED markers — clearing/lifting one lifts all. */
const CLEARED_MARKER_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["locatie", "locatie_tekst", "locatieTekst"],
  [
    "tarief",
    "tarief_min",
    "tarief_max",
    "tarief_eenheid",
    "tariefMin",
    "tariefMax",
    "tariefEenheid",
  ],
  ["opdrachtgever_naam", "opdrachtgeverNaam"],
  ["start_datum", "startDatum"],
  ["contracttype", "contract_type"],
  ["werkvorm"],
];

const expandClearedMarkerKeys = (keys: Iterable<string>): Set<string> => {
  const expanded = new Set<string>(keys);
  for (const group of CLEARED_MARKER_ALIAS_GROUPS) {
    if (group.some((key) => expanded.has(key))) {
      for (const key of group) {
        expanded.add(key);
      }
    }
  }
  return expanded;
};

const clearedMarkerSchema = z.record(z.string(), z.literal(true));
type ClearedMarkerRecord = z.infer<typeof clearedMarkerSchema>;

const omitClearedMarkers = (
  markers: ClearedMarkerRecord,
  keys: Iterable<string>
): ClearedMarkerRecord => {
  const omit = expandClearedMarkerKeys(keys);
  return clearedMarkerSchema.parse(
    Object.fromEntries(
      Object.entries(markers).filter(([key]) => !omit.has(key))
    )
  );
};

const readClearedMarkerRecord = (
  record: BronSpecifiekRecord
): ClearedMarkerRecord => {
  const parsed = clearedMarkerSchema.safeParse(record[CLEARED_BRON_MARKER_KEY]);
  return parsed.success ? parsed.data : {};
};

const writeClearedMarkers = (
  record: BronSpecifiekRecord,
  markers: ClearedMarkerRecord
): void => {
  if (Object.keys(markers).length === 0) {
    return;
  }
  record[CLEARED_BRON_MARKER_KEY] = markers;
};

/**
 * Drop CLEARED string tombstones so they never persist as commercial values,
 * while writing durable `_cleared` markers (Slice 4 / CTP-486) so enrichment
 * cannot resurrect post-strip null gaps.
 */
const stripClearedBronSpecifiek = (
  record: BronSpecifiekRecord
): BronSpecifiekRecord => {
  const markers = readClearedMarkerRecord(record);
  const newlyCleared = new Set<string>();
  const lifted = new Set<string>();
  const out: BronSpecifiekRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === CLEARED_BRON_MARKER_KEY) {
      continue;
    }
    if (value === CLEARED) {
      newlyCleared.add(key);
      continue;
    }
    out[key] = value;
    lifted.add(key);
  }
  for (const key of expandClearedMarkerKeys(newlyCleared)) {
    markers[key] = true;
  }
  writeClearedMarkers(out, omitClearedMarkers(markers, lifted));
  // SAFETY: `out` is built as BronSpecifiekRecord; strip only drops absent uren keys.
  return stripAbsentUrenBronKeys(out);
};

const mergeBronSpecifiek = (
  existing: BronSpecifiekJson,
  incoming: BronSpecifiekJson
): BronSpecifiekJson => {
  const left = asBronSpecifiekRecord(existing);
  const right = asBronSpecifiekRecord(incoming);
  const markers = readClearedMarkerRecord(left);
  const clearedKeys = new Set<string>();
  const overlays: BronSpecifiekRecord = {};
  for (const [key, value] of Object.entries(right)) {
    if (key === CLEARED_BRON_MARKER_KEY) {
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Zod record values are a union; blank/CLEARED strings are tombstones or noise
    if (typeof value === "string") {
      if (value.trim() === "") {
        continue;
      }
      if (value === CLEARED) {
        clearedKeys.add(key);
        continue;
      }
    }
    overlays[key] = value;
  }
  const merged: BronSpecifiekRecord = {};
  for (const [key, value] of Object.entries(left)) {
    if (key === CLEARED_BRON_MARKER_KEY) {
      continue;
    }
    if (!clearedKeys.has(key)) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overlays)) {
    merged[key] = value;
  }
  const afterLift = omitClearedMarkers(markers, Object.keys(overlays));
  for (const key of expandClearedMarkerKeys(clearedKeys)) {
    afterLift[key] = true;
  }
  writeClearedMarkers(merged, afterLift);
  // SAFETY: merged is a Zod-validated string-keyed JSON object; BronSpecifiekJson
  // is the JsonValue object shape stored on curated.aanvraag.bron_specifiek.
  return merged as BronSpecifiekJson;
};

/**
 * bronSpecifiek keys `toStoredFields` reads into curated columns, per column,
 * in precedence order. `scripts/source-to-ui-gap.ts` derives its "displayed"
 * set from this constant; keep it the single source of truth for that seam.
 */
export const CURATED_COLUMN_BRON_KEYS = {
  contracttype: ["contracttype", "contract_type", "employment_type"],
  eindDatum: ["eind_datum", "eindDatum"],
  publicatiedatum: [
    "publicatiedatum",
    "gepubliceerd_op",
    "publicatie_datum",
    "json_ld_date_posted",
  ],
  urenPerWeek: ["uren_per_week", "uren_per_week_raw"],
  werkvorm: ["werkvorm"],
} as const satisfies Record<string, readonly string[]>;

const toStoredFields = (
  input: CurateObservationInput
): Omit<StoredAanvraag, "aanvraagId"> => {
  const { draft } = input;
  // SAFETY: stripClearedBronSpecifiek removes CLEARED strings and may add `_cleared`
  // markers; remaining entries are still BronSpecifiekJson for curated.aanvraag.bron_specifiek.
  const bronSpecifiek = stripClearedBronSpecifiek(
    asBronSpecifiekRecord(commercialBronSpecifiek(draft))
  ) as BronSpecifiekJson;
  const bronRecord = asBronSpecifiekRecord(bronSpecifiek);
  return {
    beschrijving: draft.beschrijving.value,
    bronId: input.bronId,
    bronReferentie: draft.bronReferentie.value,
    bronSpecifiek,
    bronUrl: draftTextColumn(draft.bronUrl.value),
    contactpersonen: draft.contactpersonen?.value ?? [],
    contentHash: draft.contentHash,
    contracttype: resolveBronContractType(bronRecord),
    dedupGroepId: null,
    eersteGezienOp: input.observedAt,
    eindDatum: readBronText(bronRecord, ...CURATED_COLUMN_BRON_KEYS.eindDatum),
    extractieMethode: draft.extractieMethode,
    laatstGezienOp: input.observedAt,
    locatieLand: draft.locatieLand.value,
    locatieTekst: draftTextColumn(draft.locatieTekst.value),
    opdrachtgeverNaam: draftTextColumn(draft.opdrachtgeverNaam.value),
    parserVersion: draft.parserVersion,
    provenance: buildProvenanceMap(draft),
    publicatiedatum: toValidPublicationDate(
      readBronText(bronRecord, ...CURATED_COLUMN_BRON_KEYS.publicatiedatum)
    ),
    rawPayloadRef: input.rawPayloadRef,
    scrapeRunId: input.scrapeRunId,
    sluitingsdatum: draft.sluitingsdatum ?? null,
    startDatum: draftTextColumn(draft.startDatum.value),
    status: draft.status,
    tariefEenheid: tariefColumn(draft.tarief.eenheid),
    tariefMax: tariefColumn(draft.tarief.max),
    tariefMin: tariefColumn(draft.tarief.min),
    tariefValuta: draft.tarief.valuta,
    titel: draft.titel.value,
    urenPerWeek: readUrenBronText(
      bronRecord,
      ...CURATED_COLUMN_BRON_KEYS.urenPerWeek
    ),
    versie: 1,
    werkvorm: readBronText(bronRecord, ...CURATED_COLUMN_BRON_KEYS.werkvorm),
  };
};

/** Shared with the lifecycle reconcile step so status-only versions carry the same snapshot shape. */
export const buildSnapshot = (stored: StoredAanvraag): AanvraagSnapshot => ({
  beschrijving: stored.beschrijving,
  bron_referentie: stored.bronReferentie,
  bron_specifiek: stored.bronSpecifiek,
  status: stored.status,
  tarief_eenheid: stored.tariefEenheid ?? UNKNOWN,
  tarief_max: stored.tariefMax ?? UNKNOWN,
  tarief_min: stored.tariefMin ?? UNKNOWN,
  titel: stored.titel,
});

const ensureDedupGroep = (
  store: CurateStore,
  draft: NormalisedAanvraagDraft
): Promise<StoredDedupGroep> =>
  store.ensureDedupGroep({
    dedupKey: buildDedupKey({
      opdrachtgeverNaam: draft.opdrachtgeverNaam.value,
      startDatum: draft.startDatum.value,
      titel: draft.titel.value,
    }),
  });

/**
 * Fields the unchanged-content path may still move on an already-curated row.
 *
 * Only fields that actually differ from the stored row are returned, so an
 * observation that moves nothing writes nothing -- and, through the caller,
 * enqueues nothing.
 *
 * RJC-394 fix-first: an unchanged raw payload still needs to surface
 * locatie_tekst/sluitingsdatum on an already-curated row -- otherwise a
 * listing whose source content never changes again would never get these
 * columns filled, making the degraded (country-code/sentinel) state permanent
 * instead of transitional. Only write when the draft actually has a value: a
 * source that stops publishing a deadline must never silently erase a value
 * already stored from an earlier observation.
 */

const mergeOpleidingsniveauPatch = (
  draft: NormalisedAanvraagDraft,
  existing: StoredAanvraag
): BronSpecifiekJson | undefined => {
  const nextEducation = explicitBronText(
    draft,
    "opleidingsniveau",
    "education_level"
  );
  if (nextEducation === null) {
    return undefined;
  }
  const existingBron = asBronSpecifiekRecord(existing.bronSpecifiek);
  if (
    readBronText(existingBron, "opleidingsniveau", "education_level") !== null
  ) {
    return undefined;
  }
  // SAFETY: BronSpecifiekRecord is a string-keyed JSON object; BronSpecifiekJson
  // is the same JsonValue object shape at the curate boundary.
  return {
    ...existingBron,
    ...asBronSpecifiekRecord(draft.bronSpecifiek.value),
    opleidingsniveau: nextEducation,
  } as BronSpecifiekJson;
};

const fillNullCommercialColumns = (
  draft: NormalisedAanvraagDraft,
  existing: StoredAanvraag,
  patch: Partial<StoredAanvraag>
): void => {
  if (isAbsentUrenText(existing.urenPerWeek)) {
    const value = readUrenBronText(
      asBronSpecifiekRecord(draft.bronSpecifiek.value),
      "uren_per_week",
      "uren_per_week_raw"
    );
    if (value !== null) {
      patch.urenPerWeek = value;
    }
  }
  if (
    existing.tariefMin === null &&
    existing.tariefMax === null &&
    existing.tariefEenheid === null
  ) {
    const min = tariefColumn(draft.tarief.min);
    const max = tariefColumn(draft.tarief.max);
    const eenheid = tariefColumn(draft.tarief.eenheid);
    if (min !== null || max !== null) {
      patch.tariefMin = min;
      patch.tariefMax = max;
      patch.tariefEenheid = eenheid;
      patch.tariefValuta = draft.tarief.valuta;
    }
  }
};

/** CTP-610: rows curated before a bron gained contact extraction (or before
 * migratie 0026) hold []. When the unchanged draft now carries contacts,
 * backfill them — same staleness class as locatieTekst/sluitingsdatum. */
const contactpersonenBackfill = (
  draft: NormalisedAanvraagDraft,
  existing: StoredAanvraag
): Contactpersoon[] | undefined => {
  if (existing.contactpersonen.length > 0) {
    return;
  }
  const value = draft.contactpersonen?.value;
  return value && value.length > 0 ? value : undefined;
};

const buildUnchangedContentPatch = (
  input: CurateObservationInput,
  existing: StoredAanvraag
): Partial<StoredAanvraag> => {
  const { draft } = input;
  const patch: Partial<StoredAanvraag> = {};
  if (input.observedAt.getTime() > existing.laatstGezienOp.getTime()) {
    patch.laatstGezienOp = input.observedAt;
  }
  if (draft.status !== existing.status) {
    patch.status = draft.status;
  }
  if (
    draft.locatieTekst.value !== UNKNOWN &&
    draft.locatieTekst.value !== existing.locatieTekst
  ) {
    patch.locatieTekst = draft.locatieTekst.value;
  }
  if (existing.opdrachtgeverNaam === null) {
    const value = draftTextColumn(draft.opdrachtgeverNaam.value);
    if (value !== null) {
      patch.opdrachtgeverNaam = value;
    }
  }
  const startDatum = draftTextColumn(draft.startDatum.value);
  if (startDatum !== null && startDatum !== existing.startDatum) {
    patch.startDatum = startDatum;
  }
  if (existing.publicatiedatum === null) {
    const value = toValidPublicationDate(
      readBronText(
        asBronSpecifiekRecord(draft.bronSpecifiek.value),
        ...CURATED_COLUMN_BRON_KEYS.publicatiedatum
      )
    );
    if (value !== null) {
      patch.publicatiedatum = value;
    }
  }
  if (existing.contracttype === null) {
    const value = resolveBronContractType(
      asBronSpecifiekRecord(draft.bronSpecifiek.value)
    );
    if (value !== null) {
      patch.contracttype = value;
    }
  }
  if (existing.werkvorm === null) {
    const value = explicitBronText(draft, "werkvorm");
    if (value !== null) {
      patch.werkvorm = value;
    }
  }
  fillNullCommercialColumns(draft, existing, patch);
  const educationPatch = mergeOpleidingsniveauPatch(draft, existing);
  if (educationPatch !== undefined) {
    patch.bronSpecifiek = educationPatch;
  }
  if (
    draft.sluitingsdatum !== undefined &&
    draft.sluitingsdatum.getTime() !== existing.sluitingsdatum?.getTime()
  ) {
    patch.sluitingsdatum = draft.sluitingsdatum;
  }
  const backfilledContactpersonen = contactpersonenBackfill(draft, existing);
  if (backfilledContactpersonen) {
    patch.contactpersonen = backfilledContactpersonen;
  }
  return patch;
};

/**
 * Observation whose content hash equals the stored one (CTP-498).
 *
 * Every field this path can move -- `laatst_gezien_op`, `status`, `locatie`,
 * `sluitingsdatum`, `contracttype` -- is part of the search document and so of
 * the projection hash, and the projector skips a later same-content event.
 * A write here therefore has to enqueue its own outbox event or the Manticore
 * index keeps a closed aanvraag active and a stale last-seen date until the
 * content changes. The event is bound to the row write by one transaction
 * (RJC-399), with the outbox insert last.
 *
 * Event type: the projector has no per-type dispatch apart from
 * `aanvraag.verwijderd` (packages/search/src/projector.ts), so every other
 * type is "reload the aggregate and upsert". The two existing types therefore
 * carry this without a projector change: `aanvraag.status_gewijzigd` for a
 * status flip, matching the lifecycle reconcile writer, and `aanvraag.gewijzigd`
 * for a seen-only or derived-column move.
 *
 * `versie` moves only for a status flip: `status` is the one field here that
 * `buildSnapshot` records, so a flip without a new SCD2 version would leave the
 * open version's snapshot contradicting the row. The other fields are absent
 * from the snapshot, so a version for them would carry no new information.
 */
const curateUnchangedContent = (
  store: CurateStore,
  input: CurateObservationInput,
  existing: StoredAanvraag
): Promise<CurateObservationResult> => {
  const patch = buildUnchangedContentPatch(input, existing);
  if (Object.keys(patch).length === 0) {
    return Promise.resolve<CurateObservationResult>({
      aanvraagId: existing.aanvraagId,
      status: "unchanged",
    });
  }

  const statusChanged = patch.status !== undefined;
  const versie = existing.versie + 1;

  return store.withTransaction(async (tx) => {
    const rowPatch: Partial<StoredAanvraag> = { ...patch };
    if (statusChanged) {
      rowPatch.versie = versie;
      await tx.closeOpenVersie(existing.aanvraagId, input.observedAt);
    }
    const updated = await tx.updateAanvraag(existing.aanvraagId, rowPatch);
    if (statusChanged) {
      await tx.insertVersie({
        aanvraagId: updated.aanvraagId,
        contentHash: updated.contentHash,
        geldigTot: null,
        geldigVan: input.observedAt,
        rawPayloadRef: updated.rawPayloadRef,
        scrapeRunId: input.scrapeRunId,
        snapshot: buildSnapshot(updated),
        versie,
      });
    }
    const basePayload = {
      content_hash: updated.contentHash,
      parser_version: updated.parserVersion,
      scrape_run_id: input.scrapeRunId,
    };
    // The projector pins a payload status over the loaded row, so a status
    // flip stays correct even when the row moved on before the drain.
    const payload = statusChanged
      ? { ...basePayload, status: updated.status }
      : basePayload;
    const outbox = await timeCriticalPathPhase("ingest-outbox", () =>
      tx.insertOutboxEvent({
        aggregateId: updated.aanvraagId,
        aggregateType: "aanvraag",
        eventType: statusChanged
          ? AANVRAAG_STATUS_GEWIJZIGD_EVENT
          : AANVRAAG_GEWIJZIGD_EVENT,
        payload,
      })
    );
    const result: CurateObservationResult = {
      aanvraagId: updated.aanvraagId,
      outboxEventId: outbox.id,
      status: "unchanged",
    };
    if (statusChanged) {
      result.versie = versie;
    }
    return result;
  });
};

/**
 * CTP-500: every curated write (live ingest and backfill) enters here, so
 * this is where the draft's `bron_referentie` takes the same bounded form
 * the staging write gave it in `runConnector`.
 */
const withBoundedBronReferentie = (
  input: CurateObservationInput
): CurateObservationInput => ({
  ...input,
  draft: {
    ...input.draft,
    bronReferentie: {
      ...input.draft.bronReferentie,
      value: boundBronReferentie(input.draft.bronReferentie.value),
    },
  },
});

export const curateObservation = async (
  store: CurateStore,
  rawInput: CurateObservationInput
): Promise<CurateObservationResult> => {
  const input = withBoundedBronReferentie(rawInput);
  const existing = await store.findAanvraagByIdentity(
    input.bronId,
    input.draft.bronReferentie.value
  );

  if (existing && existing.contentHash === input.draft.contentHash) {
    return curateUnchangedContent(store, input, existing);
  }

  // One transaction per mutation (RJC-399): versie + aanvraag + outbox
  // commit together, with the outbox insert last, so a crash can never
  // leave Postgres on a new status while the search index keeps the old.
  if (!existing) {
    return store.withTransaction(async (tx) => {
      const created = await tx.insertAanvraag(toStoredFields(input));
      const dedupGroep = await timeCriticalPathPhase("ingest-dedupe", () =>
        ensureDedupGroep(tx, input.draft)
      );
      await tx.linkAanvraagToDedupGroep(
        created.aanvraagId,
        dedupGroep.dedupGroepId
      );
      await tx.insertVersie({
        aanvraagId: created.aanvraagId,
        contentHash: created.contentHash,
        geldigTot: null,
        geldigVan: input.observedAt,
        rawPayloadRef: created.rawPayloadRef,
        scrapeRunId: created.scrapeRunId,
        snapshot: buildSnapshot(created),
        versie: 1,
      });
      const outbox = await timeCriticalPathPhase("ingest-outbox", () =>
        tx.insertOutboxEvent({
          aggregateId: created.aanvraagId,
          aggregateType: "aanvraag",
          eventType: "aanvraag.nieuw",
          payload: {
            bron_id: created.bronId,
            bron_referentie: created.bronReferentie,
            parser_version: created.parserVersion,
          },
        })
      );
      return {
        aanvraagId: created.aanvraagId,
        dedupGroepId: dedupGroep.dedupGroepId,
        outboxEventId: outbox.id,
        status: "curated",
        versie: 1,
      };
    });
  }

  const nextVersie = existing.versie + 1;
  const closedAt = input.observedAt;
  return store.withTransaction(async (tx) => {
    await tx.closeOpenVersie(existing.aanvraagId, closedAt);
    const next = toStoredFields(input);
    const { draft } = input;
    // Merge against commercialBronSpecifiek *before* strip so CLEARED
    // tombstones still reach mergeBronSpecifiek (drop keys + durable markers).
    // SAFETY: strip removes CLEARED strings / keeps `_cleared`; remainder is
    // still BronSpecifiekJson for curated.aanvraag.bron_specifiek.
    const mergedBronSpecifiek = stripClearedBronSpecifiek(
      asBronSpecifiekRecord(
        mergeBronSpecifiek(
          existing.bronSpecifiek,
          commercialBronSpecifiek(draft)
        )
      )
    ) as BronSpecifiekJson;
    const updated = await tx.updateAanvraag(existing.aanvraagId, {
      ...next,
      bronSpecifiek: mergedBronSpecifiek,
      bronUrl: applyCoalesce(
        coalescePatchFromDraft(draft.bronUrl.value),
        existing.bronUrl
      ),
      // Pipeline-owned art. 14 fields (geinformeerdOp, notificatieKanaal) are
      // not source data — carry them forward per contact identity instead of
      // letting the draft's null-emitting list erase the disclosure trail.
      contactpersonen: mergeContactpersoonPipelineVelden(
        existing.contactpersonen,
        next.contactpersonen
      ),
      contracttype: coalesceNullable(
        resolveBronContractType(
          asBronSpecifiekRecord(draft.bronSpecifiek.value)
        ),
        existing.contracttype
      ),
      dedupGroepId: existing.dedupGroepId,
      eersteGezienOp: existing.eersteGezienOp,
      eindDatum: coalesceNullable(next.eindDatum, existing.eindDatum),
      locatieTekst: applyCoalesce(
        coalescePatchFromDraft(draft.locatieTekst.value),
        existing.locatieTekst
      ),
      opdrachtgeverNaam: applyCoalesce(
        coalescePatchFromDraft(draft.opdrachtgeverNaam.value),
        existing.opdrachtgeverNaam
      ),
      publicatiedatum: coalesceNullable(
        next.publicatiedatum,
        existing.publicatiedatum
      ),
      sluitingsdatum: coalesceNullable(
        next.sluitingsdatum,
        existing.sluitingsdatum
      ),
      startDatum: applyCoalesce(
        coalescePatchFromDraft(draft.startDatum.value),
        existing.startDatum
      ),
      tariefEenheid: applyCoalesce(
        coalescePatchFromDraft(draft.tarief.eenheid),
        existing.tariefEenheid
      ),
      tariefMax: applyCoalesce(
        coalescePatchFromDraft(draft.tarief.max),
        existing.tariefMax
      ),
      tariefMin: applyCoalesce(
        coalescePatchFromDraft(draft.tarief.min),
        existing.tariefMin
      ),
      urenPerWeek: coalesceUrenPerWeek(next.urenPerWeek, existing.urenPerWeek),
      versie: nextVersie,
      werkvorm: coalesceNullable(
        explicitBronText(draft, "werkvorm"),
        existing.werkvorm
      ),
    });
    await tx.insertVersie({
      aanvraagId: updated.aanvraagId,
      contentHash: updated.contentHash,
      geldigTot: null,
      geldigVan: closedAt,
      rawPayloadRef: updated.rawPayloadRef,
      scrapeRunId: updated.scrapeRunId,
      snapshot: buildSnapshot(updated),
      versie: nextVersie,
    });
    const outbox = await timeCriticalPathPhase("ingest-outbox", () =>
      tx.insertOutboxEvent({
        aggregateId: updated.aanvraagId,
        aggregateType: "aanvraag",
        eventType: AANVRAAG_GEWIJZIGD_EVENT,
        payload: {
          content_hash: updated.contentHash,
          parser_version: updated.parserVersion,
        },
      })
    );
    return {
      aanvraagId: updated.aanvraagId,
      outboxEventId: outbox.id,
      status: "curated",
      versie: nextVersie,
    };
  });
};

export const splitDedupGroep = (
  store: CurateStore,
  dedupGroepId: string
): Promise<void> => store.splitDedupGroep(dedupGroepId);
