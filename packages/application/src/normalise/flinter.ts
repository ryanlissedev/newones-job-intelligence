import type { FlinterFetchedPayload } from "@ji/connectors/flinter";
import {
  FLINTER_OPDRACHTEN_PATH,
  FLINTER_PARSER_VERSION,
} from "@ji/connectors/flinter";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { field, stripHtml } from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

const FLINTER_BASE_URL = "https://www.flinter.nl";

/** tarief, startdatum and sluitingsdatum are genuinely ABSENT at Flinter --
 * confirmed against a live capture of all 18 listed assignments (see
 * docs/sources/flinter.md and packages/connectors/src/flinter/types.ts).
 * This is not a parsing gap: none of these three fields is ever rendered
 * anywhere on the listing or detail pages, so they resolve to UNKNOWN
 * unconditionally rather than being inferred from prose. Re-confirmed for
 * RJC-377: `sluitingsdatumPassed` stays hard `false` below for the same
 * reason -- there is no closing date to derive it from, and `looptijdTekst`
 * (kept in bronSpecifiek) is a free-text contract-duration description, not
 * a deadline. Listing removal is the only closing signal Flinter offers
 * today. */
const unknownTarief: NormalisedTarief = {
  eenheid: UNKNOWN,
  max: UNKNOWN,
  min: UNKNOWN,
  valuta: "EUR",
};

const buildFallbackBeschrijving = (
  beschrijvingHtml: string,
  titel: string
): string => {
  const stripped = stripHtml(beschrijvingHtml);
  return stripped || titel;
};

export const parseFlinterPayload = (
  payload: FlinterFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { detail, listing } = payload;
  const parserVersion = FLINTER_PARSER_VERSION;
  const titel = detail.titel.trim() || listing.titel;
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: false,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed: false,
  });

  return {
    beschrijving: field(
      buildFallbackBeschrijving(detail.beschrijvingHtml, titel),
      parserVersion,
      "detail.beschrijvingHtml"
    ),
    bronReferentie: field(listing.slug, parserVersion, "listing.slug"),
    bronSpecifiek: field(
      {
        looptijd_tekst: listing.looptijdTekst ?? null,
        slug: listing.slug,
        uren_per_week_raw: detail.urenPerWeek ?? null,
      },
      parserVersion,
      "listing"
    ),
    bronUrl: field(
      `${FLINTER_BASE_URL}${FLINTER_OPDRACHTEN_PATH}/${listing.slug}`,
      parserVersion,
      "listing.slug"
    ),
    contentHash,
    extractieMethode: "html_parser",
    lifecycle,
    locatieLand: field("NL", parserVersion, "listing.locatiePlaats"),
    locatieTekst: field(
      listing.locatiePlaats?.trim() || UNKNOWN,
      parserVersion,
      "listing.locatiePlaats"
    ),
    opdrachtgeverNaam: field(
      listing.opdrachtgeverNaam?.trim() || UNKNOWN,
      parserVersion,
      "listing.opdrachtgeverNaam"
    ),
    parserVersion,
    startDatum: field(UNKNOWN, parserVersion, "n/a (not published by source)"),
    status: lifecycle,
    tarief: unknownTarief,
    titel: field(titel, parserVersion, "detail.titel"),
  };
};

export const decodeFlinterPayload = (body: Uint8Array): FlinterFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Flinter fetch.
  JSON.parse(new TextDecoder().decode(body)) as FlinterFetchedPayload;

export const normaliseFlinterObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseFlinterPayload(decodeFlinterPayload(body), contentHash);
