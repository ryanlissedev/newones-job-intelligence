import { UNKNOWN } from "@ji/domain";

import { hoursTextToPerWeek } from "./hours";
import type { NormalisedTarief } from "./types";
import { stripHtml } from "./types";

/**
 * CTP-527 — deterministic field extraction from a live Starapple
 * `/vacatures/<slug>/` page. The CTP-514 audit could compare stored values
 * against only one reachable page; on it F03 locatie and F08 uren were
 * GAP_MAP (published on the page, absent in the Motian row) and F18 contact
 * was a deliberate POLICY_DROP. This extractor reads exactly what the page
 * publishes in its own markup and nothing more:
 *
 * - F03 `locatieTekst`: the city named in the location-pin block directly
 *   under the vacancy `<h1>` (e.g. "Utrecht" on devops-platform-engineer).
 * - F08 `urenPerWeek`: the "N uur" meta item inside `.vacancy-meta`.
 * - `tarief`: the `€ min-max` meta item in the same `.vacancy-meta` block;
 *   `eenheid` is only "maand"/"uur" when a cue is attached to a `€` amount
 *   ("bruto maandsalaris tussen € …", "€ … per uur") — a unit word in
 *   unrelated prose never claims the band, and conflicting cues stay
 *   UNKNOWN rather than guessing.
 * - F02 `eindklant`: only an explicitly labeled `Eindklant:`/`Opdrachtgever:`
 *   value. Starapple pages name the end client in vacancy PROSE ("binnen de
 *   politie", "Digitaal Politie Contact (DPC)"), which is prose mining —
 *   GAP_ENRICH (CTP-482), not a deterministic map — so this is null on the
 *   audited page by design.
 * - F18 `contactPublished`: whether the page publishes a recruiter contact
 *   channel. The values are recruiter PII and DEC-008/policy drops them
 *   (CTP-527 lane call: POLICY_DROP), so only the boolean is reported and no
 *   mailto/tel/name ever leaves this function.
 */
export interface StarapplePageFacts {
  readonly contactPublished: boolean;
  readonly eindklant: string | null;
  readonly locatieTekst: string | null;
  readonly tarief: NormalisedTarief | null;
  readonly urenPerWeek: string | null;
}

const ENTITY_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/&nbsp;/giu, " "],
  [/&euro;/giu, "€"],
  [/&euml;/giu, "ë"],
  [/&rsquo;|&lsquo;/giu, "'"],
  [/&ldquo;|&rdquo;/giu, '"'],
  [/&ndash;/giu, "–"],
  [/&mdash;/giu, "—"],
  [/&hellip;/giu, "…"],
];

const REPLACEMENT_CHARACTER = "�";

/** Numeric entities in sloppy live markup can name a code point outside
 * Unicode ("&#99999999;", "&#x110000;"); `fromCodePoint` throws there, so
 * out-of-range values decay to U+FFFD instead of crashing extraction. */
const codePointOrReplacement = (codePoint: number): string =>
  codePoint >= 0 && codePoint <= 1_114_111
    ? String.fromCodePoint(codePoint)
    : REPLACEMENT_CHARACTER;

const decodeEntities = (text: string): string => {
  let value = text
    .replaceAll(/&#x(?<code>[0-9a-f]+);/giu, (_match, code: string) =>
      codePointOrReplacement(Number.parseInt(code, 16))
    )
    .replaceAll(/&#(?<code>\d+);/gu, (_match, code: string) =>
      codePointOrReplacement(Number(code))
    );
  for (const [pattern, replacement] of ENTITY_REPLACEMENTS) {
    value = value.replaceAll(pattern, replacement);
  }
  // `&amp;` decodes last so an escaped entity ("&amp;euro;") does not decay
  // into markup the strip step already removed.
  return value.replaceAll(/&amp;/giu, "&");
};

const pageText = (html: string): string =>
  decodeEntities(stripHtml(html)).replaceAll(/\s+/gu, " ").trim();

/** Same flattening, but each stripped tag becomes a `|` boundary so a
 * labeled value can never run past the element that carried it. */
const delimitedPageText = (html: string): string =>
  decodeEntities(html.replaceAll(/<[^>]+>/gu, "|"))
    .replaceAll(/\s*\|\s*/gu, "|")
    .replaceAll(/\|{2,}/gu, "|")
    .replaceAll(/\s+/gu, " ")
    .trim();

const H1_PATTERN = /<h1\b[^>]*>[\s\S]*?<\/h1>/iu;
const FIRST_DIV_AFTER = /<div\b[^>]*>(?<inner>[\s\S]*?)<\/div>/iu;
const VACANCY_META_PATTERN = /vacancy-meta/iu;

/** City in the pin block rendered right below the `<h1>` ("Utrecht"). The
 * block's comment says "Company Name" but every audited page renders the
 * vacancy city there; a long or empty text is not a place and stays null.
 * The lookup stops at `.vacancy-meta`: when the pin block is absent the
 * first later div IS the meta block, and "40 uur" is not a place. */
