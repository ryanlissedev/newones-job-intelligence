import { describe, expect, it } from "bun:test";

import { CLEARED, UNKNOWN, isCleared, isUnknown } from "./unknown";

describe("unknown domain value", () => {
  it("treats the canonical unknown token as unknown", () => {
    expect(isUnknown(UNKNOWN)).toBe(true);
  });

  it("does not treat a real field value as unknown", () => {
    expect(isUnknown("Amsterdam")).toBe(false);
  });
});

describe("cleared domain value", () => {
  it("treats the canonical cleared token as cleared", () => {
    expect(isCleared(CLEARED)).toBe(true);
  });

  it("does not treat unknown as cleared", () => {
    expect(isCleared(UNKNOWN)).toBe(false);
  });
});
