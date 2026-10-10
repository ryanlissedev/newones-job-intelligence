/* oxlint-disable prefer-named-capture-group -- The UUID and ISO datetime patterns are copied verbatim from Zod 4 so the emitted JSON Schema `pattern` stays byte-identical. */
/* oxlint-disable anti-slop/no-unknown-parameters -- These helpers are the registry's untrusted I/O boundary: unknown is the input contract until a schema decodes it. */
/* oxlint-disable anti-slop/no-unknown-returns -- The undefined-key normaliser is structural and runs before any schema knows the shape. */
/* oxlint-disable anti-slop/no-runtime-typeof -- Structural narrowing of untrusted payloads and of JSON Schema metadata precedes any domain value. */
/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- JSON Schema documents are open by definition; they are serialised, never dereferenced by key. */
import { Schema, SchemaTransformation } from "effect";
import type { StandardSchema } from "effect";

/**
 * Shared Effect Schema helpers for the capability registry.
 *
 * ADR-0014 / Slice 4 (CTP-469): Effect Schema is the hand-maintained source of
 * truth for every public capability contract (`schemas.ts`, `capability.ts`,
 * `capabilities.ts`, handler I/O). Everything the registry and its transports
 * consume is *derived* from that one schema:
 *
 * - registry input/output/failure validation → Effect decode
 * - Standard Schema v1 (`~standard`) → {@link Schema.toStandardSchemaV1}
 * - MCP + REST JSON Schema descriptors → {@link Schema.toJsonSchemaDocument}
 * - transitional `parse`/`safeParse`/`safeParseAsync` consumers (`@ji/db`)
 *
 * There is deliberately **no** second hand-written Zod canonical for the same
 * tool I/O (ADR-0014 KTD4 stop-condition).
 *
 * Production Effect *runtime* activation elsewhere stays OFF; this slice only
 * swaps the schema SoT. Motian rematch/backfill paths are untouched.
 *
 * ## Wire parity notes
 *
 * The previous Zod contracts are the wire baseline, so a few Effect defaults
 * are deliberately overridden here:
 *
 * - `Schema.Struct` ignores excess keys by default; every registry decode runs
 *   with `onExcessProperty: "error"` to preserve Zod `.strict()` semantics.
 * - `Schema.Number` emits an `anyOf` with `"Infinity" | "-Infinity" | "NaN"`
 *   string members in JSON Schema. {@link FiniteNumber} is used for `z.number()`
 *   parity: `{ "type": "number" }` and non-finite values rejected.
 * - `Schema.optionalKey` rejects a present-but-`undefined` key, while Zod
 *   `.optional()` accepts it. Payloads are normalised (undefined-valued object
 *   keys dropped) before decoding, which is wire-neutral because JSON never
 *   carries `undefined`.
 * - `Schema.Struct({})` compiles to `anyOf: [object, array]`; {@link EmptyObject}
 *   uses a never-valued record so MCP inputs stay
 *   `{ "type": "object", "additionalProperties": false }`.
 * - UUID / ISO datetime use {@link Schema.isPattern} with the Zod 4 patterns
 *   rather than `Schema.isUUID`, so both the accepted value set and the emitted
 *   JSON Schema `pattern` stay byte-compatible with the previous descriptors.
 */

const jsonSchemaDialect = "https://json-schema.org/draft/2020-12/schema";

/** Decode options that reproduce Zod `.strict()` object semantics. */
const registryParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

/** Zod 4 `z.string().uuid()` pattern — RFC variants plus nil and max UUID. */
const uuidPattern =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;

/** Zod 4 `z.string().datetime()` pattern — calendar-aware, UTC (`Z`) only. */
const isoDateTimePattern =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z)$/u;

/** Non-empty string (Zod `z.string().min(1)`). */
export const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * Trimmed non-empty string (Zod `z.string().trim().min(1)`).
 *
 * The length check sits on both sides so the emitted JSON Schema keeps
 * `minLength: 1` while a whitespace-only value still fails after trimming.
 */
export const TrimmedNonEmptyString = NonEmptyString.pipe(
  Schema.decodeTo(NonEmptyString, SchemaTransformation.trim())
);

/** UUID string (Zod `z.string().uuid()`), kept as a `string` on both sides. */
export const UuidString = Schema.String.annotate({ format: "uuid" }).check(
  Schema.isPattern(uuidPattern)
);

/** ISO-8601 UTC datetime string (Zod `z.string().datetime()`). */
export const IsoDateTimeString = Schema.String.annotate({
  format: "date-time",
}).check(Schema.isPattern(isoDateTimePattern));

/** Finite JSON number (Zod `z.number()`): rejects `NaN` and `±Infinity`. */
export const FiniteNumber = Schema.Finite;

/** Integer (Zod `z.number().int()`). */
export const IntegerNumber = Schema.Number.check(Schema.isInt());

/** Positive integer (Zod `z.number().int().positive()`). */
export const PositiveInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

/** Non-negative integer (Zod `z.number().int().nonnegative()`). */
export const NonNegativeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);

/** Arbitrary JSON object (Zod `z.record(z.string(), z.unknown())`). */
export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Closed empty object (Zod `z.object({}).strict()`).
 *
 * A never-valued record rather than `Schema.Struct({})` so MCP tool inputs keep
 * emitting `{ "type": "object", "additionalProperties": false }` instead of
 * `anyOf: [object, array]`.
 */
export const EmptyObject = Schema.Record(Schema.String, Schema.Never);

/** Zod `.optional()` on a struct key (see the undefined-normalisation note). */
export const optionalField = Schema.optionalKey;

