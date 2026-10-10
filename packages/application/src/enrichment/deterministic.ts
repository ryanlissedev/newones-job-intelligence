/* oxlint-disable anti-slop/no-runtime-typeof -- JobPosting JSON-LD is an untyped external payload; the field is narrowed before description extraction. */
import { extractJobPosting } from "@ji/connectors/json-ld";
import { UNKNOWN } from "@ji/domain";

import { hoursTextToPerWeek } from "../normalise/hours";
import { extractJobPostingCommercialFacts } from "../normalise/jobposting-html";
import { parseDutchDate } from "../normalise/json-ld";
import { parseTariefFromText } from "../normalise/tarief";
import {
  closingMomentInstant,
  isValidCalendarDate,
  stripHtml,
} from "../normalise/types";
import { isTitleFallbackDescription } from "../title-fallback-description";
import type { TitleFallbackDescriptionParts } from "../title-fallback-description";
import type {
  EnrichmentField,
  EnrichmentProposal,
  EnrichmentRawRef,
} from "./types";

const MIN_USABLE_DESCRIPTION_LENGTH = 24;
const BOILERPLATE_DESCRIPTION_PATTERN =
  /^(?:accept(?:eer| all)? cookies?|cookie(?:s|beleid)?|home(?:page)?|menu|navigatie|inloggen|registreren|privacy(?:beleid)?|contact)(?:[\s|•·:/-]+(?:accept(?:eer| all)? cookies?|cookie(?:s|beleid)?|home(?:page)?|menu|navigatie|inloggen|registreren|privacy(?:beleid)?|contact))*[.!?]?[\s]*$/iu;
const COOKIE_BANNER_PATTERN =
  /^(?:accep\w+|allow|manage|we use)\b[\s\S]*\bcookies?\b/iu;
const CHROME_ELEMENT_PATTERN =
  /<(?:aside|footer|header|nav|script|style)\b[^>]*>[\s\S]*?<\/(?:aside|footer|header|nav|script|style)>/giu;
const MAIN_CONTENT_PATTERN = /<main\b[^>]*>(?<content>[\s\S]*?)<\/main>/iu;

const LABELED_LOCATIE_PATTERN =
  /(?:Locatie|Standplaats|Werklocatie)\s*:\s*(?<value>.+)/iu;
const LABELED_CONTRACT_PATTERN =
  /(?:Contract(?:vorm|type)?|Type opdracht)\s*:\s*(?<value>.+)/iu;
const LABELED_REMOTE_PATTERN =
  /(?:Werkvorm|Remote|Thuiswerken|Hybride werken)\s*:\s*(?<value>.+)/iu;
const LABELED_UREN_PATTERN =
  /(?:Uren per week|Uren\/week|Uren p\/w|Aantal uur(?: per week)?|Hours per week|Weekly hours)\s*:\s*(?<value>.+)/iu;
const LABELED_OPLEIDING_PATTERN =
  /(?:Opleidingsniveau|Opleidingsvereisten?|Gewenste opleiding|Opleiding|Education(?:al)? level|Qualifications?)\s*:\s*(?<value>.+)/iu;
const LABELED_STARTDATUM_PATTERN =
  /(?:Startdatum|Ingangsdatum|Start date|Start|Aanvang(?:\s+opdracht)?)\s*:\s*(?<value>.+)/iu;
const LABELED_EINDDATUM_PATTERN =
  /(?:Einddatum|End date|Ends|Einde(?:\s+opdracht)?|Loop tot|Loopt tot)\s*:\s*(?<value>.+)/iu;
const LABELED_SLUITINGSDATUM_PATTERN =
  /(?:Sluitingsdatum|Sluiting|Reageren voor|Reageren tot|Uiterste reactiedatum|Reactiedatum|Deadline|Closing date|Apply by|Sollicitatiedatum)\s*:\s*(?<value>.+)/iu;
const LABELED_ORGANISATIE_PATTERN =
  /(?:Organisatie|Opdrachtgever|Eindklant|Organisation|Organization|Klant|Client)\s*:\s*(?<value>.+)/iu;

const NEXT_LABEL =
  /\s+(?:Tarief|Contract(?:vorm|type)?|Type opdracht|Werkvorm|Remote|Thuiswerken|Hybride werken|Locatie|Standplaats|Werklocatie|Gepubliceerd|Publicatiedatum|Uren per week|Uren\/week|Uren p\/w|Aantal uur|Hours per week|Weekly hours|Opleidingsniveau|Opleidingsvereisten?|Opleiding|Education(?:al)? level|Qualifications?|Startdatum|Ingangsdatum|Start date|Start|Aanvang|Einddatum|End date|Ends|Einde|Loop tot|Loopt tot|Sluitingsdatum|Sluiting|Reageren voor|Reageren tot|Uiterste reactiedatum|Reactiedatum|Deadline|Closing date|Apply by|Sollicitatiedatum|Organisatie|Opdrachtgever|Eindklant|Organisation|Organization|Klant|Client)\s*:/iu;

