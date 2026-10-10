import { createHash } from "node:crypto";

import type {
  AanvraagLifecycle,
  Contactpersoon,
  ExtractieMethode,
  TariefEenheid,
  CLEARED,
} from "@ji/domain";
import { UNKNOWN } from "@ji/domain";

export interface FieldProvenanceSource {
  parserVersion: string;
  sourcePath: string;
}

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AanvraagProvenanceMap {
  beschrijving: FieldProvenanceSource;
  bron_referentie: FieldProvenanceSource;
  contactpersonen?: FieldProvenanceSource;
  bron_specifiek: FieldProvenanceSource;
  bron_url: FieldProvenanceSource;
  locatie_land: FieldProvenanceSource;
  locatie_tekst: FieldProvenanceSource;
  opdrachtgever_naam: FieldProvenanceSource;
  start_datum: FieldProvenanceSource;
  tarief_eenheid: FieldProvenanceSource;
  tarief_max: FieldProvenanceSource;
  tarief_min: FieldProvenanceSource;
  titel: FieldProvenanceSource;
}

export interface NormalisedField<Value> {
  provenance: FieldProvenanceSource;
  value: Value;
}

/** Observation metadata available to source normalisers when a field is
 * relative to the fetch instant rather than an upstream absolute date. */
export interface NormaliseContext {
  readonly observedAt?: Date;
}

export interface NormalisedTarief {
  eenheid: TariefEenheid | typeof CLEARED | typeof UNKNOWN;
  max: string | typeof CLEARED | typeof UNKNOWN;
  min: string | typeof CLEARED | typeof UNKNOWN;
  valuta: string;
}

export interface NormalisedAanvraagDraft {
  beschrijving: NormalisedField<string>;
  bronReferentie: NormalisedField<string>;
  bronSpecifiek: NormalisedField<JsonValue>;
  bronUrl: NormalisedField<string | typeof UNKNOWN>;
  /** CTP-610: contactpersonen published by the source (0..n). Absent for
   * bronnen without contact fields; a bron's `contactpersoon_beleid` may
   * also mask the field on the way in. */
  contactpersonen?: NormalisedField<Contactpersoon[]>;
  contentHash: string;
  extractieMethode: ExtractieMethode;
  lifecycle: AanvraagLifecycle;
  locatieLand: NormalisedField<string>;
  locatieTekst: NormalisedField<string | typeof UNKNOWN>;
  opdrachtgeverNaam: NormalisedField<string | typeof UNKNOWN>;
  parserVersion: string;
  startDatum: NormalisedField<string | typeof UNKNOWN>;
  status: AanvraagLifecycle;
  /** RJC-394: the closing-moment instant, when the bron publishes one --
   * same underlying value `hasClosingMomentPassed` already compares each
   * source's own closing signal against. Undefined for a bron that
   * genuinely publishes no deadline (honest-absent, never guessed). */
  sluitingsdatum?: Date;
  tarief: NormalisedTarief;
  titel: NormalisedField<string>;
}

export interface NormaliseValidationIssue {
  field: string;
  message: string;
}

export const validateNormalisedDraft = (
  draft: NormalisedAanvraagDraft
): NormaliseValidationIssue[] => {
  const issues: NormaliseValidationIssue[] = [];
  if (!draft.titel.value.trim()) {
    issues.push({ field: "titel", message: "titel is required" });
  }
  if (!draft.beschrijving.value.trim()) {
    issues.push({ field: "beschrijving", message: "beschrijving is required" });
  }
  if (!draft.bronReferentie.value.trim()) {
    issues.push({
      field: "bron_referentie",
      message: "bron_referentie is required",
    });
  }
  return issues;
};

export const isPresent = <Value>(
  value: Value | null | undefined
): value is Value => value !== null && value !== undefined;

export const numberToStringOrUnknown = (
  value: number | null | undefined
): string | typeof UNKNOWN => (isPresent(value) ? String(value) : UNKNOWN);

export const stripHtml = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

/** Dutch tenders/aanvragen close in Europe/Amsterdam wall-clock time. Every
 * source that publishes a closing moment (RJC-376) resolves against this
 * zone, never the deploy host's local time or a naive UTC read of a
 * timezone-less string. */
const CLOSING_TIME_ZONE = "Europe/Amsterdam";

/** Offset (ms) between UTC and `timeZone` in effect at `instant` -- i.e. how
 * much later `timeZone`'s wall clock reads than UTC's at that same instant.
 * Positive for Europe/Amsterdam (UTC+1 / UTC+2 DST). */
const timeZoneOffsetMsAt = (instant: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wallClockAsUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return wallClockAsUtcMs - instant.getTime();
};

/** Interprets a naive `YYYY-MM-DDTHH:mm:ss[.sss]` wall-clock string (no `Z`
 * or offset) as local time in `timeZone`, returning the true UTC instant.
 * Resolved in two passes: the offset near that wall clock (treating it as if
 * it were already UTC) is close enough to correct even across a DST
 * transition for this use case. */
