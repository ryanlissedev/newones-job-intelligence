import type { OnefellowFetchedPayload } from "@ji/connectors/onefellow";
import {
  ONEFELLOW_PARSER_VERSION,
  onefellowDetailUrl,
} from "@ji/connectors/onefellow";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { formatHoursPerWeek } from "./hours";
import { parseTariefFromText } from "./tarief";
import { field, isValidCalendarDate, stripHtml } from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

/** Named entities confirmed across the real Onefellow listing capture
 * (2026-08-31, see fixtures/connectors/onefellow/) -- `description`/
 * `teaser`/`title` are htmlentities-encoded, so both markup (`&lt;`, `&gt;`)
 * and accented characters (`&eacute;`, `&iuml;`, ...) show up as named
 * entities. Decode before stripping tags, not after -- the literal
 * `<`/`>` characters only exist post-decode. */
const NAMED_ENTITIES = {
  amp: "&",
  bull: "•",
  eacute: "é",
  euml: "ë",
  euro: "€",
  gt: ">",
  harr: "↔",
  iuml: "ï",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  nbsp: " ",
  ndash: "–",
  oacute: "ó",
  ouml: "ö",
  quot: '"',
  rarr: "→",
  rdquo: "”",
  rsquo: "’",
  times: "×",
  uuml: "ü",
} satisfies Record<string, string>;

const ENTITY_PATTERN =
  /&(?:#(?<dec>\d+)|#x(?<hex>[\da-fA-F]+)|(?<named>[a-zA-Z]+));/gu;

const MAX_UNICODE_CODE_POINT = 0x10_ff_ff;
const SURROGATE_RANGE_START = 0xd8_00;
const SURROGATE_RANGE_END = 0xdf_ff;

/** A numeric character reference is only usable when it names a real
 * Unicode scalar value: within the codespace (`<= 0x10FFFF`, RJC-374 caught
 * `&#1114112;`, one past the ceiling) and not a lone surrogate half
 * (`0xD800`-`0xDFFF`, which `String.fromCodePoint` also throws on). Both
 * `Number(dec)` and `Number.parseInt(hex, 16)` can additionally yield `NaN`
 * or `Infinity` on malformed input, so a finite check comes first. */
const isDecodableCodePoint = (codePoint: number): boolean =>
  Number.isFinite(codePoint) &&
  codePoint >= 0 &&
  codePoint <= MAX_UNICODE_CODE_POINT &&
  !(codePoint >= SURROGATE_RANGE_START && codePoint <= SURROGATE_RANGE_END);

/** Leaves the original entity text untouched when the code point can't be
 * decoded -- we could not resolve it, so we do not pretend to have. */
const decodeNumericEntity = (match: string, codePoint: number): string =>
  isDecodableCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;

const decodeOnefellowEntitiesOnce = (raw: string): string =>
  raw.replaceAll(ENTITY_PATTERN, (match, dec, hex, named) => {
    if (dec) {
      return decodeNumericEntity(match, Number(dec));
    }
    if (hex) {
      return decodeNumericEntity(match, Number.parseInt(hex, 16));
    }
    if (!(named && Object.hasOwn(NAMED_ENTITIES, named))) {
      return match;
    }
    // SAFETY: Object.hasOwn just confirmed named is one of NAMED_ENTITIES's
    // own keys, so the cast only narrows a value already checked to exist.
    return NAMED_ENTITIES[named as keyof typeof NAMED_ENTITIES];
  });

/** The real ampersand character is confirmed double-encoded (2026-08-31
 * capture: `Bouwteam &amp;amp; Ontwerpfase`) while every other entity
 * (dashes, accents, tags) is single-encoded -- a single decode pass leaves
 * a literal `&amp;` behind for that case. Loop to a fixed point (bounded so
 * a pathological input can't spin) rather than special-casing `&amp;amp;`. */
const MAX_DECODE_PASSES = 3;

const decodeOnefellowEntities = (raw: string): string => {
  let current = raw;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = decodeOnefellowEntitiesOnce(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
};

const decodeAndStrip = (raw: string): string =>
  stripHtml(decodeOnefellowEntities(raw));

/** Onefellow publishes `start_date` as a Unix instant meant to be read as a
 * Europe/Amsterdam calendar date (its own free-text "Startdatum:" line
 * always matches the *local* date, e.g. 1790805600 -> "1 oktober 2026",
 * confirmed live 2026-08-31 across joborder_id 920/1029/1030/944/1006).
 * Slicing `toISOString()` reads the UTC date instead, which lands one day
 * early for any timestamp before 22:00/23:00 UTC -- every sampled record.
 * Format in the source's own timezone, never UTC. */
const AMSTERDAM_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Amsterdam",
  year: "numeric",
});

