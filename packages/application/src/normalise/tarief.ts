import { UNKNOWN } from "@ji/domain";
import type { TariefEenheid } from "@ji/domain";

import type { NormalisedTarief } from "./types";

/** Dutch thousand separator then decimal comma, or plain decimal. */
const AMOUNT_CAPTURE =
  "(?<amount>\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)";

const MIN_CAPTURE = AMOUNT_CAPTURE.replace("?<amount>", "?<min>");
const MAX_CAPTURE = AMOUNT_CAPTURE.replace("?<amount>", "?<max>");

const TARIEF_CONTEXT_PATTERN =
  /\b(?:tarief|uurtarief|dagtarief|euro|eur)\b|€/iu;
const DATE_RANGE_PATTERN = /^\d{1,2}[-–]\d{1,2}[-–]\d{2,4}\b/u;
const NON_RATE_RANGE_CONTEXT_PATTERN =
  /^(?:\s*)(?:jaar|maanden?|weken?|personen?|fte|mensen|medewerkers|collega(?:'s|s)?|kandidaten|procesbeschrijvers|stuks|items)\b/iu;

/**
 * CTP-606: a comma followed by exactly three digits reads as English
 * thousands ("€3,150" = 3150) and as a Dutch three-decimal amount
 * ("€0,350" per kWh = 0.35) with equal force, and the two differ by 1000x.
 * Nothing in the surrounding copy separates them, so publish neither.
 */
const AMBIGUOUS_GROUPED_DECIMAL = /^\d{1,3},\d{3}$/u;

const normalizeAmount = (raw: string): string | typeof UNKNOWN => {
  const trimmed = raw.trim();
  if (AMBIGUOUS_GROUPED_DECIMAL.test(trimmed)) {
    return UNKNOWN;
  }
  if (/\.\d{3}/u.test(trimmed) && trimmed.includes(",")) {
    return trimmed.replaceAll(".", "").replace(",", ".");
  }
  if (/^\d{1,3}(?:\.\d{3})+$/u.test(trimmed)) {
    return trimmed.replaceAll(".", "");
  }
  if (trimmed.includes(",") && !trimmed.includes(".")) {
    return trimmed.replace(",", ".");
  }
  return trimmed.replace(",", ".");
};

const hasAny = (lower: string, tokens: readonly string[]): boolean =>
  tokens.some((token) => lower.includes(token));

const detectEenheid = (lower: string): TariefEenheid | typeof UNKNOWN => {
  // Explicit period wins over all-in / BTW gloss that often sits beside day rates.
  if (hasAny(lower, [" per dag", "/dag", "dagtarief", " per day", "/day"])) {
    return "dag";
  }
  if (
    hasAny(lower, [
      " per maand",
      "/maand",
      "maandtarief",
      " per month",
      "/month",
    ])
  ) {
    return "maand";
  }
  if (
    hasAny(lower, [
      " per uur",
      " p/u",
      "/uur",
      "uurtarief",
      " per hour",
      "/hour",
      "all-in",
      "all in",
      "ex btw",
      "excl. btw",
      "inclusief msp",
    ])
  ) {
    return "uur";
  }
  // Jobboard "salaris" ranges are monthly (or yearly when labeled), never the
  // bare-€ → uur default used for Dutch inhuur tarief copy.
  if (hasAny(lower, ["salaris", "bruto per maand", "maandsalaris"])) {
    return "maand";
  }
  if (
    hasAny(lower, [
      " jaarsalaris",
      " per jaar",
      "/jaar",
      " per year",
      "/year",
      " per annum",
    ])
  ) {
    // Domain TariefEenheid has no jaar yet; UNKNOWN beats mislabeling as uur.
    return UNKNOWN;
  }
  // Bare euro amounts in Dutch inhuur listings are almost always hourly.
  if (/€|euro/u.test(lower)) {
    return "uur";
  }
  return UNKNOWN;
};

const QUALITATIVE =
  /\b(?<qual>marktconform|in overleg|n\.?o\.?t\.?k\.?|n\.o\.t\.k)\b/iu;

const unknownTarief = (): NormalisedTarief => ({
  eenheid: UNKNOWN,
  max: UNKNOWN,
  min: UNKNOWN,
  valuta: "EUR",
});

const withEenheid = (
  lower: string,
  min: string | typeof UNKNOWN,
  max: string | typeof UNKNOWN
): NormalisedTarief => ({
  eenheid: detectEenheid(lower),
  max,
  min,
  valuta: "EUR",
});

const parseMaxOnly = (lower: string): NormalisedTarief | null => {
  // Currency required: "tot 36 uur per week" must not become a max-only rate.
  const maxMatch = lower.match(
    new RegExp(
      String.raw`(?:max(?:\.|\s+tarief)?|tot|tm|t\/m)\s*(?:van\s+)?(?:€|euro)\s*${AMOUNT_CAPTURE}`,
      "u"
    )
  );
  if (!maxMatch?.groups?.amount) {
    return null;
  }
  return withEenheid(lower, UNKNOWN, normalizeAmount(maxMatch.groups.amount));
};

/** Dutch "whole euros" suffix, as in "€ 5.517,-". */
const EURO_SUFFIX = String.raw`(?:\s*,-)?`;

/**
 * One rule for every currency-marked range, Dutch and English. CTP-606: the
 * two narrower rules it replaces each demanded their own connector and neither
 * tolerated the `,-` suffix, so "€ 5.517,- en € 9.337,-" fell through both of
 * them to the single-amount rule and published its floor as its ceiling.
 * parseBareRange stays separate: it owns the no-currency case and the date and
 * headcount guards that go with it.
 *
 * Scanned globally rather than matched once: a vacancy states hours before
 * money ("een dienstverband van 32 tot 40 uur per week. Een salaris tussen
 * € 4.238,- en € 6.635,-"), and the first amount pair must be rejected
 * without giving up on the rest of the text.
 */
const CURRENCY_RANGE_PATTERN = new RegExp(
  String.raw`(?:\b(?<open>tussen(?:\s+de)?|vanaf|van|from|between)\b\s*)?(?<cur>€|\beur\b)?\s*${MIN_CAPTURE}${EURO_SUFFIX}(?<conn>\s*[-–]\s*|\s+(?:en|and|tot|to|t\/m|tm)\s+)(?<cur2>€|\beur\b)?\s*${MAX_CAPTURE}${EURO_SUFFIX}`,
  "gu"
);

const CONJUNCTION_CONNECTOR = /^\s+(?:en|and)\s+$/u;

const parseCurrencyRange = (lower: string): NormalisedTarief | null => {
  for (const match of lower.matchAll(CURRENCY_RANGE_PATTERN)) {
    const { groups } = match;
    if (!(groups?.min && groups.max && groups.conn)) {
      continue;
    }
    const opener = groups.open ?? "";
    // An amount pair carrying neither a currency mark nor "tussen" is a
    // duration or a headcount far more often than a rate: "van 32 tot 40 uur
    // per week". Those belong to parseBareRange and its context guards.
    if (!(groups.cur || opener.startsWith("tussen"))) {
      continue;
    }
    // "en"/"and" joins two unrelated amounts ("€ 500 en 20 vakantiedagen")
    // as readily as it spans a range. Only "tussen"/"between" promises two
    // bounds; "van", "vanaf" and "from" introduce a single amount just as
    // often ("een bonus van € 500 en 1.000 euro opleidingsbudget"), so they
    // do not waive this. A currency mark on both bounds does.
    if (
      CONJUNCTION_CONNECTOR.test(groups.conn) &&
      !(opener.startsWith("tussen") || (groups.cur && groups.cur2))
    ) {
      continue;
    }
    const min = normalizeAmount(groups.min);
    const max = normalizeAmount(groups.max);
    // A ceiling below its floor means the two numbers were never one range.
    if (min !== UNKNOWN && max !== UNKNOWN && Number(min) > Number(max)) {
      continue;
    }
    return withEenheid(lower, min, max);
  }
  return null;
};

const parseBareRange = (lower: string): NormalisedTarief | null => {
  if (!TARIEF_CONTEXT_PATTERN.test(lower)) {
    return null;
  }
  const match = lower.match(
    new RegExp(
      String.raw`${MIN_CAPTURE}\s*[-–]\s*${MAX_CAPTURE}\s*(?:euro|eur)?`,
      "u"
    )
  );
  if (!(match?.groups?.min && match.groups.max)) {
    return null;
  }
  const matchStart = match.index ?? 0;
  const matchedRange = lower.slice(matchStart);
  if (DATE_RANGE_PATTERN.test(matchedRange)) {
    return null;
  }
  const rightContext = lower.slice(matchStart + match[0].length);
  if (NON_RATE_RANGE_CONTEXT_PATTERN.test(rightContext)) {
    return null;
  }
  return withEenheid(
    lower,
    normalizeAmount(match.groups.min),
    normalizeAmount(match.groups.max)
  );
};

const parseSingleEuro = (
  text: string,
  lower: string
): NormalisedTarief | null => {
  if (!TARIEF_CONTEXT_PATTERN.test(text)) {
    return null;
  }
  const match = text.match(
    new RegExp(String.raw`€\s*${AMOUNT_CAPTURE}(?:\s*,-)?`, "u")
  );
  if (!match?.groups?.amount) {
    return null;
  }
  return withEenheid(lower, UNKNOWN, normalizeAmount(match.groups.amount));
};

export const parseTariefFromText = (text: string): NormalisedTarief => {
  const lower = text.toLowerCase();
  if (QUALITATIVE.test(text) && !/€|\d/u.test(text)) {
    return unknownTarief();
  }
  // CTP-606: the range rule runs first so "van €4.488,- tot €7.515,-" is read
  // whole. It needs an amount before the connector, so "tot €95" still falls
  // through to the max-only rule.
  return (
    parseCurrencyRange(lower) ??
    parseMaxOnly(lower) ??
    parseBareRange(lower) ??
    parseSingleEuro(text, lower) ??
    unknownTarief()
  );
};

export interface TariefSnapshot {
  tarief_eenheid: string;
  tarief_max: string;
  tarief_min: string;
  tarief_valuta: string;
}

export const tariefToSnapshot = (tarief: NormalisedTarief): TariefSnapshot => ({
  tarief_eenheid: tarief.eenheid,
  tarief_max: tarief.max,
  tarief_min: tarief.min,
  tarief_valuta: tarief.valuta,
});

export const unknownTariefSnapshot = (): TariefSnapshot => ({
  tarief_eenheid: UNKNOWN,
  tarief_max: UNKNOWN,
  tarief_min: UNKNOWN,
  tarief_valuta: "EUR",
});
