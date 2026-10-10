import { describe, expect, it } from "bun:test";

import { Effect, Schema } from "effect";

import {
  CapabilitySchemaError,
  emptyObjectSchema,
  FiniteNumber,
  IsoDateTimeString,
  optionalField,
  toCapabilitySchema,
  UuidString,
} from "./schema-helpers";

const validUuid = "550e8400-e29b-41d4-a716-446655440000";

const probeSchema = toCapabilitySchema(
  Schema.Struct({
    id: UuidString,
    limit: optionalField(FiniteNumber),
    observedAt: optionalField(IsoDateTimeString),
  })
);

describe("toCapabilitySchema", () => {
  it("keeps the Effect schema as the source of truth", () => {
    const effectSchema = Schema.Struct({ id: UuidString });
    expect(toCapabilitySchema(effectSchema).effect).toBe(effectSchema);
  });

  it("derives a Zod-compatible safeParse face", () => {
    const parsed = probeSchema.safeParse({ id: validUuid, limit: 10 });
    expect(parsed).toEqual({
      data: { id: validUuid, limit: 10 },
      success: true,
    });
    expect(probeSchema.safeParse({ id: "nope" }).success).toBe(false);
  });

  it("derives safeParseAsync from the same schema", async () => {
    await expect(
      probeSchema.safeParseAsync({ id: validUuid })
    ).resolves.toEqual({ data: { id: validUuid }, success: true });
    const rejected = await probeSchema.safeParseAsync({});
    expect(rejected.success).toBe(false);
  });

  it("throws a CapabilitySchemaError from parse", () => {
    expect(probeSchema.parse({ id: validUuid })).toEqual({ id: validUuid });
    expect(() => probeSchema.parse({ id: "nope" })).toThrow(
      CapabilitySchemaError
    );
  });

  it("derives a Standard Schema v1 adapter", () => {
    const result = probeSchema["~standard"].validate({ id: validUuid });
    expect(result).not.toBeInstanceOf(Promise);
    expect(probeSchema["~standard"].version).toBe(1);
  });

  it("rejects excess properties like the previous Zod .strict() contracts", () => {
    expect(probeSchema.safeParse({ id: validUuid, rogue: 1 }).success).toBe(
      false
    );
  });

  it("accepts an optional key that is present but undefined", () => {
    const parsed = probeSchema.safeParse({ id: validUuid, limit: undefined });
    expect(parsed).toEqual({ data: { id: validUuid }, success: true });
  });

  it("leaves non-plain objects untouched while normalising undefined keys", () => {
    const recordSchema = toCapabilitySchema(
      Schema.Struct({ at: Schema.Unknown })
    );
    const at = new Date(0);
    const parsed = recordSchema.safeParse({ at });
    expect(parsed.success && parsed.data.at).toBe(at);
  });
});

describe("derived JSON Schema", () => {
  it("emits draft 2020-12 with the previous wire shape", () => {
    // Optional keys stay absent from `required` and keep their plain type — no
    // `null` member leaking in from Effect's `undefined` encoding.
    expect(probeSchema.toJsonSchema()).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        id: {
          format: "uuid",
          pattern:
            "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          type: "string",
        },
        limit: { type: "number" },
        observedAt: {
          format: "date-time",
          pattern:
            "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?Z)$",
          type: "string",
        },
      },
      required: ["id"],
      type: "object",
    });
  });

  it("describes the decoded value for output descriptors", () => {
    const defaulted = toCapabilitySchema(
      Schema.Struct({
        evidence: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed<readonly string[]>([]))
        ),
        summary: Schema.String,
      })
    );
    // A defaulted key is optional on the wire but always present once decoded.
    expect(defaulted.toJsonSchema("input").required).toEqual(["summary"]);
    expect(defaulted.toJsonSchema("output").required).toEqual([
      "evidence",
      "summary",
    ]);
  });

  it("keeps an empty MCP input an object with additionalProperties false", () => {
    expect(emptyObjectSchema.toJsonSchema()).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      type: "object",
    });
  });

  it("keeps plain numbers plain instead of the Effect non-finite union", () => {
    expect(toCapabilitySchema(FiniteNumber).toJsonSchema()).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "number",
    });
  });
});

describe("shared filters", () => {
  it("accepts the empty object and rejects any key or array", () => {
    expect(emptyObjectSchema.safeParse({}).success).toBe(true);
    expect(emptyObjectSchema.safeParse({ rogue: 1 }).success).toBe(false);
    expect(emptyObjectSchema.safeParse([]).success).toBe(false);
  });

  it("matches the previous Zod uuid acceptance set", () => {
    const uuidSchema = toCapabilitySchema(UuidString);
    expect(uuidSchema.safeParse(validUuid).success).toBe(true);
    expect(
      uuidSchema.safeParse("00000000-0000-0000-0000-000000000000").success
    ).toBe(true);
    expect(
      uuidSchema.safeParse("11111111-1111-1111-1111-111111111111").success
    ).toBe(false);
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("matches the previous Zod datetime acceptance set", () => {
    const dateTimeSchema = toCapabilitySchema(IsoDateTimeString);
    expect(dateTimeSchema.safeParse("2024-01-01T00:00:00Z").success).toBe(true);
    expect(dateTimeSchema.safeParse("2024-01-01T00:00:00.123Z").success).toBe(
      true
    );
    expect(dateTimeSchema.safeParse("2024-01-01T00:00:00+02:00").success).toBe(
      false
    );
    expect(dateTimeSchema.safeParse("2024-01-01T00:00:00").success).toBe(false);
  });

  it("rejects non-finite numbers like the previous z.number()", () => {
    const numberSchema = toCapabilitySchema(FiniteNumber);
    expect(numberSchema.safeParse(1.5).success).toBe(true);
    expect(numberSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(
      false
    );
    expect(numberSchema.safeParse(Number.NaN).success).toBe(false);
  });
});
