import type { StriiveFetchedPayload } from "@ji/connectors/striive";
import { STRIIVE_PARSER_VERSION } from "@ji/connectors/striive";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { toDraftContactpersonen } from "./contactpersonen";
import { formatHoursPerWeek } from "./hours";
import { findProvincieInText } from "./provincie";
import { normaliseSkills } from "./skills";
import {
  closingMomentInstant,
  field,
  hasClosingMomentPassed,
  isPresent,
  numberToStringOrUnknown,
  stripHtml,
} from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

/** ISO datetime -> ISO date (`YYYY-MM-DD`); UNKNOWN when absent. Striive's
 * date fields are ISO datetimes with a time component (e.g.
 * "2026-09-13T22:00:00"), but the canonical fields are date-only. */
const toDateOnly = (raw: string | null | undefined): string | typeof UNKNOWN =>
  raw?.slice(0, 10) || UNKNOWN;

const UNKNOWN_TARIEF: NormalisedTarief = {
  eenheid: UNKNOWN,
  max: UNKNOWN,
  min: UNKNOWN,
  valuta: "EUR",
};

/**
 * Maps Striive's structured rate fields to the draft `tarief` (CTP-524,
 * F09). A live 109-record capture on 2026-08-31 found every tariff field
 * zero/false across the whole listing, so this was previously hardcoded to
 * UNKNOWN_TARIEF; that was a capture-time observation, not a schema
 * guarantee, so a future capture with real values must be honestly mapped
 * instead of silently dropped. `rateType`'s encoding was never documented
 * (only `0` observed live) -- eenheid is derived structurally instead, from
 * which rate fields are actually populated, never from `rateType`.
 */
/** A rate field of exactly 0 is the unusable placeholder the 2026-08-31
 * probe confirmed across the whole listing, never a real €0 rate. */
const isRealRate = (value: number | null | undefined): boolean =>
  isPresent(value) && value > 0;

const rateAmountOrUnknown = (
  value: number | null | undefined
): string | typeof UNKNOWN => (isRealRate(value) ? String(value) : UNKNOWN);

/** `hourlyRateClient` (the client-facing bill rate) is deliberately never
 * read here -- it is not the supplier tarief this draft field represents,
 * and mapping it would misattribute a different party's rate. */
const resolveTarief = (job: StriiveFetchedPayload["job"]): NormalisedTarief => {
  const hourlyMin = job.hourlyRateMin;
  const hourlyMax = job.hourlyRateMax;
  const monthlyMin = job.monthlyRateMin;
  const monthlyMax = job.monthlyRateMax;
  const hasHourly = isRealRate(hourlyMin) || isRealRate(hourlyMax);
  const hasMonthly = isRealRate(monthlyMin) || isRealRate(monthlyMax);
  // `hasMaxRate: false` is the source's own signal that no upper bound is
  // published, even when hourlyRateMax/monthlyRateMax happens to carry a
  // number -- honour it over the raw max field.
  const maxHonoured = job.hasMaxRate === false;
  if (hasHourly) {
    return {
      eenheid: "uur",
      max: maxHonoured ? UNKNOWN : rateAmountOrUnknown(hourlyMax),
      min: rateAmountOrUnknown(hourlyMin),
      valuta: "EUR",
    };
  }
  if (hasMonthly) {
    return {
      eenheid: "maand",
      max: maxHonoured ? UNKNOWN : rateAmountOrUnknown(monthlyMax),
      min: rateAmountOrUnknown(monthlyMin),
      valuta: "EUR",
    };
  }
  return UNKNOWN_TARIEF;
};

/** Projects the GeoJSON point into a plain object literal for bronSpecifiek.
 * `StriiveGeoPoint` is a declared interface, and interfaces get no implicit
 * index signature -- assigning it directly where a `JsonValue` (an indexed
 * object type) is expected fails to type-check even though the shape is
 * plain data. Building a fresh literal here sidesteps that and doubles as
 * an explicit DEC-008 whitelist of the point's own fields. */
const resolveGeo = (
  geo: StriiveFetchedPayload["job"]["regionLocation"]
): { type: string; coordinates: number[] } | null =>
  geo ? { coordinates: [...geo.coordinates], type: geo.type } : null;

const resolveBeschrijving = (job: StriiveFetchedPayload["job"]): string => {
  const html = job.content?.trim();
  if (html) {
    const stripped = stripHtml(html);
    if (stripped) {
      return stripped;
    }
  }
  return job.title;
};