const zonedWallClockToUtc = (wallClock: string, timeZone: string): Date => {
  const naiveUtc = new Date(`${wallClock}Z`);
  // Malformed/unrecognised input (e.g. a Dutch "31-12-2026" reaching the
  // bare-date branch) must not crash Intl.DateTimeFormat below -- bail with
  // the Invalid Date as-is, which reads as "not passed" downstream.
  if (Number.isNaN(naiveUtc.getTime())) {
    return naiveUtc;
  }
  // codex review, RJC-394 amendment: `Intl.DateTimeFormat.formatToParts`
  // carries no fractional-second field, so reconstructing the wall clock via
  // `Date.UTC` from its parts silently drops any millisecond remainder on
  // `naiveUtc` (e.g. the bare-date branch's `T23:59:59.999`). That dropped
  // ~1ms-999ms then leaked into the offset itself, rounding the end-of-day
  // instant forward into 00:00:00.xxx of the *next* calendar day instead of
  // 23:59:59.999 of the intended day. Compute the offset off the
  // whole-second instant (offsets are always whole minutes, never
  // sub-second, so this is exact) and apply it to the full millisecond-
  // precise instant.
  const wholeSecondInstant = new Date(
    naiveUtc.getTime() - naiveUtc.getMilliseconds()
  );
  const offsetMs = timeZoneOffsetMsAt(wholeSecondInstant, timeZone);
  return new Date(naiveUtc.getTime() - offsetMs);
};

const OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/u;
const ISO_DATE_PREFIX_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u;
const PUBLICATION_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;

/** Round-trips year/month/day (1-indexed month) through `Date.UTC` and
 * compares the fields back out, so an impossible calendar date (`2026-02-30`,
 * month 13, day 0) is rejected instead of silently rolling over into a
 * neighbouring real date -- `new Date` never throws on an out-of-range day/
 * month, it just overflows into the next one. Shared by every normaliser
 * that hand-parses a date (RJC-394: was duplicated in json-ld.ts and
 * harveynash.ts; moved here next to `closingMomentInstant`, which needs the
 * exact same guard for the raw strings normalisers feed it directly). */
export const isValidCalendarDate = (
  year: number,
  month1to12: number,
  day: number
): boolean => {
  const date = new Date(Date.UTC(year, month1to12 - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month1to12 - 1 &&
    date.getUTCDate() === day
  );
};

export const toValidPublicationDate = (
  value: string | null | undefined
): string | null => {
  if (
    !value ||
    !PUBLICATION_DATE_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return isValidCalendarDate(year, month, day) ? value : null;
};

/**
 * Resolves a source's raw closing-moment string to the actual UTC instant,
 * using the same rules `hasClosingMomentPassed` compares against (RJC-394:
 * shared so the two never drift). Returns `undefined` for
 * absent/empty/unparsable/calendar-invalid input -- never a guessed instant.
 *
 * - Absent/empty -> `undefined` (unknown closing information must not read
 *   as "already closed").
 * - An impossible calendar date (`2026-02-30`, month 13, day 0) ->
 *   `undefined` (codex review, RJC-394 amendment): a normaliser that hands
 *   this function a raw string directly (ctm, opdrachtoverheid, striive)
 *   has no upstream validity guard of its own, unlike json-ld/harveynash
 *   which already reject an impossible date before ever calling this.
 *   `new Date` never throws on out-of-range fields, it silently rolls over
 *   into a neighbouring real date, which would read as "closes on the wrong
 *   day" rather than "no valid closing information".
 * - A string carrying a time component (`T` or a space separator, e.g.
 *   CTM's `"2026-10-13T11:00:00"` or Opdrachtoverheid's
 *   `"2026-09-01 16:00:00"`) is compared at that instant. An explicit `Z`/
 *   offset suffix is honoured as-is; otherwise the naive wall clock is
 *   interpreted as `timeZone` (Europe/Amsterdam), never deploy-host local
 *   time or naive UTC.
 * - A bare `YYYY-MM-DD` date (Striive's `closingDateClient` truncated by
 *   `toDateOnly`, or any source that only ever publishes a date) is honest
 *   about carrying no time-of-day: the deadline is read as still open
 *   through the end of that day in `timeZone`, not its first instant.
 */
export const closingMomentInstant = (
  raw: string | null | undefined,
  timeZone: string = CLOSING_TIME_ZONE
): Date | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return;
  }
  const normalised = trimmed.includes("T")
    ? trimmed
    : trimmed.replace(" ", "T");
  const dateMatch = ISO_DATE_PREFIX_PATTERN.exec(normalised);
  if (
    !dateMatch?.groups ||
    !isValidCalendarDate(
      Number(dateMatch.groups.year),
      Number(dateMatch.groups.month),
      Number(dateMatch.groups.day)
    )
  ) {
    return;
  }
  const hasTimeComponent = normalised.length > 10 && normalised[10] === "T";
  let instant: Date;
  if (!hasTimeComponent) {
    instant = zonedWallClockToUtc(
      `${normalised.slice(0, 10)}T23:59:59.999`,
      timeZone
    );
  } else if (OFFSET_PATTERN.test(normalised)) {
    instant = new Date(normalised);
  } else {
    instant = zonedWallClockToUtc(normalised, timeZone);
  }
  return Number.isNaN(instant.getTime()) ? undefined : instant;
};

