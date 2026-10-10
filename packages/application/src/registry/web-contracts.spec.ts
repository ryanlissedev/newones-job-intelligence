import { describe, expect, it } from "bun:test";

import { Schema } from "effect";

import {
  MARKERING_STATUSES,
  MarkeringStatusSchema,
  restCapabilityFailureSchema,
  searchAanvragenInputSchema,
  searchFiltersSchema,
} from "./web-contracts";

describe("web-contracts SoT surface (CTP-475)", () => {
  it("parses the REST capability failure envelope", () => {
    const parsed = restCapabilityFailureSchema.safeParse({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("parses the fail-closed export envelope the API actually sends", () => {
    const parsed = restCapabilityFailureSchema.safeParse({
      error: {
        code: "CAPABILITY_DISABLED",
        message:
          "Export is unavailable until a production export provider is connected",
        requestId: "71e46045-7292-4e6b-a6ab-4a63392a2d48",
      },
      ok: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.message).toBe(
        "Export is unavailable until a production export provider is connected"
      );
    }
  });

  it("rejects a failure body without message", () => {
    const parsed = restCapabilityFailureSchema.safeParse({
      error: { code: "X" },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps markering statuses identical to the prior UI tuple", () => {
    expect([...MARKERING_STATUSES]).toEqual([
      "relevant",
      "niet_relevant",
      "gevolgd",
    ]);
    expect(Schema.is(MarkeringStatusSchema)("gevolgd")).toBe(true);
    expect(Schema.is(MarkeringStatusSchema)("unknown")).toBe(false);
  });

  it("accepts a minimal search_aanvragen wire body", () => {
    const parsed = searchAanvragenInputSchema.safeParse({
      limit: 8,
      offset: 0,
      query: "Azure",
      sort: "relevance",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts SearchFilters shapes the web posts", () => {
    const parsed = searchFiltersSchema.safeParse({
      bronIds: ["00000000-0000-4000-8000-000000000001"],
      contracttype: ["interim"],
      freshnessDays: 7,
      tariefMin: 80,
    });
    expect(parsed.success).toBe(true);
  });
});
