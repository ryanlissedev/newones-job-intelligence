import type { CtmEntry, CtmFetchedPayload } from "@ji/connectors/ctm";
import { CTM_PARSER_VERSION } from "@ji/connectors/ctm";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { toDraftContactpersonen } from "./contactpersonen";
import { closingMomentInstant, field, hasClosingMomentPassed } from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

/**
 * CTM (EU-Supply / Mercell) publishes a public tender-announcement Atom
 * feed, not a job/inhuur listing: per docs/sources/ctm.md, the feed entry
 * is the complete observation (detail/documents sit behind a free account
 * and are out of scope, so there is no second fetch to recover more).
 * These canonical fields are genuinely absent at the source, not a parsing
 * gap, and stay UNKNOWN rather than being inferred from a neighbouring
 * field:
 *   - `tarief` (no rate/budget of any kind is published in the feed)
 *   - `startDatum` (a tender announcement carries no contract start date)
 *   - `locatieTekst` (no delivery/performance location field exists)
 */
const UNKNOWN_TARIEF: NormalisedTarief = {
  eenheid: UNKNOWN,
  max: UNKNOWN,
  min: UNKNOWN,
  valuta: "EUR",
};

/** `CtmCpvCode` is a declared interface, and interfaces get no implicit
 * index signature -- assigning it directly where `JsonValue` (an indexed
 * object type) is expected fails to type-check even though the shape is
 * plain data. Building fresh literals here sidesteps that (same pattern as
 * Striive's `resolveGeo`). */
const toJsonCpv = (
  cpv: CtmEntry["cpv"]
): { code: string; name: string | null }[] | null =>
  cpv
    ? cpv.map((code) => ({ code: code.code, name: code.name ?? null }))
    : null;

const buildBeschrijving = (entry: CtmEntry): string => {
  const parts = [
    entry.procedure ? `Procedure: ${entry.procedure}` : undefined,
    entry.organisatie ? `Organisatie: ${entry.organisatie}` : undefined,
    entry.cpv && entry.cpv.length > 0
      ? `CPV: ${entry.cpv.map((code) => code.name ?? code.code).join(", ")}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(". ") : entry.titel;
};

export const parseCtmPayload = (
  payload: CtmFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { entry } = payload;
  const parserVersion = CTM_PARSER_VERSION;

  // The feed carries no explicit open/closed signal beyond the closing
  // date (`sluitingstijd`/etq): every observed entry was still listed at
  // fetch time, so lifecycle only closes once that deadline has passed —
  // same pattern as Striive's closingDateClient. `sluitingstijd` (the
  // Atom feed's `etq`) carries a real time component (e.g.
  // "2026-10-13T11:00:00", naive Europe/Amsterdam wall clock, no offset);
  // hasClosingMomentPassed compares at that full instant instead of
  // truncating to midnight first, which used to flip lifecycle to
  // "closed" up to ~11 hours before the real deadline (RJC-376).
  const sluitingsdatumPassed = hasClosingMomentPassed(entry.sluitingstijd);
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: false,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed,
  });

  // DEC-008 minimisation: the connector's own parser (client.ts toCtmEntry)
  // already whitelists on the way in — authority address fields and the
  // free-text description blocks are never parsed into CtmEntry in the first
  // place. CTP-610 explicitly added the <contactPerson> element to that
  // whitelist (the feed publishes it for aanbieders submitting questions);
  // the bron's contactpersoon_beleid decides whether it may be stored.
  const contactpersonen = toDraftContactpersonen(
    "ctm",
    entry.contactpersonen,
    parserVersion,
    "publication.contactPerson"
  );
  const bronSpecifiek = {
    aanvraagnummer: entry.aanvraagnummer,
    cpv: toJsonCpv(entry.cpv),
    procedure: entry.procedure ?? null,
    publicatiedatum: entry.publicatiedatum ?? null,
    referentie: entry.referentie ?? null,
    sluitingstijd_raw: entry.sluitingstijd ?? null,
  };

  const draft: NormalisedAanvraagDraft = {
    beschrijving: field(buildBeschrijving(entry), parserVersion, "entry"),
    bronReferentie: field(
      entry.aanvraagnummer,
      parserVersion,
      "entry.aanvraagnummer"
    ),
    bronSpecifiek: field(bronSpecifiek, parserVersion, "entry"),
    bronUrl: field(entry.link, parserVersion, "entry.link"),
    contentHash,
    // "api" is the closest fit in `EXTRACTIE_METHODEN`: the Atom feed is
    // parsed programmatically (fast-xml-parser), not scraped HTML.
    extractieMethode: "api",
    lifecycle,
    locatieLand: field("NL", parserVersion, "entry"),
    locatieTekst: field(
      UNKNOWN,
      parserVersion,
      "n/a (not published by source)"
    ),
    opdrachtgeverNaam: field(
      entry.organisatie?.trim() || UNKNOWN,
      parserVersion,
      "publication.authority.@name"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(entry.sluitingstijd),
    startDatum: field(UNKNOWN, parserVersion, "n/a (not published by source)"),
    status: lifecycle,
    tarief: UNKNOWN_TARIEF,
    titel: field(entry.titel, parserVersion, "entry.title"),
  };
  if (contactpersonen) {
    draft.contactpersonen = contactpersonen;
  }
  return draft;
};

export const decodeCtmPayload = (body: Uint8Array): CtmFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from CTM fetch.
  JSON.parse(new TextDecoder().decode(body)) as CtmFetchedPayload;

export const normaliseCtmObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseCtmPayload(decodeCtmPayload(body), contentHash);
