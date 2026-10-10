/**
 * Allowlisted Effect span attributes for critical-path alignment (ADR-0001/0003).
 * Digests and bounded counters only — never query text, SQL, vacancy IDs, or contact PII.
 *
 * oxlint: this module is the span-attribute I/O boundary. Loose bags are narrowed
 * here on purpose; dictionary/typeof/widening rules are scoped-disabled below.
 */

export const CRITICAL_PATH_SPAN_ATTRIBUTE_KEYS = [
  "arch",
  "cache-state",
  "concurrency",
  "dataset-digest",
  "executor",
  "index-state",
  "instrumentation-overhead-ms",
  "item-count",
  "label",
  "os",
  "percentile-p50",
  "percentile-p95",
  "percentile-p99",
  "query-identity",
  "queryset-digest",
  "result-digest",
  "run-kind",
  "toolchain",
  "vacuum-state",
  "workload-version",
] as const;

export type CriticalPathSpanAttributeKey =
  (typeof CRITICAL_PATH_SPAN_ATTRIBUTE_KEYS)[number];

export type CriticalPathSpanAttributes = Partial<
  Record<CriticalPathSpanAttributeKey, number | string>
>;

const ALLOWED_KEYS = new Set<string>(CRITICAL_PATH_SPAN_ATTRIBUTE_KEYS);

const DIGEST_PATTERN = /^(?:sha256|pg-queryid):[0-9a-f]{16,128}$/u;

const SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/iu;

const FORBIDDEN_SUBSTRINGS = [
  "password",
  "secret",
  "token",
  "email",
  "contact",
  "vacancy",
  "aanvraag",
  "select ",
  " insert ",
  "@",
] as const;

const looksLikePii = (value: string): boolean => {
  const lowered = value.toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (lowered.includes(needle)) {
      return true;
    }
  }
  return false;
};

const isSafeStringAttribute = (value: string): boolean => {
  if (value.length === 0 || value.length > 128) {
    return false;
  }
  if (looksLikePii(value)) {
    return false;
  }
  return DIGEST_PATTERN.test(value) || SAFE_TOKEN_PATTERN.test(value);
};

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- Span attribute sanitizer is the Effect tracing I/O boundary (CTP-478): accept allowlisted keys only, drop PII/free-form values before Effect.withSpan / annotateSpans. */

const acceptAttributeValue = (
  raw: number | string
): number | string | undefined => {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }
  return isSafeStringAttribute(raw) ? raw : undefined;
};

/**
 * Keeps only allowlisted keys with digest / bounded-token / finite-number values.
 */
export const sanitizeCriticalPathSpanAttributes = (
  input: CriticalPathSpanAttributes | undefined
): CriticalPathSpanAttributes => {
  if (input === undefined) {
    return {};
  }
  const out: CriticalPathSpanAttributes = {};
  for (const key of CRITICAL_PATH_SPAN_ATTRIBUTE_KEYS) {
    const raw = input[key];
    if (raw === undefined) {
      continue;
    }
    const accepted = acceptAttributeValue(raw);
    if (accepted !== undefined) {
      out[key] = accepted;
    }
  }
  return out;
};

/**
 * Sanitize a loose attribute bag (tests / interop). Unknown keys are dropped.
 */
export const sanitizeLooseCriticalPathSpanAttributes = (
  input: Readonly<Record<string, unknown>> | undefined
): CriticalPathSpanAttributes => {
  if (input === undefined) {
    return {};
  }
  const typed: CriticalPathSpanAttributes = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      continue;
    }
    if (typeof raw === "number" || typeof raw === "string") {
      typed[key as CriticalPathSpanAttributeKey] = raw;
    }
  }
  return sanitizeCriticalPathSpanAttributes(typed);
};

/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion */
