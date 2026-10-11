import type {
  ReconcileProjectionProgress,
  ReconcileProjectionResult,
} from "@ji/db";

type ProjectionDriftCounts = Pick<
  ReconcileProjectionResult,
  | "divergentCount"
  | "invalidDocumentIdCount"
  | "missingDocumentCount"
  | "missingProjectionStateCount"
  | "orphanManticoreCount"
  | "physicalCorruptionCount"
  | "staleManticoreHashCount"
>;

/** Return true when report-only reconciliation found any projection drift. */
export const hasProjectionDrift = (counts: ProjectionDriftCounts): boolean =>
  counts.divergentCount > 0 ||
  counts.invalidDocumentIdCount > 0 ||
  counts.missingDocumentCount > 0 ||
  counts.missingProjectionStateCount > 0 ||
  counts.orphanManticoreCount > 0 ||
  counts.physicalCorruptionCount > 0 ||
  counts.staleManticoreHashCount > 0;

export const formatReconcileInterruptionCommitment = (input: {
  apply: boolean;
  latestApplyProgress?: Pick<
    ReconcileProjectionProgress,
    "sourceCursor" | "stage"
  >;
}): string => {
  if (!input.apply) {
    return "no repair events were written by this run (dry run)";
  }
  if (input.latestApplyProgress === undefined) {
    return "the report-only preflight may have finished and the apply scan may already have committed its first page(s); check curated.outbox_event for aanvraag.projection_repair rows created by this run";
  }
  const inventoryNote =
    input.latestApplyProgress.stage === "inventory"
      ? "; orphan-cleanup events for the inventory pages scanned so far may also be committed"
      : "";
  const cursor = input.latestApplyProgress.sourceCursor ?? "none";
  return `repair events for aanvraag ids <= cursor ${cursor} are committed; the page in flight after it may also have committed (per-page transactions)${inventoryNote}`;
};

export interface ReconcileProgressThrottleState {
  lastPrintedApplied?: number;
  lastPrintedSkippedPending?: number;
  sourcePages: number;
  sourcePagesSinceLastPrint: number;
}

export interface ReconcileProgressStatus {
  line: string;
  shouldPrint: boolean;
  state: ReconcileProgressThrottleState;
}

export const formatReconcileProgress = (
  progress: ReconcileProjectionProgress
): string => {
  const inventory =
    progress.stage === "inventory" &&
    progress.inventoryPartition !== undefined &&
    progress.manticoreChecked !== undefined
      ? ` partition=${progress.inventoryPartition} scanned=${progress.manticoreChecked}`
      : "";
  return (
    `[reconcile] ${progress.phase} ${progress.stage}: ` +
    `checked=${progress.checked} divergent=${progress.divergentCount} ` +
    `inserted=${progress.applied} skippedPending=${progress.skippedPending} ` +
    `cursor=${progress.sourceCursor ?? "none"}${inventory}`
  );
};

export const nextReconcileProgressStatus = (
  progress: ReconcileProjectionProgress,
  previous: ReconcileProgressThrottleState
): ReconcileProgressStatus => {
  const state = { ...previous };
  if (progress.stage === "source" && !progress.done) {
    state.sourcePages += 1;
    state.sourcePagesSinceLastPrint += 1;
  }

  const sourceCountersChanged =
    state.lastPrintedApplied === undefined ||
    state.lastPrintedSkippedPending === undefined ||
    progress.applied !== state.lastPrintedApplied ||
    progress.skippedPending !== state.lastPrintedSkippedPending;
  const shouldPrint =
    progress.done ||
    progress.stage === "inventory" ||
    (progress.stage === "source" &&
      (progress.phase === "preflight"
        ? state.sourcePages % 100 === 0
        : (sourceCountersChanged && state.sourcePagesSinceLastPrint >= 10) ||
          state.sourcePages % 100 === 0));

  if (shouldPrint && progress.stage === "source") {
    state.lastPrintedApplied = progress.applied;
    state.lastPrintedSkippedPending = progress.skippedPending;
    state.sourcePagesSinceLastPrint = 0;
  }

  return {
    line: formatReconcileProgress(progress),
    shouldPrint,
    state,
  };
};
