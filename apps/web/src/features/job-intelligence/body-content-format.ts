/**
 * Per-bron Opdracht body ingest shape (CTP-481).
 *
 * Motian v1 backfill stores `description` as published — Nationale Vacaturebank
 * and sibling HTML/JSON-LD boards keep markup. Live JI normalisers strip HTML to
 * plain text before curated `beschrijving`. The detail UI therefore needs a
 * shared policy: render sanitized HTML when the bron (or payload) is HTML,
 * escape plain text, and leave room for markdown later.
 */

export const BODY_CONTENT_FORMATS = ["plain", "html", "markdown"] as const;

export type BodyContentFormat = (typeof BODY_CONTENT_FORMATS)[number];

/**
 * Explicit audit of how each bron's beschrijving typically arrives in curated
 * storage / UI mapping. Slugs match `bronNameToSource` (naam lowercased).
 */
export const BRON_BODY_CONTENT_FORMAT: ReadonlyMap<string, BodyContentFormat> =
  new Map([
    ["bluetrail", "plain"],
    ["ctm", "plain"],
    ["flextender", "html"],
    ["flinter", "plain"],
    ["harvey-nash", "plain"],
    ["harveynash", "plain"],
    ["hero", "plain"],
    ["hero-eu", "plain"],
    ["indeed", "plain"],
    ["inhuurdesk", "plain"],
    ["mipublic", "html"],
    ["nationale-vacaturebank", "html"],
    ["nationalevacaturebank", "html"],
    ["need-staffing", "plain"],
    ["needstaffing", "plain"],
    ["onefellow", "plain"],
    ["opdrachtoverheid", "plain"],
    ["pro-act", "plain"],
    ["pro-act-it", "plain"],
    ["starapple", "html"],
    ["starapple-nl", "html"],
    ["striive", "plain"],
    ["tenderned", "plain"],
    ["werkenvoor", "plain"],
    ["werkzoeken", "html"],
  ]);

/** Tags that indicate the payload is markup rather than escaped plain text. */
const HTML_MARKER_PATTERN =
  /<\/?(?:p|br|b|strong|i|em|ul|ol|li|h[1-6]|div|span|a|table|tr|td|th|section|article)\b/iu;

/** Entity-encoded markup (`&lt;p&gt;`) — Motian/OneFellow residual (CTP-483). */
const ENTITY_ENCODED_HTML_MARKER =
  /&lt;\/?(?:p|br|b|strong|i|em|ul|ol|li|h[1-6]|div|span|a|table|tr|td|th|section|article)\b/iu;

export const looksLikeHtml = (value: string): boolean =>
  HTML_MARKER_PATTERN.test(value) || ENTITY_ENCODED_HTML_MARKER.test(value);

export const bodyContentFormatForBron = (
  bronSlug: string | null | undefined
): BodyContentFormat | null => {
  if (!bronSlug) {
    return null;
  }
  return BRON_BODY_CONTENT_FORMAT.get(bronSlug) ?? null;
};

/**
 * Resolve how to render a body: prefer the bron audit, then detect leftover
 * HTML (e.g. unknown / mis-slugged Motian rows), else plain.
 */
export const resolveBodyContentFormat = (input: {
  readonly bronSlug?: string | null;
  readonly content: string;
}): BodyContentFormat => {
  const fromBron = bodyContentFormatForBron(input.bronSlug);
  if (fromBron === "html" || fromBron === "markdown") {
    return fromBron;
  }
  if (fromBron === "plain") {
    // Live strippers should leave plain text; if tags remain (bad scrape /
    // mixed backfill), still render safely as HTML rather than showing tags.
    return looksLikeHtml(input.content) ? "html" : "plain";
  }
  return looksLikeHtml(input.content) ? "html" : "plain";
};
