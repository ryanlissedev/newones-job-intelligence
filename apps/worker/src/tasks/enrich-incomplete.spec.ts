import { describe, expect, it } from "bun:test";

import {
  enrichIncompleteDefaults,
  enrichIncompletePayload,
} from "./enrich-incomplete-schema";

describe("enrich-incomplete schema", () => {
  it("defaults dryRun to true and LLM residual to false", () => {
    expect(enrichIncompleteDefaults).toEqual({
      applyStoredProposals: false,
      batchSize: 25,
      dryRun: true,
      enableLlmResidual: false,
    });
  });

  it("accepts an empty payload and applies defaults at runtime", () => {
    expect(enrichIncompletePayload.parse({})).toEqual({});
  });

  it("bounds batch size", () => {
    expect(() => enrichIncompletePayload.parse({ batchSize: 501 })).toThrow();
  });

  it("accepts the durable flag without changing the defaults (CTP-626)", () => {
    expect(enrichIncompletePayload.parse({ durable: true })).toEqual({
      durable: true,
    });
    expect(() => enrichIncompletePayload.parse({ durable: "1" })).toThrow();
    expect("durable" in enrichIncompleteDefaults).toBe(false);
  });
});