/** Definition-list and table label→value pairs (`<dt>Label</dt><dd>v</dd>`,
 * `<th>Label</th><td>v</td>`) are the canonical "labeled rawHTML" shape --
 * they carry no colon, so they are rewritten to `Label: v` before the HTML
 * is stripped and the plain-text label patterns can read them the same way
 * as inline "Label: value" prose. Other markup keeps its own text. */
const HTML_DT_DD_LABEL_PATTERN =
  /<dt\b[^>]*>(?<label>[\s\S]*?)<\/dt>\s*<dd\b[^>]*>(?<value>[\s\S]*?)<\/dd>/giu;
const HTML_TH_TD_LABEL_PATTERN =
  /<th\b[^>]*>(?<label>[\s\S]*?)<\/th>\s*<td\b[^>]*>(?<value>[\s\S]*?)<\/td>/giu;

const labeledHtmlToText = (html: string): string =>
  html
    .replaceAll(
      HTML_DT_DD_LABEL_PATTERN,
      (_match, label: string, value: string) => `${label}: ${value} `
    )
    .replaceAll(
      HTML_TH_TD_LABEL_PATTERN,
      (_match, label: string, value: string) => `${label}: ${value} `
    );

const trimAtNextLabel = (raw: string): string => {
  const match = raw.match(NEXT_LABEL);
  if (!match || match.index === undefined) {
    return raw.trim();
  }
  return raw.slice(0, match.index).trim();
};

/** Sentence punctuation directly after a labeled value ("36.", "Gemeente
 * Utrecht.") is the sentence's, not the value's. */
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:]+$/u;

const labeledValueText = (raw: string): string =>
  trimAtNextLabel(raw).replace(TRAILING_SENTENCE_PUNCTUATION, "").trim();

const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/\s+/gu, " ").trim();

const excerpt = (text: string, match: string): string => {
  const index = text.indexOf(match);
  if (index === -1) {
    return match.slice(0, 120);
  }
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + match.length + 40);
  return text.slice(start, end).trim();
};

/** Absolute ISO date/datetime only — never relative “N dagen geleden”. */
const isHonestTimestamp = (raw: string): boolean => {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}/u.test(trimmed)) {
    return false;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed);
};

const labeledProposal = (
  field: EnrichmentField,
  text: string,
  pattern: RegExp,
  mapValue: (raw: string) => EnrichmentProposal["value"] | null,
  confidence: number
): EnrichmentProposal | null => {
  const match = text.match(pattern);
  const raw = match?.groups?.value;
  if (!raw) {
    return null;
  }
  const value = mapValue(labeledValueText(raw));
  if (!value) {
    return null;
  }
  const rawRef: EnrichmentRawRef = {
    excerpt: excerpt(text, match[0] ?? raw),
    field,
    sourcePath: "beschrijving",
  };
  return {
    confidence,
    field,
    rawRefs: [rawRef],
    source: "deterministic",
    value,
  };
};

const extractLocatie = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "locatie",
    text,
    LABELED_LOCATIE_PATTERN,
    (raw) => {
      const locatieTekst = normalizeWhitespace(raw);
      return locatieTekst.length > 0 ? { locatieTekst } : null;
    },
    0.9
  );

const extractContract = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "contract",
    text,
    LABELED_CONTRACT_PATTERN,
    (raw) => {
      const contracttype = normalizeWhitespace(raw).toLowerCase();
      return contracttype.length > 0 ? { contracttype } : null;
    },
    0.88
  );

const extractRemote = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "remote",
    text,
    LABELED_REMOTE_PATTERN,
    (raw) => {
      const werkvorm = normalizeWhitespace(raw);
      return werkvorm.length > 0 ? { werkvorm } : null;
    },
    0.88
  );

/** Labeled detail values that carry no information ("n.v.t.", "onbekend",
 * single punctuation). The label matched but the source published no real
 * value, so there is nothing to propose. */
const LABELED_NON_VALUE_PATTERN =
  /^(?:n\.?\s?v\.?\s?t\.?|n\.?\s?a\.?|na|nnb|onbekend|unknown|geen|none|t\.?\s?b\.?\s?d\.?|in overleg)\.?$/iu;

const informativeLabeledValue = (raw: string): string | null => {
  const value = normalizeWhitespace(raw);
  if (value.length < 2 || LABELED_NON_VALUE_PATTERN.test(value)) {
    return null;
  }
  return value;
};