const unixSecondsToIsoDate = (
  value: number | undefined
): string | typeof UNKNOWN => {
  if (!value) {
    return UNKNOWN;
  }
  return AMSTERDAM_DATE_FORMATTER.format(new Date(value * 1000));
};

interface UrenRange {
  min: string | typeof UNKNOWN;
  max: string | typeof UNKNOWN;
}

const HOURS_RANGE_PATTERN = /^(?<min>\d+)\s*-\s*(?<max>\d+)$/u;
const HOURS_SINGLE_PATTERN = /^(?<value>\d+)$/u;

/** `hours` is a string range like "24-28", or occasionally a single value
 * like "32" (both confirmed live 2026-08-31). Unparseable text (not
 * observed in the capture, but the field is free text) yields UNKNOWN
 * rather than a guess. */
export const parseOnefellowUren = (raw?: string): UrenRange => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { max: UNKNOWN, min: UNKNOWN };
  }
  const range = trimmed.match(HOURS_RANGE_PATTERN);
  const rangeMax = range?.groups?.max;
  const rangeMin = range?.groups?.min;
  if (rangeMax && rangeMin) {
    return { max: rangeMax, min: rangeMin };
  }
  const single = trimmed.match(HOURS_SINGLE_PATTERN);
  const singleValue = single?.groups?.value;
  if (singleValue) {
    return { max: singleValue, min: singleValue };
  }
  return { max: UNKNOWN, min: UNKNOWN };
};

/** `max_rate` is populated on only 7/50 sampled records (2026-08-31 probe).
 * When it's absent, `salary` (a distinct free-text tariff line, also part
 * of the whitelisted payload -- see OnefellowJob doc comment) is the next
 * structured source; run it through the shared tarief-text parser instead
 * of giving up. Both empty leaves tarief UNKNOWN -- the ItemList's
 * `baseSalary=0/HOUR` seen on the public site is a known placeholder and is
 * never used as a rate. */
export const parseOnefellowTarief = (
  maxRate?: string,
  salaryText?: string
): NormalisedTarief => {
  const trimmedMaxRate = maxRate?.trim();
  if (trimmedMaxRate) {
    return { eenheid: "uur", max: trimmedMaxRate, min: UNKNOWN, valuta: "EUR" };
  }
  const trimmedSalary = salaryText?.trim();
  if (trimmedSalary) {
    return parseTariefFromText(trimmedSalary);
  }
  return { eenheid: UNKNOWN, max: UNKNOWN, min: UNKNOWN, valuta: "EUR" };
};

interface OnefellowLooptijd {
  duur: string | null;
  eindDatum: string | null;
}

const DURATION_DATE_PATTERN = /^(?<day>\d{2})-(?<month>\d{2})-(?<year>\d{4})$/u;

/** `duration` is free text describing the looptijd -- almost always a
 * phrase ("5 jaar met optie tot verlenging", "Onbepaalde tijd", confirmed
 * live 2026-08-31), but at least one live record (joborder_id 944) carries
 * a literal `DD-MM-YYYY` end date in the same field instead of a phrase.
 * Detect that shape explicitly and promote it to `eind_datum`; anything
 * else stays `duur` text, per the CTP-514 data contract (eind_datum only
 * from an explicit date, duur when only a duration is published). A
 * date-shaped but calendar-invalid value (`31-02-2026`, codex review,
 * RJC-514 amendment) falls back to `duur` text instead of persisting an
 * impossible date -- `new Date` never throws on an out-of-range day/month,
 * it silently rolls over into a neighbouring real date. */