export const hasClosingMomentPassed = (
  raw: string | null | undefined,
  timeZone: string = CLOSING_TIME_ZONE
): boolean => {
  const instant = closingMomentInstant(raw, timeZone);
  return instant !== undefined && instant.getTime() < Date.now();
};

export const normalizeDedupText = (value: string): string =>
  value.replaceAll("\u001F", " ").trim().toLowerCase().replaceAll(/\s+/gu, " ");

/**
 * Byte ceiling for a `dedup_key` before it is replaced by its digest.
 *
 * `curated.dedup_groep.dedup_key` is covered by the unique btree index
 * `dedup_groep_dedup_key_uidx`, and Postgres refuses any index row over
 * **2704** bytes on a btree version 4 index ("index row size N exceeds btree
 * version 4 maximum 2704"). CTP-499: a Harvey Nash aanvraag produced a
 * 3,368-byte key, the insert raised `PostgresError 54000`, and every curation
 * pass for that source aborted on it.
 *
 * 2000 leaves roughly 700 bytes of margin over the Postgres number for the
 * index tuple header and any future page-layout change, and is comfortably
 * above every key observed in production, so the substitution stays rare.
 *
 * Measured in UTF-8 bytes, not characters: the index limit is a byte limit and
 * the normalised key routinely carries non-ASCII (accented client names, `\u2019`).
 */
export const DEDUP_KEY_MAX_BYTES = 2000;

/**
 * Marks a key as a digest rather than a literal key. Matches the `sha256:`
 * convention already used for content addresses elsewhere in this package, and
 * makes the two forms unambiguous: a literal key can never begin with this
 * prefix followed by 64 hex characters and nothing else, because a literal key
 * always carries at least two `\u001F` separators.
 */
const DEDUP_KEY_DIGEST_PREFIX = "sha256:";

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

/**
 * Keeps a key at or under {@link DEDUP_KEY_MAX_BYTES} unchanged, so every
 * `dedup_groep` row written before CTP-499 keeps matching, and replaces a
 * longer one with the digest of the *whole* normalised key. Truncating instead
 * would silently merge two aanvragen that differ only past the cut.
 */
export const boundDedupKey = (normalisedKey: string): string =>
  utf8ByteLength(normalisedKey) <= DEDUP_KEY_MAX_BYTES
    ? normalisedKey
    : `${DEDUP_KEY_DIGEST_PREFIX}${createHash("sha256").update(normalisedKey, "utf-8").digest("hex")}`;

export const buildDedupKey = (input: {
  opdrachtgeverNaam: string | typeof UNKNOWN;
  startDatum: string | typeof UNKNOWN;
  titel: string;
}): string =>
  boundDedupKey(
    [
      normalizeDedupText(input.titel),
      input.opdrachtgeverNaam === UNKNOWN
        ? UNKNOWN
        : normalizeDedupText(input.opdrachtgeverNaam),
      input.startDatum === UNKNOWN ? UNKNOWN : input.startDatum,
    ].join("\u001F")
  );

export const provenanceFor = (
  parserVersion: string,
  sourcePath: string
): FieldProvenanceSource => ({
  parserVersion,
  sourcePath,
});

export const field = <Value>(
  value: Value,
  parserVersion: string,
  sourcePath: string
): NormalisedField<Value> => ({
  provenance: provenanceFor(parserVersion, sourcePath),
  value,
});

export const buildProvenanceMap = (
  draft: NormalisedAanvraagDraft
): AanvraagProvenanceMap => {
  const map: AanvraagProvenanceMap = {
    beschrijving: draft.beschrijving.provenance,
    bron_referentie: draft.bronReferentie.provenance,
    bron_specifiek: draft.bronSpecifiek.provenance,
    bron_url: draft.bronUrl.provenance,
    locatie_land: draft.locatieLand.provenance,
    locatie_tekst: draft.locatieTekst.provenance,
    opdrachtgever_naam: draft.opdrachtgeverNaam.provenance,
    start_datum: draft.startDatum.provenance,
    tarief_eenheid: {
      parserVersion: draft.parserVersion,
      sourcePath: "tarief.eenheid",
    },
    tarief_max: {
      parserVersion: draft.parserVersion,
      sourcePath: "tarief.max",
    },
    tarief_min: {
      parserVersion: draft.parserVersion,
      sourcePath: "tarief.min",
    },
    titel: draft.titel.provenance,
  };
  if (draft.contactpersonen) {
    map.contactpersonen = draft.contactpersonen.provenance;
  }
  return map;
};