const BARE_ISO_LABELED_DATE_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const DUTCH_NUMERIC_DATE_PATTERN =
  /^(?<day>\d{1,2})[-/](?<month>\d{1,2})[-/](?<year>\d{4})$/u;
const ISO_LIKE_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

/** Normalises a labeled date value to a bare `YYYY-MM-DD`. Accepts ISO,
 * Dutch numeric (`01-10-2026`, `1/10/2026` -- day-first, the only reading
 * Dutch sources publish) and Dutch textual dates via `parseDutchDate`.
 * Anything else -- "per direct", "in overleg", unparseable or impossible
 * calendar dates -- yields `null`, so no proposal is ever invented. */
const parseLabeledDate = (raw: string): string | null => {
  const trimmed = raw.trim();
  const iso = BARE_ISO_LABELED_DATE_PATTERN.exec(trimmed);
  if (iso?.groups) {
    const { year, month, day } = iso.groups;
    return isValidCalendarDate(Number(year), Number(month), Number(day))
      ? trimmed
      : null;
  }
  const numeric = DUTCH_NUMERIC_DATE_PATTERN.exec(trimmed);
  if (numeric?.groups) {
    const { year, month, day } = numeric.groups;
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      !isValidCalendarDate(Number(year), Number(month), Number(day))
    ) {
      return null;
    }
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return parseDutchDate(trimmed) ?? null;
};

/** A closing moment keeps a resolvable ISO datetime (the label gave a real
 * instant); a bare date stays a bare date so `closingMomentInstant` can apply
 * the same end-of-day Europe/Amsterdam reading the normalisers use. */
const parseLabeledSluitingsdatum = (raw: string): string | null => {
  const date = parseLabeledDate(raw);
  if (date !== null) {
    return date;
  }
  const trimmed = raw.trim();
  if (!ISO_LIKE_DATETIME_PATTERN.test(trimmed)) {
    return null;
  }
  const instant = closingMomentInstant(trimmed);
  return instant ? instant.toISOString() : null;
};

const extractUren = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "uren",
    text,
    LABELED_UREN_PATTERN,
    (raw) => {
      const urenPerWeek = hoursTextToPerWeek(raw);
      return urenPerWeek === null ? null : { urenPerWeek };
    },
    0.9
  );

const extractOpleiding = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "opleiding",
    text,
    LABELED_OPLEIDING_PATTERN,
    (raw) => {
      const opleidingsniveau = informativeLabeledValue(raw);
      return opleidingsniveau === null ? null : { opleidingsniveau };
    },
    0.86
  );

const extractStartdatum = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "startdatum",
    text,
    LABELED_STARTDATUM_PATTERN,
    (raw) => {
      const startdatum = parseLabeledDate(raw);
      return startdatum === null ? null : { startdatum };
    },
    0.88
  );

const extractEinddatum = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "einddatum",
    text,
    LABELED_EINDDATUM_PATTERN,
    (raw) => {
      const einddatum = parseLabeledDate(raw);
      return einddatum === null ? null : { einddatum };
    },
    0.88
  );

const extractSluitingsdatum = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "sluitingsdatum",
    text,
    LABELED_SLUITINGSDATUM_PATTERN,
    (raw) => {
      const sluitingsdatum = parseLabeledSluitingsdatum(raw);
      return sluitingsdatum === null ? null : { sluitingsdatum };
    },
    0.88
  );

const extractOrganisatie = (text: string): EnrichmentProposal | null =>
  labeledProposal(
    "organisatie",
    text,
    LABELED_ORGANISATIE_PATTERN,
    (raw) => {
      const organisatie = informativeLabeledValue(raw);
      return organisatie === null ? null : { organisatie };
    },
    0.85
  );

const extractTarief = (text: string): EnrichmentProposal | null => {
  const parsed = parseTariefFromText(text);
  const hasAmount =
    parsed.min !== UNKNOWN ||
    parsed.max !== UNKNOWN ||
    parsed.eenheid !== UNKNOWN;
  if (!hasAmount) {
    return null;
  }
  if (parsed.min === UNKNOWN && parsed.max === UNKNOWN) {
    return null;
  }
  const match = text.match(/(?:tarief|ratio|rate|€)/iu);
  const rawRef: EnrichmentRawRef = {
    excerpt: match ? excerpt(text, match[0]) : text.slice(0, 120),
    field: "tarief",
    sourcePath: "beschrijving",
  };
  return {
    confidence: 0.86,
    field: "tarief",
    rawRefs: [rawRef],
    source: "deterministic",
    value: {
      eenheid: parsed.eenheid,
      max: parsed.max,
      min: parsed.min,
      valuta: parsed.valuta,
    },
  };
};

