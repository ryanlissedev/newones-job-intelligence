/* oxlint-disable anti-slop/no-runtime-typeof -- I/O boundary: schema.org JobPosting fields are unowned third-party JSON-LD, narrowed here before use. */
import type { OpdrachtoverheidFetchedPayload } from "@ji/connectors/opdrachtoverheid";
import {
  isOpdrachtoverheidTenderOpen,
  OPDRACHTOVERHEID_PARSER_VERSION,
} from "@ji/connectors/opdrachtoverheid";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { formatHoursPerWeek } from "./hours";
import { toCanonicalProvincie } from "./provincie";
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

/** Opdrachtoverheid rarely sets `tender_job_location` directly (confirmed by
 * live probe, 2026-08-31: null across every sampled record). Fall back to
 * the location detail blocks the API attaches for the buying organisation. */
const resolveLocatie = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): string | typeof UNKNOWN =>
  tender.tender_job_location?.trim() ||
  tender.vacancies_location?.company_address?.trim() ||
  tender.vacancies_location?.province?.trim() ||
  tender.organization_location?.company_address?.trim() ||
  tender.organization_location?.province?.trim() ||
  UNKNOWN;

interface UrenRange {
  min: string | typeof UNKNOWN;
  max: string | typeof UNKNOWN;
}

/** A zero bound is the API's empty marker, not a published zero-hour week:
 * the committed fixture `fixtures/connectors/opdrachtoverheid/listing-live-2026-09-16.json`
 * (400 records, `POST /search`) has `tender_min_hours` and `tender_max_hours`
 * set to `0` on 45 and 40 records whose `tender_hours_week` states the real
 * number ("32", "20", ...). Treating `0` as present made `uren_per_week` "0"
 * and hid the published value (CTP-526). */
const positiveHours = (value: number | null | undefined): number | null =>
  isPresent(value) && value > 0 ? value : null;

/** Prefer the numeric min/max hour fields. Keep the explicit weekly text as a
 * raw fallback when the numeric bounds are absent rather than inventing two
 * equal bounds from it. */
const resolveUren = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): UrenRange => {
  const min = positiveHours(tender.tender_min_hours);
  const max = positiveHours(tender.tender_max_hours);
  if (isPresent(min) || isPresent(max)) {
    return {
      max: numberToStringOrUnknown(max),
      min: numberToStringOrUnknown(min),
    };
  }
  return { max: UNKNOWN, min: UNKNOWN };
};

const NO_MAX_TARIEF_PATTERN = /geen\s*maximum/iu;
const TARIEF_AMOUNT_PATTERN = /(?<amount>\d+(?:[.,]\d+)?)/u;

/** `tender_tariff` (free text) is the superset field: confirmed live
 * 2026-08-31 that all 400 sampled records carry it, while the numeric
 * `tender_maximum_tariff` was populated on only 92 (23%) of them — the
 * fixture's 5 records are all in the other 77%, with only `tender_tariff`
 * set (e.g. `"70"`, `"€100"`, `"maximaal 95"`, `"106,50"`, or the
 * no-cap sentinel `"Geen maximum"`). Extracts the first numeric token and
 * normalises a comma decimal separator; returns UNKNOWN for the no-cap
 * sentinel or anything without a parseable number. */
const parseTenderTariefString = (
  raw: string | null | undefined
): string | typeof UNKNOWN => {
  const trimmed = raw?.trim();
  if (!trimmed || NO_MAX_TARIEF_PATTERN.test(trimmed)) {
    return UNKNOWN;
  }
  const match = trimmed.match(TARIEF_AMOUNT_PATTERN);
  return match?.groups?.amount
    ? match.groups.amount.replace(",", ".")
    : UNKNOWN;
};

/** Prefer the numeric `tender_maximum_tariff` field; fall back to parsing
 * the free-text `tender_tariff` superset field when the numeric field is
 * absent (the common case — see parseTenderTariefString). Confirmed
 * EUR/HOUR by the JobPosting JSON-LD fallback in the live probe. */
const resolveTarief = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): NormalisedTarief => {
  if (isPresent(tender.tender_maximum_tariff)) {
    return {
      eenheid: "uur",
      max: String(tender.tender_maximum_tariff),
      min: UNKNOWN,
      valuta: "EUR",
    };
  }
  const parsedTariff = parseTenderTariefString(tender.tender_tariff);
  if (parsedTariff !== UNKNOWN) {
    return { eenheid: "uur", max: parsedTariff, min: UNKNOWN, valuta: "EUR" };
  }
  return { eenheid: UNKNOWN, max: UNKNOWN, min: UNKNOWN, valuta: "EUR" };
};

