import { describe, expect, it } from "bun:test";

import { formatReconcileProjectionSummary } from "./reconcile-projection-summary";

const baseResult = {
  applied: 0,
  checked: 4,
  divergentCount: 1,
  generation: 7,
  invalidDocumentIdCount: 0,
  inventoryCounts: { active: 3, archive: 1 },
  orphanManticoreCount: 0,
  physicalCleanupCount: 0,
  physicalCorruptionCount: 0,
  skippedPending: 1,
  staleManticoreHashCount: 0,
} as const;

describe("reconcile projection summary", () => {
  it("includes collected outbox health in dry-run summaries", () => {
    const summary = formatReconcileProjectionSummary({
      ...baseResult,
      apply: false,
      deadLetteredOutboxCount: 2,
      divergentPendingOutboxCount: 1,
      oldestPendingOutboxCreatedAt: new Date("2026-10-11T12:00:00.000Z"),
      pendingOutboxCount: 3,
    });

    expect(summary).toContain("3 pending aanvraag outbox event(s)");
    expect(summary).toContain("oldest pending 2026-10-11T12:00:00.000Z");
  });

  it("omits outbox health from apply summaries", () => {
    const summary = formatReconcileProjectionSummary({
      ...baseResult,
      apply: true,
      deadLetteredOutboxCount: 2,
      divergentPendingOutboxCount: 1,
      oldestPendingOutboxCreatedAt: new Date("2026-10-11T12:00:00.000Z"),
      pendingOutboxCount: 3,
    });

    expect(summary).not.toContain("pending aanvraag outbox event(s)");
    expect(summary).toContain("1 already covered by a pending outbox event");
  });
});