/** Extracts the decoded (`Type`) side of a capability schema. */
export type SchemaType<S> =
  S extends CapabilitySchema<infer Type, infer _E> ? Type : never;

/** Extracts the wire (`Encoded`) side of a capability schema. */
export type SchemaEncoded<S> =
  S extends CapabilitySchema<infer _T, infer Enc> ? Enc : never;

export interface CapabilityParseSuccess<Value> {
  readonly data: Value;
  readonly success: true;
}

export interface CapabilityParseFailure {
  readonly error: CapabilitySchemaError;
  readonly success: false;
}

export type CapabilityParseResult<Value> =
  | CapabilityParseFailure
  | CapabilityParseSuccess<Value>;

type StandardIssue = StandardSchema.StandardSchemaV1.Issue;

const issuePath = (issue: StandardIssue): string =>
  (issue.path ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment)
    )
    .join(".");

const formatIssues = (issues: readonly StandardIssue[]): string =>
  issues
    .map((issue) => {
      const path = issuePath(issue);
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

/** Validation failure raised by a derived capability schema adapter. */
export class CapabilitySchemaError extends Error {
  readonly issues: readonly StandardIssue[];

  constructor(issues: readonly StandardIssue[]) {
    super(formatIssues(issues) || "Schema validation failed");
    this.name = "CapabilitySchemaError";
    this.issues = issues;
  }
}

/**
 * The derived runtime face of one Effect Schema.
 *
 * `effect` is the source of truth; every other member is mechanically derived
 * from it so registry, `@ji/db` and the MCP/REST descriptors never diverge.
 */
export interface CapabilitySchema<
  out Type = unknown,
  out Encoded = Type,
> extends StandardSchema.StandardSchemaV1<Encoded, Type> {
  readonly effect: Schema.Codec<Type, Encoded>;
  readonly parse: (value: unknown) => Type;
  readonly safeParse: (value: unknown) => CapabilityParseResult<Type>;
  readonly safeParseAsync: (
    value: unknown
  ) => Promise<CapabilityParseResult<Type>>;
  /**
   * Derived JSON Schema for the MCP/REST descriptors. `"input"` (default)
   * describes the wire value a caller sends; `"output"` describes the decoded
   * value the registry returns — the same split the previous
   * `z.toJSONSchema(schema, { io })` calls made.
   */
  readonly toJsonSchema: (io?: "input" | "output") => Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Drops `undefined`-valued object keys so `Schema.optionalKey` accepts the same
 * payloads Zod `.optional()` did. Only plain objects and arrays are walked;
 * class instances (`Date`, `Set`, …) pass through untouched. JSON never carries
 * `undefined`, so this cannot change any wire payload.
 */
const dropUndefinedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = dropUndefinedKeys(item);
      changed ||= next !== item;
      return next;
    });
    return changed ? mapped : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      changed = true;
      continue;
    }
    const next = dropUndefinedKeys(item);
    changed ||= next !== item;
    result[key] = next;
  }
  return changed ? result : value;
};

const toPlainJsonSchema = (schema: unknown): Record<string, unknown> => {
  const serialized = JSON.stringify(schema, (_key, item: unknown) => {
    if (
      typeof item === "bigint" ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new TypeError("JSON Schema metadata must be JSON-compatible");
    }
    return item;
  });
  const parsed: unknown = JSON.parse(serialized);
  if (!isPlainObject(parsed)) {
    throw new TypeError("JSON Schema metadata must be an object");
  }
  return parsed;
};

/**
 * Derives the runtime adapter for one Effect Schema (the SoT).
 *
 * Keeping the Effect schema on `.effect` lets callers compose further without
 * reaching for a second schema library.
 */
export const toCapabilitySchema = <Type, Encoded>(
  effectSchema: Schema.Codec<Type, Encoded>
): CapabilitySchema<Type, Encoded> => {
  const standard = Schema.toStandardSchemaV1(effectSchema, {
    parseOptions: registryParseOptions,
  });
  const toParseResult = (
    result: StandardSchema.StandardSchemaV1.Result<Type>
  ): CapabilityParseResult<Type> =>
    result.issues
      ? { error: new CapabilitySchemaError(result.issues), success: false }
      : { data: result.value, success: true };
  const validate = (value: unknown) =>
    standard["~standard"].validate(dropUndefinedKeys(value));
  const safeParse = (value: unknown): CapabilityParseResult<Type> => {
    const result = validate(value);
    if (result instanceof Promise) {
      throw new TypeError(
        "This capability schema validates asynchronously; use safeParseAsync"
      );
    }
    return toParseResult(result);
  };
  const safeParseAsync = async (
    value: unknown
  ): Promise<CapabilityParseResult<Type>> =>
    toParseResult(await validate(value));

  return {
    effect: effectSchema,
    parse: (value: unknown): Type => {
      const parsed = safeParse(value);
      if (!parsed.success) {
        throw parsed.error;
      }
      return parsed.data;
    },
    safeParse,
    safeParseAsync,
    toJsonSchema: (
      io: "input" | "output" = "input"
    ): Record<string, unknown> => {
      const document = Schema.toJsonSchemaDocument(
        io === "output" ? Schema.toType(effectSchema) : effectSchema
      );
      const schema = toPlainJsonSchema(document.schema);
      const definitions = toPlainJsonSchema(document.definitions);
      return Object.keys(definitions).length > 0
        ? { $schema: jsonSchemaDialect, ...schema, $defs: definitions }
        : { $schema: jsonSchemaDialect, ...schema };
    },
    "~standard": { ...standard["~standard"], validate },
  };
};

/** Closed empty object adapter — shared by every no-input capability. */
export const emptyObjectSchema = toCapabilitySchema(EmptyObject);
