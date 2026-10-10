/* oxlint-disable anti-slop/no-runtime-typeof -- Standard Schema Issue.path is an untrusted I/O boundary (PropertyKey | PathSegment); narrowing happens only while formatting fail-fast messages that must never echo env values. */
import type { StandardSchemaV1 } from "@t3-oss/env-core";
import { Schema } from "effect";

/**
 * Shared Effect Schema helpers for `@ji/env`.
 *
 * ADR-0014 / Slice 6 (CTP-471): Effect Schema is the hand-maintained source of
 * truth. `@t3-oss/env-*` receives derived Standard Schema v1 adapters via
 * {@link Schema.toStandardSchemaV1} — not a second hand-written Zod canonical.
 *
 * Production Effect *runtime* activation elsewhere stays OFF; this package only
 * swaps the env schema SoT. Coolify / Motian are untouched.
 *
 * Validation errors must never echo secret values (DATABASE_URL passwords,
 * BETTER_AUTH_SECRET, RAW_S3_* keys, etc.). Messages may name keys and give
 * shape guidance only.
 */

export type EnvStandardSchema<T = string> = StandardSchemaV1<unknown, T>;

/** Non-empty string (min length 1). */
export const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Trimmed non-empty string (empty after trim fails). */
export const TrimmedNonEmptyString = Schema.Trim.check(Schema.isMinLength(1));

/**
 * WHATWG URL that stays a `string` (prior Zod `z.url()` parity).
 * `Schema.URLFromString` would decode to a `URL` object and break consumers.
 */
export const UrlString = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const parsed = new URL(value);
      void parsed;
    } catch {
      return "Invalid URL";
    }
  })
);

/** http(s) URL string — rejects `server:3000` (scheme "server") typos. */
export const HttpUrlString = Schema.String.check(
  Schema.makeFilter((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return "Invalid URL";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Expected http(s) URL";
    }
  })
);

/** Derive a Standard Schema v1 adapter from an Effect Schema (for createEnv). */
export const toEnvSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): EnvStandardSchema<S["Type"]> => Schema.toStandardSchemaV1(schema);

type IssuePathSegment = NonNullable<StandardSchemaV1.Issue["path"]>[number];

const pathSegmentKey = (segment: IssuePathSegment): string => {
  if (typeof segment === "string" || typeof segment === "number") {
    return String(segment);
  }
  if (typeof segment === "object" && segment !== null && "key" in segment) {
    return String(segment.key);
  }
  return "";
};

/**
 * Fail-fast boot error: names invalid keys and shape messages, never values.
 */
export const onEnvValidationError = (
  issues: readonly StandardSchemaV1.Issue[]
): never => {
  const keys = [
    ...new Set(
      issues.flatMap((issue) => {
        const head = issue.path?.[0];
        return typeof head === "string" ? [head] : [];
      })
    ),
  ].toSorted();
  const details = issues
    .map((issue) => {
      const path =
        issue.path?.map((segment) => pathSegmentKey(segment)).join(".") ?? "";
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
  const keyList = keys.length > 0 ? ` (${keys.join(", ")})` : "";
  console.error(`❌ Invalid environment variables${keyList}`);
  throw new Error(
    details.length > 0
      ? `Invalid environment variables: ${details}`
      : "Invalid environment variables"
  );
};

export const skipEnvValidation = (): boolean =>
  Boolean(process.env.SKIP_ENV_VALIDATION);

export { Effect, Schema } from "effect";
