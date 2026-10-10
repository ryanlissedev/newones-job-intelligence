/**
 * Allowlist sanitizer for Opdracht HTML bodies (CTP-481 / CTP-483).
 * Keeps formatting from Motian/HTML brons while stripping scripts, handlers,
 * and unsafe URLs. No DOMPurify dependency — works in Bun SSR + browser.
 *
 * CTP-483: Motian/OneFellow-style payloads may arrive entity-encoded
 * (`&lt;p&gt;…`). Decode before strip/sanitize so tags are not shown as text
 * and summaries never re-introduce markup via strip-then-decode.
 */

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "u",
  "ul",
]);

const VOID_TAGS = new Set(["br", "hr"]);

const TAG_PATTERN =
  /(?<raw><\/?(?<name>[a-zA-Z][\w:-]*)(?<attrs>[^>]*)>|<(?<bang>![^>]*)>)/gu;

const ATTR_PATTERN =
  /(?<name>[^\s=/>]+)(?:\s*=\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<bare>[^\s"'>]+)))?/gu;

const SAFE_HREF_PATTERN = /^(?:https?:|mailto:|\/|#)/iu;

/** Markers that mean the payload is markup escaped as entities, not live tags. */
const ENTITY_ENCODED_HTML_MARKER =
  /&lt;\/?(?:p|br|b|strong|i|em|ul|ol|li|h[1-6]|div|span|a|table|tr|td|th|section|article)\b/iu;

const MAX_ENTITY_DECODE_PASSES = 3;

const stripDangerousSequences = (html: string): string =>
  html
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replaceAll(/<!--[\s\S]*?-->/gu, "");

const decodeBasicEntitiesOnce = (value: string): string =>
  value
    .replaceAll(/&nbsp;/giu, " ")
    .replaceAll(/&#0*39;/gu, "'")
    .replaceAll(/&#x0*27;/giu, "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/**
 * Multi-pass entity decode for `&amp;lt;p&amp;gt;` style double-escaping.
 * Caps passes so pathological input cannot loop.
 */
export const decodeJobHtmlEntities = (value: string): string => {
  let current = value;
  for (let pass = 0; pass < MAX_ENTITY_DECODE_PASSES; pass += 1) {
    const next = decodeBasicEntitiesOnce(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
};

export const looksLikeEntityEncodedHtml = (value: string): boolean =>
  ENTITY_ENCODED_HTML_MARKER.test(value) || value.includes("&amp;lt;");

/**
 * When the body is entity-encoded markup, decode so sanitizer/strip see real
 * tags. Real HTML (`<p>…`) is returned unchanged.
 */
export const normalizeJobHtml = (value: string): string =>
  looksLikeEntityEncodedHtml(value) ? decodeJobHtmlEntities(value) : value;

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Allow http(s), mailto, absolute paths, and hash links — reject javascript:/data:. */
export const isSafeHref = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const decoded = decodeJobHtmlEntities(trimmed);
  if (/^[a-z0-9+.-]+:/iu.test(decoded) && !SAFE_HREF_PATTERN.test(decoded)) {
    return false;
  }
  return SAFE_HREF_PATTERN.test(decoded) || !/^[a-z0-9+.-]+:/iu.test(decoded);
};

const sanitizeAttributes = (tagName: string, attrs: string): string => {
  const kept: string[] = [];
  for (const match of attrs.matchAll(ATTR_PATTERN)) {
    const name = match.groups?.name?.toLowerCase();
    if (!name || name.startsWith("on") || name === "style") {
      continue;
    }
    const value =
      match.groups?.dq ?? match.groups?.sq ?? match.groups?.bare ?? "";
    if (tagName === "a") {
      if (name === "href" && isSafeHref(value)) {
        kept.push(
          `href="${escapeAttribute(value.trim())}"`,
          'rel="noopener noreferrer"',
          'target="_blank"'
        );
      }
      continue;
    }
    if (name === "class" || name === "title") {
      kept.push(`${name}="${escapeAttribute(value)}"`);
    }
  }
  return kept.length > 0 ? ` ${kept.join(" ")}` : "";
};

/**
 * Collapse markup to a single-line plain excerpt (summaries / list cards).
 * Decode first, then strip — never strip-then-decode (CTP-483).
 */
export const stripHtmlToText = (html: string): string =>
  decodeJobHtmlEntities(html)
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

export const sanitizeJobHtml = (dirty: string): string => {
  const withoutDanger = stripDangerousSequences(normalizeJobHtml(dirty));
  let output = "";
  let cursor = 0;

  for (const match of withoutDanger.matchAll(TAG_PATTERN)) {
    const index = match.index ?? 0;
    output += withoutDanger.slice(cursor, index);
    cursor = index + match[0].length;

    if (match.groups?.bang !== undefined) {
      continue;
    }

    const raw = match.groups?.raw ?? match[0];
    const name = match.groups?.name?.toLowerCase();
    const attrs = match.groups?.attrs ?? "";
    if (!name || !ALLOWED_TAGS.has(name)) {
      continue;
    }

    const isClosing = raw.startsWith("</");
    if (isClosing) {
      if (!VOID_TAGS.has(name)) {
        output += `</${name}>`;
      }
      continue;
    }

    if (VOID_TAGS.has(name)) {
      output += `<${name}>`;
      continue;
    }

    output += `<${name}${sanitizeAttributes(name, attrs)}>`;
  }

  output += withoutDanger.slice(cursor);
  return output;
};
