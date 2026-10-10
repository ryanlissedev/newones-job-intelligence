import { describe, expect, it } from "bun:test";

import { formatHoursPerWeek, parseWeeklyHoursRange } from "./hours";

describe("formatHoursPerWeek", () => {
  it("formats an exact bound", () => {
    expect(formatHoursPerWeek(36, 36)).toBe("36");
  });

  it("formats a closed range with an en dash", () => {
    expect(formatHoursPerWeek(24, 36)).toBe("24–36");
  });

  it("keeps a one-sided minimum", () => {
    expect(formatHoursPerWeek(24, null)).toBe("≥24");
  });

  it("keeps a one-sided maximum", () => {
    expect(formatHoursPerWeek(null, 36)).toBe("≤36");
  });

  it("returns null when both bounds are absent", () => {
    expect(formatHoursPerWeek(null, null)).toBeNull();
  });

  it("rejects non-numeric or inverted bounds", () => {
    expect(formatHoursPerWeek(-1, 36)).toBeNull();
    expect(formatHoursPerWeek("unknown", 36)).toBeNull();
  });
});

describe("parseWeeklyHoursRange", () => {
  it("parses exact, range, and one-sided curated text", () => {
    expect(parseWeeklyHoursRange("32")).toEqual({ max: 32, min: 32 });
    expect(parseWeeklyHoursRange("32–40")).toEqual({ max: 40, min: 32 });
    expect(parseWeeklyHoursRange("24-28")).toEqual({ max: 28, min: 24 });
    expect(parseWeeklyHoursRange("≥32")).toEqual({ max: null, min: 32 });
    expect(parseWeeklyHoursRange("≤36")).toEqual({ max: 36, min: null });
  });

  it("leaves ambiguous free text unknown", () => {
    expect(parseWeeklyHoursRange("fulltime")).toEqual({ max: null, min: null });
    expect(parseWeeklyHoursRange("32 tot 40")).toEqual({
      max: null,
      min: null,
    });
    expect(parseWeeklyHoursRange("")).toEqual({ max: null, min: null });
    expect(parseWeeklyHoursRange(null)).toEqual({ max: null, min: null });
  });

  it("rejects inverted numeric ranges", () => {
    expect(parseWeeklyHoursRange("40–32")).toEqual({ max: null, min: null });
  });
});