const locatieFromHeader = (html: string): string | null => {
  const h1 = H1_PATTERN.exec(html);
  if (h1 === null) {
    return null;
  }
  const afterH1 = html.slice(h1.index + h1[0].length);
  const metaAt = afterH1.search(VACANCY_META_PATTERN);
  const headerWindow = (
    metaAt === -1 ? afterH1 : afterH1.slice(0, Math.max(0, metaAt))
  )
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .trimStart();
  // The pin block is the first node after the heading. Anything else
  // intervening means the page has no such block — never fall through to
  // an arbitrary later div.
  if (!headerWindow.startsWith("<div")) {
    return null;
  }
  const inner = FIRST_DIV_AFTER.exec(headerWindow)?.groups?.inner;
  if (!inner) {
    return null;
  }
  const text = pageText(inner);
  if (text.length === 0 || text.length > 80) {
    return null;
  }
  return text;
};

const VACANCY_META_OPEN = /<div\b[^>]*\bvacancy-meta\b[^>]*>/iu;
const DIV_BOUNDARY = /<div\b[^>]*>|<\/div>/giu;
const VACANCY_META_WINDOW = 4000;

/** Inner markup of the `.vacancy-meta` element, ended at its own closing
 * tag. A fixed character window would keep reading into the description
 * and benefits sections and claim their values ("Opleidingsbudget € 500
 * per maand") as vacancy meta. */
const vacancyMetaText = (html: string): string | null => {
  const open = VACANCY_META_OPEN.exec(html);
  if (open === null) {
    return null;
  }
  DIV_BOUNDARY.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (
    let tag = DIV_BOUNDARY.exec(html);
    tag !== null;
    tag = DIV_BOUNDARY.exec(html)
  ) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return pageText(html.slice(open.index, tag.index + tag[0].length));
    }
  }
  // Unbalanced markup: still bound the read instead of consuming the rest
  // of the document.
  return pageText(html.slice(open.index, open.index + VACANCY_META_WINDOW));
};

