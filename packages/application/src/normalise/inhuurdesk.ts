import { decodeHtmlEntities } from "@ji/connectors";
import type { InhuurdeskFetchedPayload } from "@ji/connectors/inhuurdesk";
import { INHUURDESK_PARSER_VERSION } from "@ji/connectors/inhuurdesk";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { toDraftContactpersonen } from "./contactpersonen";
import { formatHoursPerWeek } from "./hours";
import { findProvincieInText } from "./provincie";
import { parseTariefFromText } from "./tarief";
import {
  closingMomentInstant,
  field,
  hasClosingMomentPassed,
  stripHtml,
} from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

type Assignment = InhuurdeskFetchedPayload["assignment"];

const INHUURDESK_BASE_URL = "https://www.inhuurdesk.nl";

/** Naive ISO datetime (`2026-09-21T00:00:00`) -> `YYYY-MM-DD`; UNKNOWN when
 * absent. The canonical date fields are date-only. */
const toDateOnly = (raw: string | null | undefined): string | typeof UNKNOWN =>
  raw?.slice(0, 10) || UNKNOWN;

const resolveBeschrijving = (assignment: Assignment): string => {
  const html = assignment.content?.trim();
  if (html) {
    const stripped = stripHtml(decodeHtmlEntities(html));
    if (stripped) {
      return stripped;
    }
  }
  return assignment.title;
};

/** Public detail URL `/aanvragen/<clientNameSlug>/<titleSlug>/<id>` --
 * pattern confirmed live 2026-09-03 against the listing page's hrefs for the
 * same records (e.g. `/aanvragen/alliander/planner-c/3c9792fd-…`). UNKNOWN
 * when either slug is missing rather than guessing a partial path. */
const resolveBronUrl = (assignment: Assignment): string | typeof UNKNOWN => {
  const clientSlug = assignment.clientNameSlug?.trim();
  const titleSlug = assignment.titleSlug?.trim();
  if (!(clientSlug && titleSlug)) {
    return UNKNOWN;
  }
  return `${INHUURDESK_BASE_URL}/aanvragen/${clientSlug}/${titleSlug}/${assignment.id}`;
};

const positiveAmount = (value: number | null | undefined): string | null =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? String(value)
    : null;

/** `hourlyRateMin/Max` are structured EUR-per-hour amounts when `> 0`; the
 * live capture (2026-09-03) had `0` on every record, meaning "not published",
 * so `0` is never mapped as a rate. Falls back to the existing text parse of
 * the description ("max tarief €110 per uur") when no structured amount is
 * present; anything still unresolved stays UNKNOWN. */
const resolveTarief = (
  assignment: Assignment,
  beschrijving: string
): NormalisedTarief => {
  const min = positiveAmount(assignment.hourlyRateMin);
  const max = positiveAmount(assignment.hourlyRateMax);
  if (min !== null || max !== null) {
    return {
      eenheid: "uur",
      max: max ?? UNKNOWN,
      min: min ?? UNKNOWN,
      valuta: "EUR",
    };
  }
  return parseTariefFromText(beschrijving);
};

export const parseInhuurdeskPayload = (
  payload: InhuurdeskFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { assignment } = payload;
  const parserVersion = INHUURDESK_PARSER_VERSION;
  const beschrijving = resolveBeschrijving(assignment);
  // `closingDateClient` (live since the 2026-09-03 capture; the earlier
  // RJC-377 "no deadline field" note described the non-live fixture) is the
  // client-facing deadline with a real time component; compare at that
  // instant, never truncated to midnight (RJC-376). Inhuurdesk publishes no
  // per-record "closed" flag, so `bronSaysClosed` stays false.
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: false,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed: hasClosingMomentPassed(assignment.closingDateClient),
  });
  const contactpersonen = toDraftContactpersonen(
    "inhuurdesk",
    assignment.contactpersonen,
    parserVersion,
    "assignment.contactpersonen"
  );

  const draft: NormalisedAanvraagDraft = {
    beschrijving: field(beschrijving, parserVersion, "assignment.content"),
    bronReferentie: field(assignment.id, parserVersion, "assignment.id"),
    bronSpecifiek: field(
      {
        aanvraagnummer: assignment.referenceCode ?? null,
        eind_datum: assignment.endDate ?? null,
        gepubliceerd_op: assignment.publishedDate ?? null,
        has_max_rate: assignment.hasMaxRate ?? null,
        // CTP-520 F04: `location` is almost always a bare city/site name
        // ("Arnhem Bellevue", "Gemeentehuis") with no province -- honest
        // `null` in that (common) case. `findProvincieInText` only ever
        // resolves an explicit province token already in the text (e.g.
        // "Amsterdam, Noord-Holland"), never derives one from a city name.
        provincie: findProvincieInText(assignment.location ?? null),
        segment: assignment.segmentName ?? null,
        supplier_deadline: assignment.closingDateInvoice ?? null,
        uren_max: assignment.hoursPerWeekMax ?? null,
        uren_min: assignment.hoursPerWeekMin ?? null,
        uren_per_week: formatHoursPerWeek(
          assignment.hoursPerWeekMin,
          assignment.hoursPerWeekMax
        ),
      },
      parserVersion,
      "assignment"
    ),
    bronUrl: field(resolveBronUrl(assignment), parserVersion, "assignment"),
    contentHash,
    extractieMethode: "api",
    lifecycle,
    locatieLand: field("NL", parserVersion, "assignment.location"),
    locatieTekst: field(
      assignment.location?.trim() || UNKNOWN,
      parserVersion,
      "assignment.location"
    ),
    opdrachtgeverNaam: field(
      assignment.clientName?.trim() || UNKNOWN,
      parserVersion,
      "assignment.clientName"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(assignment.closingDateClient),
    startDatum: field(
      toDateOnly(assignment.startDate),
      parserVersion,
      "assignment.startDate"
    ),
    status: lifecycle,
    tarief: resolveTarief(assignment, beschrijving),
    titel: field(assignment.title, parserVersion, "assignment.title"),
  };
  if (contactpersonen) {
    draft.contactpersonen = contactpersonen;
  }
  return draft;
};

export const decodeInhuurdeskPayload = (
  body: Uint8Array
): InhuurdeskFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Inhuurdesk fetch.
  JSON.parse(new TextDecoder().decode(body)) as InhuurdeskFetchedPayload;

export const normaliseInhuurdeskObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseInhuurdeskPayload(decodeInhuurdeskPayload(body), contentHash);
