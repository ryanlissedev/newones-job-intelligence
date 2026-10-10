const HOURS_BOUND_PATTERN = /^\d+(?:[.,]\d+)?$/u;

interface FormattedHourBound {
  value: string | null;
  numeric: number | null;
  valid: boolean;
}

/**
 * Formats source-published weekly-hour bounds for the text column consumed by
 * curation. A one-sided bound stays one-sided; no missing endpoint is inferred.
 */
export const formatHoursPerWeek = (
  min: string | number | null | undefined,
  max: string | number | null | undefined
): string | null => {
  const formatBound = (
    value: string | number | null | undefined
  ): FormattedHourBound => {
    if (value === null || value === undefined) {
      return { numeric: null, valid: true, value: null };
    }
    const trimmed = String(value).trim();
    if (!HOURS_BOUND_PATTERN.test(trimmed)) {
      return { numeric: null, valid: trimmed === "", value: null };
    }
    const numeric = Number(trimmed.replace(",", "."));
    return {
      numeric,
      valid: Number.isFinite(numeric),
      value: Number.isFinite(numeric) ? trimmed : null,
    };
  };

  const formattedMin = formatBound(min);
  const formattedMax = formatBound(max);
  if (!formattedMin.valid || !formattedMax.valid) {
    return null;
  }
  if (formattedMin.value === null && formattedMax.value === null) {
    return null;
  }
  if (formattedMin.value === null) {
    return `≤${formattedMax.value}`;
  }
  if (formattedMax.value === null) {
    return `≥${formattedMin.value}`;
  }
  if (
    formattedMin.numeric !== null &&
    formattedMax.numeric !== null &&
    formattedMin.numeric > formattedMax.numeric
  ) {
    return null;
  }

  const equal =
    formattedMin.value === formattedMax.value ||
    formattedMin.numeric === formattedMax.numeric;
  return equal
    ? formattedMin.value
    : `${formattedMin.value}–${formattedMax.value}`;
};

/** Matches the leading hour count (or dash range) out of free-text weekly-hours
 * copy such as BlueTrail's "32u p/w", Hero's "36 uur/week", or Pro-Act's "36
 * uur per week" / "32-40 uur bespreekbaar" -- the source never publishes a
 * bare number, so `parseWeeklyHoursRange` downstream would otherwise treat
 * the whole string as unparseable. */
const HOURS_TEXT_PATTERN =
  /(?<min>\d+(?:[.,]\d+)?)\s*(?:[-–]\s*(?<max>\d+(?:[.,]\d+)?))?\s*(?:u(?:ur)?|hours?|hrs?)\b/iu;

/** Dutch weekly-hours bands joined by "en"/"tot" ("Je werkt tussen de 32 en
 * 40 uur per week", Circle8): two hour counts with the connector directly
 * between them are a range, so the band must land as "32–40" — never as its
 * upper bound alone, which the dash pattern would otherwise return. Tried
 * first; inputs without this shape fall through to the existing patterns
 * unchanged. */
const HOURS_NL_RANGE_PATTERN =
  /(?<min>\d+(?:[.,]\d+)?)\s*(?:en|tot|t\/m)\s*(?<max>\d+(?:[.,]\d+)?)\s*(?:u(?:ur)?|hours?|hrs?)\b/iu;

/** A whole-field bare number or numeric range: "40" (Stedin), "32-36"
 * (ProRail). Anchored to the whole string so a schedule like "9am-5pm" never
 * reads as weekly hours. */
const BARE_HOURS_PATTERN =
  /^(?<min>\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(?<max>\d+(?:[.,]\d+)?))?$/u;

/** Extracts a clean `formatHoursPerWeek`-shaped string ("36" or "32–40") from
 * free-text weekly-hours copy. Dutch (`u`, `uur`), English (`hour`, `hours`,
 * `hr`) and -- only when the whole field is numeric -- bare numbers are
 * recognised, because the field itself (`workHours`, label-block
 * `urenPerWeek`, an enrichment "Uren per week" label) already declares the
 * unit. Text without a recognisable hour count (e.g. absent, "bespreekbaar",
 * or "Full time uur per week") yields `null` -- never a guess. */
export const hoursTextToPerWeek = (
  text: string | null | undefined
): string | null => {
  if (!text) {
    return null;
  }
  const match =
    HOURS_NL_RANGE_PATTERN.exec(text) ??
    HOURS_TEXT_PATTERN.exec(text) ??
    BARE_HOURS_PATTERN.exec(text.trim());
  if (!match?.groups?.min) {
    return null;
  }
  // A bare "32u p/w" is an exact figure, not an open-ended "at least 32" --
  // only a real dash range (`match.groups.max`) is a genuine one-sided bound.
  return formatHoursPerWeek(
    match.groups.min,
    match.groups.max ?? match.groups.min
  );
};

export interface WeeklyHoursRange {
  readonly max: number | null;
  readonly min: number | null;
}

const HOURS_NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const EXACT_HOURS = new RegExp(`^${HOURS_NUMBER}$`, "u");
const RANGE_HOURS = new RegExp(
  `^${HOURS_NUMBER}\\s*[-–—]\\s*${HOURS_NUMBER}$`,
  "u"
);
const MIN_ONLY_HOURS = new RegExp(`^[≥>=]\\s*${HOURS_NUMBER}$`, "u");
const MAX_ONLY_HOURS = new RegExp(`^[≤<=]\\s*${HOURS_NUMBER}$`, "u");

const toHoursNumber = (raw: string): number | null => {
  const numeric = Number(raw.replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
};

/**
 * Parses curated `uren_per_week` text into numeric bounds for search filters.
 * Ambiguous free text (not an exact number, en-dash range, or ≥/≤ bound)
 * stays unknown — never invent endpoints.
 */
export const parseWeeklyHoursRange = (
  raw: string | null | undefined
): WeeklyHoursRange => {
  if (raw === null || raw === undefined) {
    return { max: null, min: null };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { max: null, min: null };
  }

  const exact = EXACT_HOURS.exec(trimmed);
  if (exact?.[1] !== undefined) {
    const value = toHoursNumber(exact[1]);
    return { max: value, min: value };
  }

  const range = RANGE_HOURS.exec(trimmed);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    const min = toHoursNumber(range[1]);
    const max = toHoursNumber(range[2]);
    if (min === null || max === null || min > max) {
      return { max: null, min: null };
    }
    return { max, min };
  }

  const minOnly = MIN_ONLY_HOURS.exec(trimmed);
  if (minOnly?.[1] !== undefined) {
    return { max: null, min: toHoursNumber(minOnly[1]) };
  }

  const maxOnly = MAX_ONLY_HOURS.exec(trimmed);
  if (maxOnly?.[1] !== undefined) {
    return { max: toHoursNumber(maxOnly[1]), min: null };
  }

  return { max: null, min: null };
};