const extractPublicatiedatumFromJobPosting = (
  rawHtml: string | null | undefined
): EnrichmentProposal | null => {
  if (!rawHtml) {
    return null;
  }
  const facts = extractJobPostingCommercialFacts(rawHtml);
  const stamped = facts.publicatiedatum;
  if (stamped === null || !isHonestTimestamp(stamped)) {
    return null;
  }
  const rawRef: EnrichmentRawRef = {
    excerpt: `datePosted: ${stamped}`,
    field: "publicatiedatum",
    sourcePath: "rawHtml.jobPosting.datePosted",
  };
  return {
    confidence: 0.95,
    field: "publicatiedatum",
    rawRefs: [rawRef],
    source: "deterministic",
    value: { publicatiedatum: stamped.trim() },
  };
};

const usableDescription = (raw: string): string | null => {
  const text = normalizeWhitespace(
    stripHtml(raw.replaceAll(CHROME_ELEMENT_PATTERN, " "))
  );
  const words = text.split(" ").filter(Boolean);
  if (
    text.length < MIN_USABLE_DESCRIPTION_LENGTH ||
    words.length < 4 ||
    BOILERPLATE_DESCRIPTION_PATTERN.test(text) ||
    COOKIE_BANNER_PATTERN.test(text)
  ) {
    return null;
  }
  return text;
};

/**
 * Flextender detail pages put the vacancy body in the semantic `<main>` block
 * when JobPosting.description is absent. The selector is intentionally narrow
 * so navigation, cookie banners, and footer chrome cannot become a description.
 */
const extractBeschrijvingText = (
  rawHtml: string
): {
  readonly sourcePath: string;
  readonly text: string;
} | null => {
  const jobPosting = extractJobPosting(rawHtml);
  const jobPostingDescription =
    jobPosting && typeof jobPosting.description === "string"
      ? usableDescription(jobPosting.description)
      : null;
  if (jobPostingDescription !== null) {
    return {
      sourcePath: "rawHtml.jobPosting.description",
      text: jobPostingDescription,
    };
  }

  const mainContent = rawHtml.match(MAIN_CONTENT_PATTERN)?.groups?.content;
  const mainDescription = mainContent ? usableDescription(mainContent) : null;
  return mainDescription === null
    ? null
    : { sourcePath: "rawHtml.main", text: mainDescription };
};

const extractBeschrijving = (input: {
  readonly beschrijving: string;
  readonly rawHtml?: string | null;
  readonly titleFallbackParts?: TitleFallbackDescriptionParts | null;
}): EnrichmentProposal | null => {
  if (
    !input.rawHtml ||
    !isTitleFallbackDescription(input.beschrijving, input.titleFallbackParts)
  ) {
    return null;
  }
  const extracted = extractBeschrijvingText(input.rawHtml);
  if (
    extracted === null ||
    isTitleFallbackDescription(extracted.text, input.titleFallbackParts)
  ) {
    return null;
  }
  const rawRef: EnrichmentRawRef = {
    excerpt: extracted.text.slice(0, 160),
    field: "beschrijving",
    sourcePath: extracted.sourcePath,
  };
  return {
    confidence: 0.95,
    field: "beschrijving",
    rawRefs: [rawRef],
    source: "deterministic",
    value: { beschrijving: extracted.text },
  };
};

const textExtractors = {
  contract: extractContract,
  einddatum: extractEinddatum,
  locatie: extractLocatie,
  opleiding: extractOpleiding,
  organisatie: extractOrganisatie,
  remote: extractRemote,
  sluitingsdatum: extractSluitingsdatum,
  startdatum: extractStartdatum,
  tarief: extractTarief,
  uren: extractUren,
} satisfies Record<
  Exclude<EnrichmentField, "beschrijving" | "publicatiedatum">,
  (text: string) => EnrichmentProposal | null
>;

export const extractDeterministicEnrichment = (input: {
  readonly beschrijving: string;
  readonly fields: readonly EnrichmentField[];
  readonly rawHtml?: string | null;
  readonly titleFallbackParts?: TitleFallbackDescriptionParts | null;
}): readonly EnrichmentProposal[] => {
  const htmlText = input.rawHtml
    ? stripHtml(labeledHtmlToText(input.rawHtml))
    : "";
  const beschrijvingText = stripHtml(input.beschrijving);
  const combined = normalizeWhitespace(`${beschrijvingText} ${htmlText}`);
  return input.fields.flatMap((field) => {
    if (field === "publicatiedatum") {
      const proposal = extractPublicatiedatumFromJobPosting(input.rawHtml);
      return proposal ? [proposal] : [];
    }
    if (field === "beschrijving") {
      const proposal = extractBeschrijving(input);
      return proposal ? [proposal] : [];
    }
    if (!combined) {
      return [];
    }
    const proposal = textExtractors[field](combined);
    return proposal ? [proposal] : [];
  });
};
