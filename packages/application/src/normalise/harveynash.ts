import { decodeHtmlEntities } from "@ji/connectors";
import type { HarveyNashFetchedPayload } from "@ji/connectors/harveynash";
import { HARVEYNASH_PARSER_VERSION } from "@ji/connectors/harveynash";
import { UNKNOWN } from "@ji/domain";
import type { TariefEenheid } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { findProvincieInText } from "./provincie";
import {
  closingMomentInstant,
  field,
  hasClosingMomentPassed,
  isValidCalendarDate,
  stripHtml,
} from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

const LEADING_ISO_DATE_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u;

/** Guards `detail.jsonLd.validThrough` against an impossible calendar date
 * (codex review, RJC-377 amendment) before it ever reaches
 * `hasClosingMomentPassed`: `new Date` never throws on an out-of-range day/
 * month (e.g. "2026-02-30"), it silently rolls over into a neighbouring real
 * date, which would read as "closes on the wrong day" rather than "no valid
 * closing information". `validThrough` is machine-generated JSON-LD (unlike
 * BlueTrail's hand-typed label-block text), so this is a defensive
 * round-trip check, not an expected failure mode. */
const validThroughForClosing = (
  raw: string | undefined
): string | undefined => {
  if (!raw) {
    return;
  }
  const match = LEADING_ISO_DATE_PATTERN.exec(raw);
  if (!match?.groups) {
    return raw;
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  return isValidCalendarDate(year, month, day) ? raw : undefined;
};

const DUTCH_MONTHS = {
  april: 4,
  augustus: 8,
  december: 12,
  februari: 2,
  januari: 1,
  juli: 7,
  juni: 6,
  maart: 3,
  mei: 5,
  november: 11,
  oktober: 10,
  september: 9,
} satisfies Record<string, number>;

const pad2 = (value: number): string => String(value).padStart(2, "0");

const isValidDate = (day: number, month: number): boolean =>
  Number.isInteger(day) &&
  Number.isInteger(month) &&
  day >= 1 &&
  day <= 31 &&
  month >= 1 &&
  month <= 12;

/** Rolls a yearless day/month into a year relative to `observedAt`: if the
 * date would fall before the observation date, it is assumed to be next
 * year (recruiters publish near-term deadlines, never ones already in the
 * past relative to when the listing was posted). */
const inferYear = (day: number, month: number, observedAt: Date): number => {
  let year = observedAt.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const observedDay = Date.UTC(
    observedAt.getUTCFullYear(),
    observedAt.getUTCMonth(),
    observedAt.getUTCDate()
  );
  if (candidate < observedDay) {
    year += 1;
  }
  return year;
};

/** Resolves the year for a parsed day/month: an explicit year wins,
 * otherwise it is inferred from `observedAt` via the roll-forward rule
 * (undefined when there is no observation date to anchor a yearless
 * date). */
const resolveYear = (
  explicitYear: string | undefined,
  day: number,
  month: number,
  observedAt: Date | undefined
): number | undefined => {
  if (explicitYear) {
    return Number(explicitYear);
  }
  if (!observedAt) {
    return undefined;
  }
  return inferYear(day, month, observedAt);
};

/** Matches the clock time Harvey Nash publishes alongside the deadline date
 * itself -- "09:00"/"12:00" (colon) or "16.00" (dot, "wo 2-9 om 16.00") via
 * the first branch, "16 uur" (bare hour, "dinsdag 1 september 16 uur") via
 * the second. Colon/dot is tried first so "09:00 uur" reads as 09:00, not
 * as the bare-hour branch matching "00 uur". */
const resolveHarveyNashDeadlineTime = (
  raw: string
): { hour: number; minute: number } | undefined => {
  const withMinute = raw.match(/(?<hour>\d{1,2})[.:](?<minute>\d{2})\b/u);
  if (withMinute?.groups) {
    const hour = Number(withMinute.groups.hour);
    const minute = Number(withMinute.groups.minute);
    if (hour <= 23 && minute <= 59) {
      return { hour, minute };
    }
  }
  const bareHour = raw.match(/(?<hour>\d{1,2})\s*uur\b/u);
  if (bareHour?.groups) {
    const hour = Number(bareHour.groups.hour);
    if (hour <= 23) {
      return { hour, minute: 0 };
    }
  }
  return undefined;
};

/**
 * Deadline-year rule: real Harvey Nash "Deadline voor het voorstellen"
 * paragraphs are highly irregular free text -- live captures 2026-08-31
 * include "02-09-2026, 12:00" (numeric, with year), "04-09 om 09:00" and
 * "31-8 voor 09:00 uur" (numeric, no year), "wo 2-9 om 16.00" (weekday
 * prefix + numeric, no year), and "dinsdag 1 september 16 uur" / "1
 * september voor 09:00 uur" (Dutch month name, no year). We try, in order:
 * an explicit ISO date, a numeric D-M(-Y) date (the majority case), then a
 * D <Dutch month>(-Y) date. Whichever branch lacks a year gets one from the
 * observation date -- the search listing's `publishedAt` (Unix seconds),
 * not wall-clock time, so the connector's fetch() output stays a pure
 * function of the discovered item and replaying an identical fixture twice
 * is idempotent (see docs/sources/README.md). Text this loose that still
 * fails to parse (e.g. "Z.S.M") returns UNKNOWN rather than guessing.
 *
 * When the same text also names a clock time (codex review, CTP-519
 * amendment), that time is appended to the resolved date as
 * `YYYY-MM-DDTHH:MM:SS` -- the naive-wall-clock format `closingMomentInstant`
 * already reads as Europe/Amsterdam local time -- so a "04-09 om 09:00"
 * cutoff stops the aanvraag at 09:00 that day instead of the date-only
 * fallback's end-of-day, which would leave it wrongly active for hours past
 * the real submission deadline.
 */
export const resolveHarveyNashDeadline = (
  raw?: string,
  observedAt?: Date
): string | typeof UNKNOWN => {
  if (!raw) {
    return UNKNOWN;
  }

  const time = resolveHarveyNashDeadlineTime(raw);
  const withTime = (dateOnly: string): string =>
    time ? `${dateOnly}T${pad2(time.hour)}:${pad2(time.minute)}:00` : dateOnly;

  const isoMatch = raw.match(/(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u);
  if (isoMatch?.groups) {
    return withTime(
      `${isoMatch.groups.year}-${isoMatch.groups.month}-${isoMatch.groups.day}`
    );
  }

  const numericMatch = raw.match(
    /(?<day>\d{1,2})-(?<month>\d{1,2})(?:-(?<year>\d{4}))?/u
  );
  if (numericMatch?.groups) {
    const day = Number(numericMatch.groups.day);
    const month = Number(numericMatch.groups.month);
    if (isValidDate(day, month)) {
      const year = resolveYear(
        numericMatch.groups.year,
        day,
        month,
        observedAt
      );
      return year === undefined
        ? UNKNOWN
        : withTime(`${year}-${pad2(month)}-${pad2(day)}`);
    }
  }

  // matchAll, not match: the first "\d+ word" hit in free text is not
  // necessarily a date (e.g. "nog 3 dagen, uiterlijk 4 september" matches
  // "3 dagen" first -- "dagen" isn't a month name, so we must keep scanning
  // for the first match whose word actually is one of DUTCH_MONTHS).
  const namedMatch = [
    ...raw
      .toLowerCase()
      .matchAll(
        /(?<day>\d{1,2})\s+(?<monthname>[a-z]+)(?:\s+(?<year>\d{4}))?/gu
      ),
  ].find(
    (candidate) =>
      candidate.groups?.monthname &&
      Object.hasOwn(DUTCH_MONTHS, candidate.groups.monthname)
  );
  const monthName = namedMatch?.groups?.monthname;
  if (monthName) {
    const day = Number(namedMatch?.groups?.day);
    // SAFETY: Object.hasOwn just confirmed monthName is one of DUTCH_MONTHS's
    // own keys, so the cast only narrows a value already checked to exist.
    const month = DUTCH_MONTHS[monthName as keyof typeof DUTCH_MONTHS];
    if (isValidDate(day, month)) {
      const year = resolveYear(
        namedMatch?.groups?.year,
        day,
        month,
        observedAt
      );
      if (year !== undefined) {
        return withTime(`${year}-${pad2(month)}-${pad2(day)}`);
      }
    }
  }

  return UNKNOWN;
};

const RICHTTARIEF_AMOUNT = /(?<amount>\d+(?:[.,]\d+)?)/u;

/** The real "Salaris"/richttarief field ("Max tarief 106.50 euro all-in
 * exclusief btw", or free text like "Bespreekbaar"/"Tarief in overleg" with
 * no number at all) carries no currency symbol -- extract the first numeric
 * amount as the max, EUR by default. */
export const parseHarveyNashRichttarief = (raw?: string): NormalisedTarief => {
  const unknown: NormalisedTarief = {
    eenheid: UNKNOWN,
    max: UNKNOWN,
    min: UNKNOWN,
    valuta: "EUR",
  };
  if (!raw) {
    return unknown;
  }
  const match = raw.match(RICHTTARIEF_AMOUNT);
  if (!match?.groups?.amount) {
    return unknown;
  }
  const lower = raw.toLowerCase();
  let eenheid: TariefEenheid | typeof UNKNOWN = UNKNOWN;
  if (lower.includes("uur")) {
    eenheid = "uur";
  } else if (lower.includes("dag")) {
    eenheid = "dag";
  } else if (lower.includes("maand")) {
    eenheid = "maand";
  } else if (
    // Real capture (fixtures/connectors/harveynash/detail-endpoints-
    // specialist.json): "Max tarief 106.50 euro all-in exclusief btw" names
    // no explicit "uur"/"dag"/"maand" unit word at all -- "all-in ex(clusief)
    // btw" is itself the Dutch-inhuur convention for an hourly rate (same
    // token set `./tarief.ts`'s `detectEenheid` treats as "uur").
    lower.includes("all-in") ||
    lower.includes("all in") ||
    lower.includes("ex btw") ||
    lower.includes("excl. btw") ||
    lower.includes("exclusief btw")
  ) {
    eenheid = "uur";
  }
  return {
    eenheid,
    max: match.groups.amount.replace(",", "."),
    min: UNKNOWN,
    valuta: "EUR",
  };
};

const buildFallbackBeschrijving = (
  facts: HarveyNashFetchedPayload["detail"]["facts"],
  titel: string
): string => {
  const parts = [
    facts.uren ? `Uren: ${facts.uren}` : undefined,
    facts.locatie ? `Locatie: ${facts.locatie}` : undefined,
    facts.richttarief ? `Richttarief: ${facts.richttarief}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(". ") : titel;
};

const DESCRIPTION_LABEL_PARAGRAPH = /<p[^>]*>(?<body>[\s\S]*?)<\/p>/giu;

/**
 * Extracts a single labelled fact ("Label: value") from the JobPosting
 * JSON-LD `description` HTML by keyword, mirroring the same "labelled
 * paragraph" convention `packages/connectors/src/harveynash/client.ts`
 * already applies for `deadline`/`start`/`uren` -- but for `duur` ("Duur van
 * de opdracht:") and `werkvorm` ("Op locatie of vanuit huis:"), which that
 * connector's whitelist does not extract into `HarveyNashDetailFacts`
 * (types.ts). Reading the raw `description` string directly here (rather
 * than widening the connector's fact whitelist, out of this lane's file
 * scope) keeps the fix inside `normalise/harveynash.ts`. Best-effort: a
 * posting that never mentions the label leaves the fact undefined, never
 * guessed.
 */
const extractLabelledFact = (
  description: string | undefined,
  labelMatches: (label: string) => boolean
): string | undefined => {
  if (!description) {
    return;
  }
  for (const match of description.matchAll(DESCRIPTION_LABEL_PARAGRAPH)) {
    const text = decodeHtmlEntities(stripHtml(match.groups?.body ?? ""));
    const separatorIndex = text.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const label = text.slice(0, separatorIndex).trim().toLowerCase();
    if (labelMatches(label)) {
      const value = text.slice(separatorIndex + 1).trim();
      if (value) {
        return value;
      }
    }
  }
};

/** "Duur van de opdracht:  24 maanden" -- a duration only, never an end
 * date, on every real capture seen (fixtures/connectors/harveynash/
 * detail-endpoints-specialist.json). Maps to `bronSpecifiek.duur`; there is
 * no separate explicit end-date paragraph, so `eind_datum` stays `null`
 * (honest-absent) whenever only a duration is published.
 *
 * FIX (advisor review, CTP-519): a bare `label.includes("duur")` also
 * matched an unrelated narrative label like "Gedurende de opdracht werk je
 * met:", fabricating a `duur` value from prose that names no actual
 * duration. Anchor to the exact template label instead -- `label` is
 * already trimmed/lowercased by `extractLabelledFact`. */
const extractHarveyNashDuur = (description: string | undefined) =>
  extractLabelledFact(description, (label) => label.startsWith("duur van"));

/** "Op locatie of vanuit huis:  Hybride" -- the real werkvorm label (also
 * seen as "Werkvorm:" on other postings per the same description template).
 * Maps to `bronSpecifiek.werkvorm` as free text, verbatim as published.
 *
 * FIX (advisor review, CTP-519): a bare `label.includes("op locatie")` also
 * matched an unrelated narrative label like "De werkzaamheden op locatie
 * omvatten:", fabricating a `werkvorm` value from prose that never actually
 * states hybride/remote/op locatie. Anchor to the exact template labels
 * instead. */
const extractHarveyNashWerkvorm = (description: string | undefined) =>
  extractLabelledFact(
    description,
    (label) => label === "op locatie of vanuit huis" || label === "werkvorm"
  );

interface ResolvedBeschrijving {
  readonly sourcePath: "detail.facts" | "detail.jsonLd.description";
  readonly value: string;
}

const resolveBeschrijving = (
  detail: HarveyNashFetchedPayload["detail"],
  titel: string
): ResolvedBeschrijving => {
  const sourceDescription = detail.jsonLd.description?.trim();
  if (sourceDescription) {
    const fullDescription = decodeHtmlEntities(stripHtml(sourceDescription))
      .replaceAll(/\s+/gu, " ")
      .trim();
    if (fullDescription) {
      return {
        sourcePath: "detail.jsonLd.description",
        value: fullDescription,
      };
    }
  }
  return {
    sourcePath: "detail.facts",
    value: buildFallbackBeschrijving(detail.facts, titel),
  };
};

/**
 * Resolves the raw closing-moment string that drives both `sluitingsdatum`
 * and lifecycle (CTP-519, F13 fix). Two distinct dates are published per
 * listing (confirmed live 2026-08-31, fixtures/connectors/harveynash/
 * detail-endpoints-specialist.json): `deadline` ("Deadline voor het
 * voorstellen van kandidaten", already resolved to `YYYY-MM-DD` or UNKNOWN)
 * and `validThroughRaw` (the JobPosting's own listing-validity date; matches
 * the search endpoint's `expires_at` unix time exactly). These can diverge
 * (this fixture: deadline "04-09", validThrough "2026-09-07").
 *
 * For this product the recruiter's own submission deadline is the
 * client-facing signal -- it is exactly when the aanvraag stops being
 * actionable for a Catapulze user, making `deadline` the closer analogue of
 * Striive's `closingDateClient` (RJC-376), not `validThrough` (always some
 * days later). `deadline` is derived from loose free text via
 * year-inference and can itself be UNKNOWN, so `validThroughRaw` remains the
 * fallback whenever the free-text deadline could not be resolved -- never
 * silently reading "no resolvable deadline" as "already closed".
 */
const resolveHarveyNashClosingRaw = (
  deadline: string | typeof UNKNOWN,
  validThroughRaw: string | undefined
): string | undefined => (deadline === UNKNOWN ? validThroughRaw : deadline);

interface HarveyNashBronSpecifiekInput {
  detail: HarveyNashFetchedPayload["detail"];
  deadline: string | typeof UNKNOWN;
  duur: string | undefined;
  provincie: ReturnType<typeof findProvincieInText>;
  werkvorm: string | undefined;
}

/** Builds the `bronSpecifiek` payload, isolated from `parseHarveyNashPayload`
 * purely to keep that function's cyclomatic complexity under the project's
 * eslint ceiling -- every `?? null` below is a distinct honest-absent
 * mapping, not incidental branching. */
const buildHarveyNashBronSpecifiek = ({
  detail,
  deadline,
  duur,
  provincie,
  werkvorm,
}: HarveyNashBronSpecifiekInput) => ({
  deadline_raw: detail.facts.deadline ?? null,
  deadline_resolved: deadline === UNKNOWN ? null : deadline,
  duur: duur ?? null,
  eind_datum: null,
  job_ref: detail.facts.jobRef ?? null,
  json_ld_valid_through: detail.jsonLd.validThrough ?? null,
  provincie,
  publicatiedatum: detail.jsonLd.datePosted ?? null,
  reference: detail.reference,
  richttarief_raw: detail.facts.richttarief ?? null,
  start_raw: detail.facts.start ?? null,
  uren_per_week: detail.facts.uren ?? null,
  uren_raw: detail.facts.uren ?? null,
  werkvorm: werkvorm ?? null,
});

export const parseHarveyNashPayload = (
  payload: HarveyNashFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { detail } = payload;
  const parserVersion = HARVEYNASH_PARSER_VERSION;
  const titel = detail.jsonLd.title?.trim() || detail.title;
  const observedAt =
    detail.publishedAt === undefined
      ? undefined
      : new Date(detail.publishedAt * 1000);
  const deadline = resolveHarveyNashDeadline(detail.facts.deadline, observedAt);
  const tarief = parseHarveyNashRichttarief(detail.facts.richttarief);
  const beschrijving = resolveBeschrijving(detail, titel);
  const provincie = findProvincieInText(detail.facts.locatie ?? null);
  const duur = extractHarveyNashDuur(detail.jsonLd.description);
  const werkvorm = extractHarveyNashWerkvorm(detail.jsonLd.description);
  const sluitingsdatumRaw = resolveHarveyNashClosingRaw(
    deadline,
    validThroughForClosing(detail.jsonLd.validThrough)
  );
  const sluitingsdatumPassed = hasClosingMomentPassed(sluitingsdatumRaw);
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: false,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed,
  });

  return {
    beschrijving: field(
      beschrijving.value,
      parserVersion,
      beschrijving.sourcePath
    ),
    bronReferentie: field(detail.jobId, parserVersion, "job.id"),
    bronSpecifiek: field(
      buildHarveyNashBronSpecifiek({
        deadline,
        detail,
        duur,
        provincie,
        werkvorm,
      }),
      parserVersion,
      "detail"
    ),
    bronUrl: field(detail.url, parserVersion, "detail.url"),
    contentHash,
    extractieMethode: "html_parser",
    lifecycle,
    locatieLand: field("NL", parserVersion, "detail.facts.locatie"),
    locatieTekst: field(
      detail.facts.locatie?.trim() || UNKNOWN,
      parserVersion,
      "detail.facts.locatie"
    ),
    opdrachtgeverNaam: field(
      detail.eindklant?.trim() || UNKNOWN,
      parserVersion,
      "job.categories.Clients"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(sluitingsdatumRaw),
    startDatum: field(
      detail.facts.start?.trim() || UNKNOWN,
      parserVersion,
      "detail.facts.start"
    ),
    status: lifecycle,
    tarief,
    titel: field(titel, parserVersion, "detail.jsonLd.title"),
  };
};

export const decodeHarveyNashPayload = (
  body: Uint8Array
): HarveyNashFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Harvey Nash fetch.
  JSON.parse(new TextDecoder().decode(body)) as HarveyNashFetchedPayload;

export const normaliseHarveyNashObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseHarveyNashPayload(decodeHarveyNashPayload(body), contentHash);
