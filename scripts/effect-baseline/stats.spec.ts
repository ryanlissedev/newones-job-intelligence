import { describe, expect, test } from "bun:test";

import { percentile, summarizeLatencies } from "./stats";

describe("effect-baseline stats", () => {
  test("percentile interpolates within a sorted sample", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  test("summarizeLatencies ignores failure durations", () => {
    const summary = summarizeLatencies([5, 7, 9], 2);
    expect(summary).toEqual({ failures: 2, n: 3, p50: 7, p95: 8.8 });
  });
});
