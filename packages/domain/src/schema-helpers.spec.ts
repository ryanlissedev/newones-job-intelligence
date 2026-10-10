import { describe, expect, it } from "bun:test";

import { Schema } from "effect";

import {
  AanvraagLifecycleSchema,
  BRON_NAAM_MAX_LENGTH,
  BRON_REFERENTIE_MAX_LENGTH,
  BronConfigSchema,
  BronNaamSchema,
  BronReferentieSchema,
  BronStatusSchema,
  ConnectorMethodSchema,
  LifecycleRedenSchema,
  MoneyFieldsSchema,
  NonNegativeInteger,
  PositiveInteger,
  UnknownValueSchema,
  VoorwaardenStatusSchema,
} from "./index";

describe("domain Effect Schema SoT (CTP-470)", () => {
  it("accepts known aanvraag lifecycle literals and rejects unknowns", () => {
    expect(Schema.is(AanvraagLifecycleSchema)("active")).toBe(true);
    expect(Schema.is(AanvraagLifecycleSchema)("stale")).toBe(true);
    expect(Schema.is(AanvraagLifecycleSchema)("closed")).toBe(true);
    expect(Schema.is(AanvraagLifecycleSchema)("unknown")).toBe(true);
    expect(Schema.is(AanvraagLifecycleSchema)("archived")).toBe(false);
  });

  it("decodes money fields with null amount", () => {
    const decoded = Schema.decodeSync(MoneyFieldsSchema)({
      amount: null,
      currency: "EUR",
    });
    expect(decoded).toEqual({ amount: null, currency: "EUR" });
  });

  it("validates bron / voorwaarden / connector enums", () => {
    expect(Schema.is(BronStatusSchema)("ready")).toBe(true);
    expect(Schema.is(BronStatusSchema)("paused")).toBe(false);
    expect(Schema.is(VoorwaardenStatusSchema)("toegestaan")).toBe(true);
    expect(Schema.is(ConnectorMethodSchema)("json-ld")).toBe(true);
    expect(Schema.is(ConnectorMethodSchema)("graphql")).toBe(false);
  });

  it("decodes a full BronConfig shape", () => {
    const decoded = Schema.decodeSync(BronConfigSchema)({
      bronId: "bron-1",
      crawlDelayMs: 0,
      interval: "*/15 * * * *",
      loginVereist: false,
      mappingRef: null,
      method: "json-api",
      naam: "TenderNed",
      rateLimitPerMinute: 30,
      secretRef: null,
      status: "deferred",
      voorwaardenStatus: "toegestaan",
    });
    expect(decoded.bronId).toBe("bron-1");
    expect(decoded.method).toBe("json-api");
  });

  it("rejects non-positive rate limits on BronConfigSchema", () => {
    expect(() =>
      Schema.decodeSync(BronConfigSchema)({
        bronId: "bron-1",
        crawlDelayMs: 0,
        interval: "*/15 * * * *",
        loginVereist: false,
        mappingRef: null,
        method: "json-api",
        naam: "TenderNed",
        rateLimitPerMinute: 0,
        secretRef: null,
        status: "deferred",
        voorwaardenStatus: "toegestaan",
      })
    ).toThrow();
  });

  it("validates lifecycle reden and unknown sentinel", () => {
    expect(Schema.is(LifecycleRedenSchema)("listing_verdwenen")).toBe(true);
    expect(Schema.is(LifecycleRedenSchema)("manual")).toBe(false);
    expect(Schema.is(UnknownValueSchema)("unknown")).toBe(true);
    expect(Schema.is(UnknownValueSchema)("known")).toBe(false);
  });

  it("decodes a bron_referentie at the cap and rejects one past it (CTP-500)", () => {
    const atCap = "r".repeat(BRON_REFERENTIE_MAX_LENGTH);
    expect(Schema.decodeSync(BronReferentieSchema)(atCap)).toBe(atCap);
    expect(Schema.decodeSync(BronReferentieSchema)("TN-100")).toBe("TN-100");
    expect(() =>
      Schema.decodeSync(BronReferentieSchema)(`${atCap}r`)
    ).toThrow();
    expect(() => Schema.decodeSync(BronReferentieSchema)("")).toThrow();
  });

  it("decodes a bron naam at the cap and rejects one past it (CTP-500)", () => {
    const atCap = "n".repeat(BRON_NAAM_MAX_LENGTH);
    expect(Schema.decodeSync(BronNaamSchema)(atCap)).toBe(atCap);
    expect(() => Schema.decodeSync(BronNaamSchema)(`${atCap}n`)).toThrow();
    expect(() =>
      Schema.decodeSync(BronConfigSchema)({
        bronId: "bron-1",
        crawlDelayMs: 0,
        interval: "*/15 * * * *",
        loginVereist: false,
        mappingRef: null,
        method: "json-api",
        naam: `${atCap}n`,
        rateLimitPerMinute: 30,
        secretRef: null,
        status: "deferred",
        voorwaardenStatus: "toegestaan",
      })
    ).toThrow();
  });

  it("exposes shared integer helpers", () => {
    expect(Schema.is(PositiveInteger)(1)).toBe(true);
    expect(Schema.is(PositiveInteger)(0)).toBe(false);
    expect(Schema.is(NonNegativeInteger)(0)).toBe(true);
    expect(Schema.is(NonNegativeInteger)(-1)).toBe(false);
  });
});