const parseOnefellowLooptijd = (duration?: string): OnefellowLooptijd => {
  const trimmed = duration?.trim();
  if (!trimmed) {
    return { duur: null, eindDatum: null };
  }
  const match = trimmed.match(DURATION_DATE_PATTERN);
  const { day, month, year } = match?.groups ?? {};
  if (
    day &&
    month &&
    year &&
    isValidCalendarDate(Number(year), Number(month), Number(day))
  ) {
    return { duur: null, eindDatum: `${year}-${month}-${day}` };
  }
  return { duur: trimmed, eindDatum: null };
};

const resolveLocatie = (
  job: OnefellowFetchedPayload["job"]
): string | typeof UNKNOWN =>
  job.address_city?.trim() || job.company_city?.trim() || UNKNOWN;

export const parseOnefellowPayload = (
  payload: OnefellowFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { job } = payload;
  const parserVersion = ONEFELLOW_PARSER_VERSION;
  // `description` is htmlentities-encoded HTML; `teaser` and `title` are
  // plain text (confirmed live 2026-08-31: e.g. teaser "Het Kadaster is op
  // zoek naar een P&O Adviseur." carries a literal, un-encoded "&") -- only
  // `description` goes through decodeAndStrip.
  const beschrijving = job.description
    ? decodeAndStrip(job.description)
    : job.teaser?.trim() || job.title;
  const uren = parseOnefellowUren(job.hours);
  const tarief = parseOnefellowTarief(job.max_rate, job.salary);
  const looptijd = parseOnefellowLooptijd(job.duration);

  const sluitingsdatum = job.time_deadline
    ? new Date(job.time_deadline * 1000)
    : undefined;
  const sluitingsdatumPassed = sluitingsdatum
    ? sluitingsdatum.getTime() < Date.now()
    : false;
  // Every sampled record carries `status: "Open"` (2026-08-31 probe); the
  // bron's own signal is treated the same way as harveynash/opdrachtoverheid
  // -- anything other than "open" (case-insensitive) is the bron's own
  // closed signal, not date math.
  const bronSaysClosed = Boolean(
    job.status && job.status.trim().toLowerCase() !== "open"
  );
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed,
    current: "unknown",
    missedPolls: 0,
    seenOpen: !bronSaysClosed,
    sluitingsdatumPassed,
  });
  const urenMin = uren.min === UNKNOWN ? null : uren.min;
  const urenMax = uren.max === UNKNOWN ? null : uren.max;

  const bronSpecifiek = {
    duration: job.duration ?? null,
    duur: looptijd.duur,
    eind_datum: looptijd.eindDatum,
    hours_raw: job.hours ?? null,
    publicatiedatum: job.time_published
      ? new Date(job.time_published * 1000).toISOString()
      : null,
    salary_raw: job.salary ?? null,
    samenvatting: job.teaser?.trim() || null,
    sluitingsdatum: sluitingsdatum ? sluitingsdatum.toISOString() : null,
    status_bron: job.status ?? null,
    uren_max: urenMax,
    uren_min: urenMin,
    uren_per_week: formatHoursPerWeek(urenMin, urenMax),
    werkvorm: job.workplace_type ?? null,
  };

  return {
    beschrijving: field(beschrijving, parserVersion, "job.description"),
    bronReferentie: field(
      String(job.joborder_id),
      parserVersion,
      "job.joborder_id"
    ),
    bronSpecifiek: field(bronSpecifiek, parserVersion, "job"),
    bronUrl: field(onefellowDetailUrl(job), parserVersion, "job.joborder_id"),
    contentHash,
    extractieMethode: "api",
    lifecycle,
    locatieLand: field("NL", parserVersion, "job.company_city"),
    locatieTekst: field(resolveLocatie(job), parserVersion, "job.company_city"),
    opdrachtgeverNaam: field(
      job.company?.trim() || UNKNOWN,
      parserVersion,
      "job.company"
    ),
    parserVersion,
    sluitingsdatum,
    startDatum: field(
      unixSecondsToIsoDate(job.start_date),
      parserVersion,
      "job.start_date"
    ),
    status: lifecycle,
    tarief,
    titel: field(job.title, parserVersion, "job.title"),
  };
};

export const decodeOnefellowPayload = (
  body: Uint8Array
): OnefellowFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Onefellow fetch.
  JSON.parse(new TextDecoder().decode(body)) as OnefellowFetchedPayload;

export const normaliseOnefellowObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseOnefellowPayload(decodeOnefellowPayload(body), contentHash);