/** Dutch money notation: `3.661`, `3661`, `75,50` and `4.000,-`. */
const DUTCH_AMOUNT = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2}|,-)?|\d+(?:,\d{1,2}|,-)?`;

const TARIEF_RANGE_PATTERN = new RegExp(
  `€\\s*(?<min>${DUTCH_AMOUNT})\\s*[-–—]\\s*(?<max>${DUTCH_AMOUNT})`,
  "u"
);
const TARIEF_SINGLE_PATTERN = new RegExp(
  `€\\s*(?<amount>${DUTCH_AMOUNT})`,
  "u"
);
const EURO_AMOUNT_PATTERN = new RegExp(
  `€\\s*${DUTCH_AMOUNT}(?:\\s*[-–—]\\s*${DUTCH_AMOUNT})?`,
  "gu"
);
const NUMBER_IN_AMOUNT_PATTERN = new RegExp(DUTCH_AMOUNT, "gu");

const dutchAmount = (raw: string): string | null => {
  const [intPart, decPart] = raw.replaceAll(".", "").split(",");
  if (decPart === undefined || decPart === "-") {
    return intPart !== undefined && /^\d+$/u.test(intPart) ? intPart : null;
  }
  return intPart !== undefined &&
    /^\d+$/u.test(intPart) &&
    /^\d{1,2}$/u.test(decPart)
    ? `${intPart}.${decPart}`
    : null;
};
const EENHEID_CLAUSE_BOUNDARY = /(?<=[.!?;|•·])\s+/u;
const EENHEID_LEADIN_CHARS = 45;
const EENHEID_TAIL_CHARS = 40;
const MAAND_LEADIN_PATTERN =
  /\bmaandsalaris\b|\bper maand\b|\bbruto per maand\b|\bsalaris\b/iu;
const MAAND_UNIT_PATTERN = /\bmaandsalaris\b|\bper maand\b/iu;
const UUR_EENHEID_PATTERN = /\bper uur\b|\buurtarief\b|\/\s*uur\b/iu;

/** The eenheid cue must be attached to a `€` amount carrying the matched
 * band's own numbers, not merely present on the page: a lead-in phrase
 * inside the same clause shortly BEFORE the amount ("bruto maandsalaris
 * tussen € 3.661,-", "uurtarief van € 75,-") counts, and an explicit unit
 * directly AFTER it ("€ 75 - 95 per uur", "€ 4.000,- per maand") counts.
 * A bare "salaris" following an amount is prose, not a unit
 * ("€ 75 - 95 per uur. Het salaris …"), so the tail only accepts explicit
 * unit phrases. Amounts that are not the band's own (an "€ 500 per jaar"
 * benefit, a "€ 13.000" monthly equivalent) are skipped entirely — they
 * can neither claim the unit nor force a conflict. Every clause carrying
 * the band is checked; exactly ONE cue kind across them resolves to it,
 * while genuinely conflicting statements stay UNKNOWN rather than letting
 * one order of keywords win. */
const tariefEenheid = (
  text: string,
  min: string,
  max: string
): NormalisedTarief["eenheid"] => {
  const cues = new Set<"maand" | "uur">();
  for (const amount of text.matchAll(EURO_AMOUNT_PATTERN)) {
    const numbers = new Set(
      [...amount[0].matchAll(NUMBER_IN_AMOUNT_PATTERN)].map((match) =>
        dutchAmount(match[0])
      )
    );
    if (!(numbers.has(min) || numbers.has(max))) {
      continue;
    }
    const { index } = amount;
    const leadIn =
      text
        .slice(Math.max(0, index - EENHEID_LEADIN_CHARS), index)
        .split(EENHEID_CLAUSE_BOUNDARY)
        .pop() ?? "";
    const tail =
      text
        .slice(
          index + amount[0].length,
          index + amount[0].length + EENHEID_TAIL_CHARS
        )
        .split(EENHEID_CLAUSE_BOUNDARY)[0] ?? "";
    if (MAAND_LEADIN_PATTERN.test(leadIn) || MAAND_UNIT_PATTERN.test(tail)) {
      cues.add("maand");
    }
    if (UUR_EENHEID_PATTERN.test(leadIn) || UUR_EENHEID_PATTERN.test(tail)) {
      cues.add("uur");
    }
  }
  const [only] = cues;
  return cues.size === 1 && only ? only : UNKNOWN;
};

const tariefFromMeta = (
  metaText: string,
  fullText: string
): NormalisedTarief | null => {
  const range = TARIEF_RANGE_PATTERN.exec(metaText)?.groups;
  const single = range ? null : TARIEF_SINGLE_PATTERN.exec(metaText)?.groups;
  const min = range?.min ?? single?.amount;
  const max = range?.max ?? single?.amount;
  if (!(min && max)) {
    return null;
  }
  const normalizedMin = dutchAmount(min);
  const normalizedMax = dutchAmount(max);
  if (normalizedMin === null || normalizedMax === null) {
    return null;
  }
  if (Number(normalizedMin) > Number(normalizedMax)) {
    return null;
  }
  return {
    eenheid: tariefEenheid(fullText, normalizedMin, normalizedMax),
    max: normalizedMax,
    min: normalizedMin,
    valuta: "EUR",
  };
};

/** The label value runs to the end of its own element only — the `|`
 * boundary delimitedPageText leaves behind every stripped tag keeps
 * `Gemeente X` from absorbing the `<h2>Functie` that follows it. The
 * optional `\|` before the colon covers a label element closed between
 * the word and the colon (`<strong>Eindklant</strong>: X`). */
const LABELED_EINDKLANT_PATTERN =
  /(?:Eindklant|Opdrachtgever)\s*\|?\s*:\s*(?<value>[^|]+)/iu;
const EINDKLANT_NON_VALUE =
  /^(?:n\.?\s?v\.?\s?t\.?|n\.?\s?a\.?|onbekend|unknown|geen|none|vertrouwelijk|anoniem|in overleg)\.?$/iu;

const eindklantFromText = (text: string): string | null => {
  const raw = LABELED_EINDKLANT_PATTERN.exec(text)?.groups?.value;
  if (!raw) {
    return null;
  }
  const value = raw
    .trim()
    .replaceAll(/[.,;:]+$/gu, "")
    .trim();
  if (
    value.length < 2 ||
    value.length > 80 ||
    EINDKLANT_NON_VALUE.test(value)
  ) {
    return null;
  }
  return value;
};

const CONTACT_PUBLISHED_PATTERN =
  /contact opnemen|mailto:|tel:|contact-buttons/iu;
const SITE_CHROME_PATTERN =
  /<(?:header|footer|nav)\b[^>]*>[\s\S]*?<\/(?:header|footer|nav)>/giu;

/** Reads one Starapple vacancy page (raw or fixture-trimmed HTML). */
export const extractStarapplePageFacts = (html: string): StarapplePageFacts => {
  const fullText = pageText(html);
  const meta = vacancyMetaText(html);
  return {
    // Raw pages carry mailto:/tel: in global header/footer chrome; only
    // vacancy-body contact signals count as the vacancy publishing one.
    contactPublished: CONTACT_PUBLISHED_PATTERN.test(
      html.replaceAll(SITE_CHROME_PATTERN, " ")
    ),
    eindklant: eindklantFromText(delimitedPageText(html)),
    locatieTekst: locatieFromHeader(html),
    tarief: meta === null ? null : tariefFromMeta(meta, fullText),
    urenPerWeek: meta === null ? null : hoursTextToPerWeek(meta),
  };
};
