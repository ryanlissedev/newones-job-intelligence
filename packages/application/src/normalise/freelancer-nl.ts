import type { FreelancerNlFetchedPayload } from "@ji/connectors/freelancer-nl";
import { FREELANCER_NL_PARSER_VERSION } from "@ji/connectors/freelancer-nl";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { normaliseSkills } from "./skills";
import { parseTariefFromText } from "./tarief";
import { field, isValidCalendarDate, stripHtml } from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

const DATE_PATTERN = /^(?<day>\d{2})-(?<month>\d{2})-(?<year>\d{4})$/u;

export const parseFreelancerNlDate = (
  raw?: string
): string | typeof UNKNOWN => {
  const match = DATE_PATTERN.exec(raw?.trim() ?? "");
  if (!match?.groups) {
    return UNKNOWN;
  }
  const day = Number(match.groups.day);
  const month = Number(match.groups.month);
  const year = Number(match.groups.year);
  return isValidCalendarDate(year, month, day)
    ? `${year}-${match.groups.month}-${match.groups.day}`
    : UNKNOWN;
};

const GEPLAATST_PATTERN = /^geplaatst\s+(?<date>.+)$/iu;

/** The `geplaatst` label carries either a real DD-MM-YYYY date or a relative
 * phrase ("Geplaatst 12 uur geleden"). Only the dated form is a publication
 * date; a relative phrase can never become one honestly. */
const publicatiedatumOf = (geplaatst?: string): string | null => {
  const match = GEPLAATST_PATTERN.exec(geplaatst?.trim() ?? "");
  if (!match?.groups) {
    return null;
  }
  const parsed = parseFreelancerNlDate(match.groups.date);
  return parsed === UNKNOWN ? null : parsed;
};

const unknownTarief: NormalisedTarief = {
  eenheid: UNKNOWN,
  max: UNKNOWN,
  min: UNKNOWN,
  valuta: "EUR",
};

/** The `.budget` block carries either a priced range with an explicit unit
 * ("€30 — €40 Per Uur") or a qualitative/fixed-price label ("In overleg",
 * "€1000 — €2000 Vaste Prijs"). Only the explicit-unit form is a tarief:
 * parseTariefFromText labels every bare-euro range "uur" by default, which
 * would mislabel a fixed project price — so a budget without a per-unit
 * marker stays UNKNOWN. `soort_budget` keeps the source's own type label
 * ("Vaste Prijs"/"Per Uur"/"In overleg") as provenance. */
const EXPLICIT_RATE_UNIT = /\bper\s+(?:uur|dag|maand)\b|\bp\/u\b/iu;

/** Typographic dashes/minus the shared range patterns do not read; the site
 * typesets "€30 — €40" with an em dash (U+2014). Normalising to "-" is
 * typography, not inference — the published range itself is unchanged. */
const TYPOGRAPHIC_DASH = /[‐-―−]/gu;

const tariefOf = (budget?: string): NormalisedTarief => {
  const text = budget?.trim() ?? "";
  if (!EXPLICIT_RATE_UNIT.test(text)) {
    return unknownTarief;
  }
  return parseTariefFromText(text.replace(TYPOGRAPHIC_DASH, "-"));
};

const detailStatusIsClosed = (status?: string): boolean => {
  const normalised = status?.trim().toLowerCase();
  return normalised === "closed" || normalised === "gesloten";
};

const descriptionText = (html: string, titel: string): string =>
  stripHtml(html).trim() || titel;

export const parseFreelancerNlPayload = (
  payload: FreelancerNlFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { detail, listing } = payload;
  const parserVersion = FREELANCER_NL_PARSER_VERSION;
  const titel = detail.titel.trim() || listing.titel;
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: detailStatusIsClosed(detail.status),
    current: "unknown",
    missedPolls: 0,
    seenOpen: !detailStatusIsClosed(detail.status),
    sluitingsdatumPassed: false,
  });
  const skills = normaliseSkills(detail.skills);

  return {
    beschrijving: field(
      descriptionText(detail.omschrijvingHtml, titel),
      parserVersion,
      "detail.omschrijvingHtml"
    ),
    bronReferentie: field(
      detail.bronReferentie,
      parserVersion,
      "detail.bronReferentie"
    ),
    bronSpecifiek: field(
      {
        categorie: detail.categorie ?? null,
        duur: detail.verwachteDuur ?? null,
        geplaatst: detail.geplaatst ?? null,
        publicatiedatum: publicatiedatumOf(detail.geplaatst),
        reacties: detail.reacties ?? listing.reacties ?? null,
        skills: skills.length > 0 ? skills : null,
        soort_budget: detail.soortBudget ?? listing.budget ?? null,
        start: detail.start ?? null,
        status: detail.status ?? null,
        url: detail.url,
        verwachte_duur: detail.verwachteDuur ?? null,
      },
      parserVersion,
      "detail"
    ),
    bronUrl: field(detail.url, parserVersion, "detail.url"),
    contentHash,
    extractieMethode: "html_parser",
    lifecycle,
    locatieLand: field("NL", parserVersion, "detail.locatie"),
    locatieTekst: field(
      detail.locatie?.trim() || listing.locatie?.trim() || UNKNOWN,
      parserVersion,
      "detail.locatie"
    ),
    opdrachtgeverNaam: field(
      UNKNOWN,
      parserVersion,
      "n/a (not published by source)"
    ),
    parserVersion,
    startDatum: field(
      parseFreelancerNlDate(detail.start),
      parserVersion,
      "detail.start"
    ),
    status: lifecycle,
    tarief: tariefOf(listing.budget),
    titel: field(titel, parserVersion, "detail.titel"),
  };
};

export const decodeFreelancerNlPayload = (
  body: Uint8Array
): FreelancerNlFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Freelancer.nl.
  JSON.parse(new TextDecoder().decode(body)) as FreelancerNlFetchedPayload;

export const normaliseFreelancerNlObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseFreelancerNlPayload(decodeFreelancerNlPayload(body), contentHash);
