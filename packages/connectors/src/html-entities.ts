/**
 * Shared numeric/named HTML entity decoder (RJC-374). Extracted from
 * flinter/client.ts and needstaffing/client.ts, which carried byte-identical
 * implementations -- same `NAMED_ENTITIES` map, same `ENTITY_PATTERN`, same
 * `decodeNumericEntity`. Duplicating a decode ceiling in two places is what
 * let it drift out of sync in the first place, so this is the one place it
 * lives now.
 *
 * Map, not a Record literal, so lookups by an arbitrary string stay
 * type-safe without widening.
 */
const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

const ENTITY_PATTERN = /&(?<code>#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/gu;

const MAX_UNICODE_CODE_POINT = 0x10_ff_ff;
const SURROGATE_RANGE_START = 0xd8_00;
const SURROGATE_RANGE_END = 0xdf_ff;

/** A numeric character reference is only usable when it names a real
 * Unicode scalar value: within the codespace (`<= 0x10FFFF`, RJC-374 caught
 * `&#1114112;`, one past the ceiling) and not a lone surrogate half
 * (`0xD800`-`0xDFFF`, which `String.fromCodePoint` also throws on). */
const isDecodableCodePoint = (codePoint: number): boolean =>
  Number.isFinite(codePoint) &&
  codePoint >= 0 &&
  codePoint <= MAX_UNICODE_CODE_POINT &&
  !(codePoint >= SURROGATE_RANGE_START && codePoint <= SURROGATE_RANGE_END);

/** `undefined` means "could not decode this" -- every caller falls back to
 * `?? match`, leaving the original entity text untouched rather than
 * throwing or substituting a replacement character. */
const decodeNumericEntity = (code: string): string | undefined => {
  const isHex = code[1] === "x" || code[1] === "X";
  const codePoint = isHex
    ? Number.parseInt(code.slice(2), 16)
    : Math.trunc(Number(code.slice(1)));
  return isDecodableCodePoint(codePoint)
    ? String.fromCodePoint(codePoint)
    : undefined;
};

export const decodeHtmlEntities = (text: string): string =>
  text.replaceAll(
    ENTITY_PATTERN,
    (match, code: string) =>
      (code[0] === "#"
        ? decodeNumericEntity(code)
        : NAMED_ENTITIES.get(code)) ?? match
  );