const resolveBeschrijving = (
  tender: OpdrachtoverheidFetchedPayload["tender"],
  jobPosting: OpdrachtoverheidFetchedPayload["jobPosting"]
): string => {
  const jobPostingDescription = jobPosting?.description;
  if (
    typeof jobPostingDescription === "string" &&
    jobPostingDescription.trim()
  ) {
    return stripHtml(jobPostingDescription);
  }
  const html = tender.tender_description_tk ?? tender.tender_description_html;
  if (html) {
    return stripHtml(html);
  }
  return tender.tender_description?.trim() || tender.tender_name;
};

/** Only `tender_start_date` represents contract start. `tender_first_seen`
 * is aggregator observation metadata and must not influence canonical
 * contract-start identity. */
const resolveStartDatum = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): string | typeof UNKNOWN => {
  const startDatum = tender.tender_start_date?.trim();
  return startDatum ? startDatum.slice(0, 10) : UNKNOWN;
};

/** The JobPosting JSON-LD node and its value type, taken from the payload the
 * connector hands over so the two can never drift. */
type JobPostingNode = NonNullable<OpdrachtoverheidFetchedPayload["jobPosting"]>;
type JobPostingValue = JobPostingNode[string];

const jsonLdText = (value: JobPostingValue | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() || null;
};

/** The province the source itself publishes for the vacancy, never one derived
 * from a city name (CTP-514 contract). Only `vacancies_location.province` is
 * read: it is the block the API attaches to the tender itself and it carries
 * the value on every record of the committed fixture
 * `fixtures/connectors/opdrachtoverheid/listing-live-2026-09-16.json`
 * ("Noord-Holland", 400/400). The two candidate fallbacks are deliberately
 * NOT read, because the capture shows both state the buying organisation's
 * own postal address rather than where the assignment runs:
 * `organization_location` is the organisation block (empty on the capture),
 * and the JobPosting `jobLocation.address`
 * repeats `vacancies_location.company_address` verbatim -- sample "zero" has
 * streetAddress "Laan Nieuwer-Amstel 1" with hiringOrganization "Gemeente
 * Amstelveen", i.e. the buyer's address. An assignment performed outside the
 * buyer's home province would get the buyer's province from either, so they
 * are dropped rather than used as coverage (CTP-526 review). */
const resolveProvincie = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): string | null => toCanonicalProvincie(tender.vacancies_location?.province);

/** `education_level_obj.education_level_label` is the source's own level label
 * ("MBO", "HBO", "WO"). "Onbekend" is its explicit not-published marker
 * (358/400 on the live capture) and must stay absent, not be persisted. */
const UNKNOWN_EDUCATION_LABEL = "onbekend";

const resolveOpleidingsniveau = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): string | null => {
  const label = jsonLdText(
    tender.education_level_obj?.education_level_label ?? undefined
  );
  return label !== null && label.toLowerCase() !== UNKNOWN_EDUCATION_LABEL
    ? label
    : null;
};

/** `tender_hybrid_working === true` is the source stating hybrid work; the
 * detail page renders it as "Hybride werken: Ja". `false` ("Hybride werken:
 * Nee") only denies hybrid work -- it does not publish where the work happens,
 * so it stays absent rather than being turned into "Op locatie" (CTP-526
 * report). `remote_work_description` is prose and is almost always the
 * placeholder "Geen verdere informatie" (41/42 on the live capture), so it is
 * never used as a werkvorm label. */
const hybridWorking = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): boolean | null => {
  const value = tender.tender_hybrid_working;
  return typeof value === "boolean" ? value : null;
};

const resolveWerkvorm = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): string | null => (hybridWorking(tender) === true ? "Hybride" : null);

/** `tender_competences` is an HTML block holding a "Wensen" list of weighted
 * requirement sentences and a "Competenties" (sometimes "Vaardigheden") list
 * of tag-like competences ("Nauwkeurig", "Analytisch vermogen"). Only the
 * latter list is read: it is structured source data, while the Wensen prose is
 * free text (GAP_ENRICH, CTP-482). */
const COMPETENTIES_LIST_PATTERN =
  /<h3[^>]*>\s*(?:competenties|vaardigheden)\s*:?\s*<\/h3>\s*<ul[^>]*>(?<items>[\s\S]*?)<\/ul>/iu;
const LIST_ITEM_PATTERN = /<li[^>]*>(?<item>[\s\S]*?)<\/li>/giu;

/** `stripHtml` removes tags but never decodes entities, and the source writes
 * them ("Plannen &amp; organiseren"). Decoding the five XML entities plus
 * `&nbsp;` covers everything observed in the live capture; anything else is
 * left verbatim rather than guessed. `&amp;` is decoded last so an escaped
 * entity ("&amp;lt;") does not decay into a tag. */
const HTML_ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&nbsp;/gu, " "],
  [/&quot;/gu, '"'],
  [/&#39;/gu, "'"],
  [/&lt;/gu, "<"],
  [/&gt;/gu, ">"],
  [/&amp;/gu, "&"],
];

const decodeEntities = (text: string): string => {
  let decoded = text;
  for (const [pattern, replacement] of HTML_ENTITIES) {
    decoded = decoded.replaceAll(pattern, replacement);
  }
  return decoded.trim();
};

