import { decodeHtmlEntities } from "@ji/connectors";
import type { NeedstaffingFetchedPayload } from "@ji/connectors/needstaffing";
import { NEEDSTAFFING_PARSER_VERSION } from "@ji/connectors/needstaffing";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { toDraftContactpersonen } from "./contactpersonen";
import { normaliseSkills } from "./skills";
import {
  closingMomentInstant,
  field,
  hasClosingMomentPassed,
  stripHtml,
} from "./types";
import type { NormalisedAanvraagDraft } from "./types";

/** `detail.start`/`detail.deadline` are `data-date-utc` epoch-ms strings.
 * Strict on purpose (codex review, RJC-377 amendment): `Number("")` and
 * `Number(" ")` are `0` in JS -- a bare `Number(raw)` conversion would
 * silently read an empty/whitespace value as epoch 1970 (a false "already
 * closed" for the deadline use below), and an absurd value (`1e20`) or a
 * negative string could reach `new Date()` unguarded (which throws for
 * `1e20` and produces nonsense for a negative epoch). Requires a plain
 * 10-13 digit string (covers real epoch-seconds and epoch-ms ranges) and
 * clamps to a sane calendar window so nothing out of range ever reaches
 * `new Date()`. Returns `undefined` for anything missing, malformed, or out
 * of range. */
const EPOCH_MS_PATTERN = /^(?<digits>\d{10,13})$/u;
const EPOCH_MS_MIN = Date.parse("2000-01-01T00:00:00.000Z");
const EPOCH_MS_MAX = Date.parse("2100-01-01T00:00:00.000Z");

const parseEpochMs = (epochMs: string | undefined): number | undefined => {
  const trimmed = epochMs?.trim();
  const match = trimmed ? EPOCH_MS_PATTERN.exec(trimmed) : null;
  if (!match?.groups?.digits) {
    return;
  }
  const ms = Number(match.groups.digits);
  return ms < EPOCH_MS_MIN || ms > EPOCH_MS_MAX ? undefined : ms;
};

/** Converts a validated epoch-ms field (`parseEpochMs`) to a plain ISO date.
 * Falls back to UNKNOWN for anything unparsable/out of range. */
const epochToIsoDate = (
  epochMs: string | undefined
): string | typeof UNKNOWN => {
  const ms = parseEpochMs(epochMs);
  return ms === undefined ? UNKNOWN : new Date(ms).toISOString().slice(0, 10);
};

/** Same epoch-ms field as `epochToIsoDate`, but kept at full instant
 * precision (no `.slice(0, 10)`) for the `sluitingsdatumPassed` comparison --
 * `detail.deadline` carries a real time-of-day (e.g. "07-09-2026 11:00" per
 * the detail page's own "Deadline voor reageren" block), so truncating to a
 * bare date first would flip lifecycle to "closed" hours before the real
 * deadline (RJC-376). Returns `undefined` for anything unparsable, which
 * `hasClosingMomentPassed` reads as "no closing information" (`false`). */
const epochToIsoInstant = (epochMs: string | undefined): string | undefined => {
  const ms = parseEpochMs(epochMs);
  return ms === undefined ? undefined : new Date(ms).toISOString();
};

const tariefAmount = (value: string | undefined): string | typeof UNKNOWN =>
  value ? value.replace(",", ".") : UNKNOWN;

const HOURLY_TARIEF_PATTERN = /\bper\s+(?:hour|uur)\b/iu;

const tariefEenheid = (value: string | undefined): "uur" | typeof UNKNOWN =>
  value && HOURLY_TARIEF_PATTERN.test(value) ? "uur" : UNKNOWN;

const descriptionText = (html: string): string =>
  decodeHtmlEntities(stripHtml(html)).replaceAll(/\s+/gu, " ").trim();

/** `detail.uren` is a leading number (or range) sometimes followed by a unit
 * word -- confirmed live: "36" (2026-08-31, detail-15520.json) vs "36 uur"
 * (2026-09-16, detail-15599.json). Keep only the number(s),
 * never the unit text, so `uren_per_week` stays the plain numeric string the
 * CTP-514 data contract expects. */
