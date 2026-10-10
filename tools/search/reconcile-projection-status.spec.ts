import { describe, expect, it } from "bun:test";

import { hasProjectionDrift } from "./reconcile-projection-status";

const cleanCounts = {
  divergentCount: 0,
  invalidDocumentIdCount: 0,
  missingDocumentCount: 0,
  missingProjectionStateCount: 0,
  orphanManticoreCount: 0,
  physicalCorruptionCount: 0,
  staleManticoreHashCount: 0,
} as const;

describe("reconcile projection drift status", () => {
  it("accepts a completely reconciled projection", () => {
    expect(hasProjectionDrift(cleanCounts)).toBe(false);
  });

  it("fails closed for every reported drift category", () => {
    for (const field of Object.keys(cleanCounts)) {
      const counts = { ...cleanCounts, [field]: 1 };
      expect(hasProjectionDrift(counts)).toBe(true);
    }
  });
});