const resolveSkills = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
): string[] | null => {
  const html = tender.tender_competences;
  const items = html
    ? COMPETENTIES_LIST_PATTERN.exec(html)?.groups?.items
    : undefined;
  if (!items) {
    return null;
  }
  const skills = normaliseSkills(
    [...items.matchAll(LIST_ITEM_PATTERN)].map((match) =>
      decodeEntities(stripHtml(match.groups?.item ?? ""))
    )
  );
  return skills.length > 0 ? skills : null;
};

/** Commercial facts the canonical columns have no home for yet. The
 * aggregator-attribution fields `tender_source`/`tender_url` identify the
 * original broker this tender was mirrored from, kept for cross-source dedup
 * per the RJC-360 probe decision. */
const resolveBronSpecifiek = (
  tender: OpdrachtoverheidFetchedPayload["tender"]
) => {
  const uren = resolveUren(tender);
  const numericUren = formatHoursPerWeek(
    uren.min === UNKNOWN ? null : uren.min,
    uren.max === UNKNOWN ? null : uren.max
  );
  return {
    contract_type: tender.contract_type ?? null,
    exclusive: tender.exclusive ?? null,
    opdracht_overheid_url: tender.opdracht_overheid_url ?? null,
    opleidingsniveau: resolveOpleidingsniveau(tender),
    provincie: resolveProvincie(tender),
    skills: resolveSkills(tender),
    tender_first_seen: tender.tender_first_seen ?? null,
    tender_hours_week: tender.tender_hours_week ?? null,
    tender_hybrid_working: hybridWorking(tender),
    tender_source: tender.tender_source ?? null,
    tender_url: tender.tender_url ?? null,
    uren_max: uren.max === UNKNOWN ? null : uren.max,
    uren_min: uren.min === UNKNOWN ? null : uren.min,
    uren_per_week: numericUren ?? tender.tender_hours_week?.trim() ?? null,
    web_key: tender.web_key,
    werkvorm: resolveWerkvorm(tender),
  };
};

/** The commercial-fact keys this source writes into `bron_specifiek`, as the
 * curate/read path reads them (CTP-514 data contract). */
export type OpdrachtoverheidBronSpecifiek = ReturnType<
  typeof resolveBronSpecifiek
>;

export const parseOpdrachtoverheidPayload = (
  payload: OpdrachtoverheidFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { tender, jobPosting } = payload;
  const parserVersion = OPDRACHTOVERHEID_PARSER_VERSION;
  // `tender_offline_date` carries a real time component at the source
  // (e.g. "2026-09-01 16:00:00", naive Europe/Amsterdam wall clock, no
  // offset); hasClosingMomentPassed compares at that full instant instead
  // of truncating to midnight first, which used to flip lifecycle to
  // "closed" up to ~11 hours before the real deadline (RJC-376).
  const sluitingsdatumPassed = hasClosingMomentPassed(
    tender.tender_offline_date
  );
  const seenOpen = isOpdrachtoverheidTenderOpen(tender);
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: !seenOpen,
    current: "unknown",
    missedPolls: 0,
    seenOpen,
    sluitingsdatumPassed,
  });
  const locatie = resolveLocatie(tender);

  return {
    beschrijving: field(
      resolveBeschrijving(tender, jobPosting),
      parserVersion,
      "tender.tender_description"
    ),
    bronReferentie: field(tender.tender_id, parserVersion, "tender.tender_id"),
    bronSpecifiek: field(resolveBronSpecifiek(tender), parserVersion, "tender"),
    bronUrl: field(
      tender.opdracht_overheid_url?.trim() || UNKNOWN,
      parserVersion,
      "tender.opdracht_overheid_url"
    ),
    contentHash,
    extractieMethode: jobPosting ? "jsonld" : "api",
    lifecycle,
    locatieLand: field("NL", parserVersion, "tender.tender_job_location"),
    locatieTekst: field(locatie, parserVersion, "tender.tender_job_location"),
    opdrachtgeverNaam: field(
      tender.tender_buying_organization?.trim() || UNKNOWN,
      parserVersion,
      "tender.tender_buying_organization"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(tender.tender_offline_date),
    startDatum: field(
      resolveStartDatum(tender),
      parserVersion,
      "tender.tender_start_date"
    ),
    status: lifecycle,
    tarief: resolveTarief(tender),
    titel: field(tender.tender_name, parserVersion, "tender.tender_name"),
  };
};

export const decodeOpdrachtoverheidPayload = (
  body: Uint8Array
): OpdrachtoverheidFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Opdrachtoverheid fetch.
  JSON.parse(new TextDecoder().decode(body)) as OpdrachtoverheidFetchedPayload;

export const normaliseOpdrachtoverheidObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseOpdrachtoverheidPayload(
    decodeOpdrachtoverheidPayload(body),
    contentHash
  );
