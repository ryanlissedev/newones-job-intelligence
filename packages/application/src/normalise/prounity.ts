import { decodeHtmlEntities } from "@ji/connectors";
import type { ProunityFetchedPayload } from "@ji/connectors/prounity";
import { PROUNITY_PARSER_VERSION } from "@ji/connectors/prounity";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { normaliseSkills } from "./skills";
import {
  closingMomentInstant,
  field,
  hasClosingMomentPassed,
  isValidCalendarDate,
  stripHtml,
} from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

/** tarief is genuinely ABSENT at ProUnity — confirmed live 2026-09-18 on the
 * listing and on detail pages (open and historical): the `.job__infobar`
 * carries only the work period and a country, and no rate is rendered
 * anywhere. Resolves to UNKNOWN unconditionally, never inferred from prose. */
const unknownTarief: NormalisedTarief = {
  eenheid: UNKNOWN,
  max: UNKNOWN,
  min: UNKNOWN,
  valuta: "EUR",
};

/** `.job__infobar` period text: "12/10/2026 - 31/12/2026" (dd/mm/yyyy, the
 * mission's work window — confirmed live 2026-09-18 on two open missions and
 * one 2023 page). */
const PERIODE_PATTERN =
  /(?<startD>\d{2})\/(?<startM>\d{2})\/(?<startY>\d{4})\s*-\s*(?<endD>\d{2})\/(?<endM>\d{2})\/(?<endY>\d{4})/u;

const toIsoDate = (
  year: string | undefined,
  month: string | undefined,
  day: string | undefined
): string | undefined => {
  if (!(year && month && day)) {
    return;
  }
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  return isValidCalendarDate(y, m, d) ? `${year}-${month}-${day}` : undefined;
};

interface ProunityPeriode {
  eind?: string;
  start?: string;
}

const parsePeriode = (periode: string | undefined): ProunityPeriode => {
  const groups = periode ? PERIODE_PATTERN.exec(periode)?.groups : undefined;
  if (!groups) {
    return {};
  }
  return {
    eind: toIsoDate(groups.endY, groups.endM, groups.endD),
    start: toIsoDate(groups.startY, groups.startM, groups.startD),
  };
};

const descriptionText = (html: string): string =>
  decodeHtmlEntities(stripHtml(html)).replaceAll(/\s+/gu, " ").trim();

export const parseProunityPayload = (
  payload: ProunityFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { detail, listing, raw } = payload;
  const parserVersion = PROUNITY_PARSER_VERSION;
  const beschrijving = descriptionText(raw.html) || detail.titel;
  const { eind, start } = parsePeriode(detail.periode);
  const skills = normaliseSkills(detail.skills.map((tag) => tag.naam));
  const rollen = detail.roles.map((tag) => tag.naam);

  // ProUnity publishes no application deadline. The only closure signal a
  // detail page offers is the mission's own work window: a mission whose
  // period ended (e.g. the 2023 history still served at 200) cannot still be
  // open for applications, so the period END feeds sluitingsdatum as the
  // closure lower bound — honest, and never earlier than the real close.
  // Brussels and Amsterdam share the same CET/CEST wall clock, so the shared
  // Europe/Amsterdam zone applies.
  const sluitingsInstant = closingMomentInstant(eind);
  const sluitingsdatumPassed = hasClosingMomentPassed(eind);
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: false,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed,
  });

  return {
    beschrijving: field(beschrijving, parserVersion, "raw.html"),
    bronReferentie: field(detail.uuid, parserVersion, "detail.uuid"),
    bronSpecifiek: field(
      {
        duur: detail.duur ?? null,
        eind_datum: eind ?? null,
        land: detail.land ?? null,
        periode: detail.periode ?? null,
        referentie: detail.referentie ?? null,
        rollen: rollen.length > 0 ? rollen : null,
        // `skills`/`talen`/`rollen` come only from the detail page's
        // structured `.tags` lists — never from free-text mining.
        skills: skills.length > 0 ? skills : null,
        sollicitatie_url: detail.applyUrl ?? null,
        talen:
          detail.talen.length > 0
            ? detail.talen.map((tag) => ({
                naam: tag.naam,
                status: tag.status ?? null,
              }))
            : null,
      },
      parserVersion,
      "detail"
    ),
    bronUrl: field(listing.url, parserVersion, "listing.url"),
    contentHash,
    extractieMethode: "html_parser",
    lifecycle,
    // Every sampled mission is Belgium-based (docs/sources/prounity.md); the
    // infobar publishes a country name, not a city.
    locatieLand: field("BE", parserVersion, "detail.land"),
    locatieTekst: field(
      detail.land?.trim() || UNKNOWN,
      parserVersion,
      "detail.land"
    ),
    // The end client is only ever named inside the description prose — never
    // a structured field — so it stays UNKNOWN rather than mined.
    opdrachtgeverNaam: field(
      UNKNOWN,
      parserVersion,
      "n/a (not published by source)"
    ),
    parserVersion,
    sluitingsdatum: sluitingsInstant,
    startDatum: field(start ?? UNKNOWN, parserVersion, "detail.periode"),
    status: lifecycle,
    tarief: unknownTarief,
    titel: field(detail.titel, parserVersion, "detail.titel"),
  };
};

export const decodeProunityPayload = (
  body: Uint8Array
): ProunityFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from ProUnity fetch.
  JSON.parse(new TextDecoder().decode(body)) as ProunityFetchedPayload;

export const normaliseProunityObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseProunityPayload(decodeProunityPayload(body), contentHash);
