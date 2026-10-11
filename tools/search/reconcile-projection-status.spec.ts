import { describe, expect, it } from "bun:test";

import {
  formatReconcileInterruptionCommitment,
  formatReconcileProgress,
  hasProjectionDrift,
  nextReconcileProgressStatus,
} from "./reconcile-projection-status";

const cleanCounts = {
  divergentCount: 0,
  invalidDocumentIdCount: 0,
  missingDocumentCount: 0,
  missingProjectionStateCount: 0,
  orphanManticoreCount: 0,
  physicalCorruptionCount: 0,
  staleManticoreHashCount: 0,
} as const;

const inventoryProgress = () => ({
  applied: 0,
  checked: 0,
  divergentCount: 0,
  done: true,
  manticoreChecked: 0,
  phase: "preflight" as const,
  skippedPending: 0,
  sourceCursor: null,
  stage: "inventory" as const,
});

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

  it("formats interruption commitments for dry runs and apply progress", () => {
    expect(formatReconcileInterruptionCommitment({ apply: false })).toBe(
      "no repair events were written by this run (dry run)"
    );
    expect(formatReconcileInterruptionCommitment({ apply: true })).toBe(
      "the report-only preflight may have finished and the apply scan may already have committed its first page(s); check curated.outbox_event for aanvraag.projection_repair rows created by this run"
    );
    expect(
      formatReconcileInterruptionCommitment({
        apply: true,
        latestApplyProgress: {
          inventoryPartition: "active",
          manticoreChecked: 12,
          physicalCleanupCount: 3,
          sourceCursor: "cursor-123",
          stage: "inventory",
        },
      })
    ).toBe(
      "repair events for aanvraag ids <= cursor cursor-123 are committed; the page in flight after it may also have committed (per-page transactions); latest committed inventory page: active scanned=12 (orphan-cleanup events for the inventory pages scanned so far may also be committed)"
    );
  });

  it("formats inventory progress and throttles source progress", () => {
    const preflightProgress = {
      applied: 0,
      checked: 200,
      divergentCount: 1,
      done: false,
      phase: "preflight",
      skippedPending: 0,
      sourceCursor: "source-200",
      stage: "source",
    } as const;
    let state = { sourcePages: 0, sourcePagesSinceLastPrint: 0 };
    for (let page = 1; page < 100; page += 1) {
      const status = nextReconcileProgressStatus(
        {
          ...preflightProgress,
          checked: page * 2,
          sourceCursor: `source-${page}`,
        },
        state
      );
      ({ state } = status);
      expect(status.shouldPrint).toBe(false);
    }
    const hundredth = nextReconcileProgressStatus(preflightProgress, state);
    expect(hundredth.shouldPrint).toBe(true);

    const inventory = nextReconcileProgressStatus(
      {
        ...preflightProgress,
        inventoryPartition: "active",
        manticoreChecked: 12,
        physicalCleanupCount: 3,
        stage: "inventory",
      },
      {
        ...hundredth.state,
        inventoryPages: 99,
        inventoryPagesSinceLastPrint: 99,
      }
    );
    expect(inventory.shouldPrint).toBe(true);
    expect(inventory.line).toContain("partition=active scanned=12");
    expect(inventory.line).toContain("physicalCleanup=3");
    expect(formatReconcileProgress(inventoryProgress())).toContain(
      "cursor=none"
    );
  });

  it("bounds apply source progress when every page changes the counter", () => {
    let state = { sourcePages: 0, sourcePagesSinceLastPrint: 0 };
    let printed = 0;
    for (let page = 1; page <= 1400; page += 1) {
      const status = nextReconcileProgressStatus(
        {
          applied: page,
          checked: page,
          divergentCount: page,
          done: false,
          phase: "apply",
          skippedPending: 0,
          sourceCursor: `source-${page}`,
          stage: "source",
        },
        state
      );
      ({ state } = status);
      if (status.shouldPrint) {
        printed += 1;
      }
    }
    expect(printed).toBeLessThanOrEqual(140);
  });

  it("bounds apply inventory progress when every page changes the counter", () => {
    let state = { sourcePages: 0, sourcePagesSinceLastPrint: 0 };
    let printed = 0;
    for (let page = 1; page <= 1400; page += 1) {
      const status = nextReconcileProgressStatus(
        {
          applied: page,
          checked: 0,
          divergentCount: 0,
          done: false,
          inventoryPartition: "active",
          manticoreChecked: page,
          phase: "apply",
          skippedPending: 0,
          sourceCursor: null,
          stage: "inventory",
        },
        state
      );
      ({ state } = status);
      if (status.shouldPrint) {
        printed += 1;
      }
    }
    expect(printed).toBeLessThanOrEqual(140);
  });

  it("prints an apply counter change within ten source pages", () => {
    let state = { sourcePages: 0, sourcePagesSinceLastPrint: 0 };
    for (let page = 1; page <= 20; page += 1) {
      const status = nextReconcileProgressStatus(
        {
          applied: page >= 11 ? 1 : 0,
          checked: page,
          divergentCount: 0,
          done: false,
          phase: "apply",
          skippedPending: 0,
          sourceCursor: `source-${page}`,
          stage: "source",
        },
        state
      );
      ({ state } = status);
      if (page === 10) {
        expect(status.shouldPrint).toBe(true);
        expect(status.line).toContain("inserted=0");
      } else if (page === 20) {
        expect(status.shouldPrint).toBe(true);
        expect(status.line).toContain("inserted=1");
      } else {
        expect(status.shouldPrint).toBe(false);
      }
    }
  });
});