const UREN_LEADING_NUMBER_PATTERN = /^(?<value>\d+(?:\s*-\s*\d+)?)/u;

const parseNeedstaffingUren = (raw: string | undefined): string | null => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const match = UREN_LEADING_NUMBER_PATTERN.exec(trimmed);
  return match?.groups?.value
    ? match.groups.value.replaceAll(/\s+/gu, "")
    : null;
};

export const parseNeedstaffingPayload = (
  payload: NeedstaffingFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { detail, listing, raw } = payload;
  const parserVersion = NEEDSTAFFING_PARSER_VERSION;
  const beschrijving = descriptionText(raw.html) || detail.titel;
  const uren = parseNeedstaffingUren(detail.uren);
  const skills = normaliseSkills(detail.competenties);
  // The detail page's own "Deadline voor reageren" block (`detail.deadline`)
  // is a real, per-listing closing moment -- confirmed live 2026-08-31
  // (fixtures/connectors/needstaffing/detail-15520.json). Previously this
  // was parsed into bronSpecifiek.deadline for display but never fed into
  // lifecycle, so every Need Staffing listing stayed "active" forever
  // (RJC-377).
  const sluitingsdatumPassed = hasClosingMomentPassed(
    epochToIsoInstant(detail.deadline)
  );
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: false,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed,
  });
  const contactpersonen = toDraftContactpersonen(
    "needstaffing",
    detail.contactpersonen,
    parserVersion,
    "detail.contactpersonen"
  );

  const draft: NormalisedAanvraagDraft = {
    beschrijving: field(beschrijving, parserVersion, "raw.html"),
    bronReferentie: field(detail.id, parserVersion, "detail.id"),
    bronSpecifiek: field(
      {
        deadline: epochToIsoDate(detail.deadline),
        // `periode` ("4 maanden", "Onbepaalde tijd", confirmed live
        // 2026-08-31: detail-15520.json) is the only looptijd signal this
        // connector's typed fields expose -- there is no separate end-date
        // field on the header or in the typed detail shape, so it can only
        // ever become `duur`, never `eind_datum` (CTP-514 data contract).
        duur: detail.periode ?? null,
        periode: detail.periode ?? null,
        referentie: detail.referentie ?? null,
        // `skills` is only populated from the detail page's structured
        // Competenties `<ul>` (client.ts:extractNeedstaffingCompetenties) --
        // never from free-text mining of the vacancy body.
        skills: skills.length > 0 ? skills : null,
        uren,
        uren_per_week: uren,
        werkvorm: detail.werkvorm ?? null,
      },
      parserVersion,
      "detail"
    ),
    bronUrl: field(
      `https://www.needstaffing.nl/Opdrachten/${detail.id}`,
      parserVersion,
      "detail.id"
    ),
    contentHash,
    extractieMethode: "html_parser",
    lifecycle,
    locatieLand: field("NL", parserVersion, "detail.locatie"),
    locatieTekst: field(
      detail.locatie?.trim() || UNKNOWN,
      parserVersion,
      "detail.locatie"
    ),
    opdrachtgeverNaam: field(
      listing.opdrachtgeverNaam?.trim() || UNKNOWN,
      parserVersion,
      "listing.opdrachtgeverNaam"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(epochToIsoInstant(detail.deadline)),
    startDatum: field(
      epochToIsoDate(detail.start),
      parserVersion,
      "detail.start"
    ),
    status: lifecycle,
    tarief: {
      eenheid: tariefEenheid(detail.tarief),
      max: tariefAmount(detail.tariefMax),
      min: tariefAmount(detail.tariefMin),
      valuta: "EUR",
    },
    titel: field(detail.titel, parserVersion, "detail.titel"),
  };
  if (contactpersonen) {
    draft.contactpersonen = contactpersonen;
  }
  return draft;
};

export const decodeNeedstaffingPayload = (
  body: Uint8Array
): NeedstaffingFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Needstaffing fetch.
  JSON.parse(new TextDecoder().decode(body)) as NeedstaffingFetchedPayload;

export const normaliseNeedstaffingObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseNeedstaffingPayload(decodeNeedstaffingPayload(body), contentHash);