export const parseStriivePayload = (
  payload: StriiveFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { job } = payload;
  const parserVersion = STRIIVE_PARSER_VERSION;
  // The `?open=true` listing filter means every observed job was open at
  // fetch time; Striive exposes no per-job "still open" signal beyond that,
  // so lifecycle only closes on the client-facing deadline having passed.
  // `closingDateClient` carries a real time component at the source (see
  // toDateOnly above -- it is only truncated for the *canonical* date-only
  // field). hasClosingMomentPassed compares at that full instant instead of
  // truncating to midnight first, which used to flip lifecycle to "closed"
  // up to ~11 hours before the real deadline (RJC-376).
  const sluitingsdatumPassed = hasClosingMomentPassed(job.closingDateClient);
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: false,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed,
  });

  // Two distinct deadlines per docs/sources/striive.md: `closingDateClient`
  // is the canonical `sluitingsdatum`, `closingDateInvoice` (the supplier/
  // broker submission deadline) only ever goes into bronSpecifiek.
  // `endDate` also has no canonical home on NormalisedAanvraagDraft (only
  // `startDatum` exists), so it is kept verbatim in bronSpecifiek too.
  const bronSpecifiek = {
    broker: job.broker ?? null,
    // CTP-524 F06: real field, confirmed live 2026-09-16
    // (fixtures/connectors/striive/listing-live.json) -- null across all 25
    // records of that committed page capture, whitelisted for when a broker
    // publishes it (same honest-future-proofing as the tariff fields).
    contract_type: job.jobType ?? null,
    eind_datum: job.endDate ?? null,
    geo: resolveGeo(job.regionLocation),
    // Striive publishes `location` as "<stad> <provincie>" (e.g. "Assen
    // Drenthe") -- the province name is explicit source text, not inferred
    // from the city (docs/sources/striive.md has no dedicated province
    // field). findProvincieInText only matches a recognised province token;
    // a city-only location yields null, never a guess.
    provincie: findProvincieInText(job.location),
    referenties: {
      referenceCode: job.referenceCode ?? null,
      referenceCodeClient: job.referenceCodeClient ?? null,
    },
    // CTP-524 F15: real `tags` field, confirmed live 2026-09-16 -- `[]`
    // across all 25 records of that capture, so entry shape is unverified.
    // normaliseSkills drops anything that is not a plain string.
    skills: normaliseSkills(job.tags),
    source: job.source ?? null,
    supplier_deadline:
      job.closingDateInvoice === null || job.closingDateInvoice === undefined
        ? null
        : job.closingDateInvoice,
    uren_max: numberToStringOrUnknown(job.hoursPerWeekMax),
    uren_min: numberToStringOrUnknown(job.hoursPerWeekMin),
    uren_per_week: formatHoursPerWeek(job.hoursPerWeekMin, job.hoursPerWeekMax),
  };

  const contactpersonen = toDraftContactpersonen(
    "striive",
    job.contactpersonen,
    parserVersion,
    "job.contactpersonen"
  );

  const draft: NormalisedAanvraagDraft = {
    beschrijving: field(resolveBeschrijving(job), parserVersion, "job.content"),
    bronReferentie: field(job.id, parserVersion, "job.id"),
    bronSpecifiek: field(bronSpecifiek, parserVersion, "job"),
    bronUrl: field(
      job.brokerUrl?.trim() || UNKNOWN,
      parserVersion,
      "job.brokerUrl"
    ),
    contentHash,
    extractieMethode: "api",
    lifecycle,
    locatieLand: field("NL", parserVersion, "job.location"),
    locatieTekst: field(
      job.location?.trim() || UNKNOWN,
      parserVersion,
      "job.location"
    ),
    opdrachtgeverNaam: field(
      job.clientName?.trim() || UNKNOWN,
      parserVersion,
      "job.clientName"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(job.closingDateClient),
    startDatum: field(
      toDateOnly(job.startDate),
      parserVersion,
      "job.startDate"
    ),
    status: lifecycle,
    tarief: resolveTarief(job),
    titel: field(job.title, parserVersion, "job.title"),
  };
  if (contactpersonen) {
    draft.contactpersonen = contactpersonen;
  }
  return draft;
};

export const decodeStriivePayload = (body: Uint8Array): StriiveFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Striive fetch.
  JSON.parse(new TextDecoder().decode(body)) as StriiveFetchedPayload;

export const normaliseStriiveObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseStriivePayload(decodeStriivePayload(body), contentHash);
