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
    | "sourceCursor"
    | "stage"
    | "inventoryPartition"
    | "manticoreChecked"
    | "physicalCleanupCount"
  >;
}): string => {
  if (!input.apply) {
    return "no repair events were written by this run (dry run)";
  }
  if (input.latestApplyProgress === undefined) {
    return "the report-only preflight may have finished and the apply scan may already have committed its first page(s); check curated.outbox_event for aanvraag.projection_repair rows created by this run";
  }
  const inventoryNote =
    input.latestApplyProgress.stage === "inventory" &&
    input.latestApplyProgress.inventoryPartition !== undefined &&
    input.latestApplyProgress.manticoreChecked !== undefined
      ? `; latest committed inventory page: ${input.latestApplyProgress.inventoryPartition} scanned=${input.latestApplyProgress.manticoreChecked} (orphan-cleanup events for the inventory pages scanned so far may also be committed)`
      : "";
  const cursor = input.latestApplyProgress.sourceCursor ?? "none";
  return `repair events for aanvraag ids <= cursor ${cursor} are committed; the page in flight after it may also have committed (per-page transactions)${inventoryNote}`;
};

export interface ReconcileProgressThrottleState {
  lastPrintedApplied?: number;
  lastPrintedSkippedPending?: number;
  sourcePages: number;
  sourcePagesSinceLastPrint: number;
  inventoryPages?: number;
  inventoryPagesSinceLastPrint?: number;
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
      ? ` partition=${progress.inventoryPartition} scanned=${progress.manticoreChecked} physicalCleanup=${progress.physicalCleanupCount ?? 0}`
      : "";
  return (
    `[reconcile] ${progress.phase} ${progress.stage}: ` +
    `checked=${progress.checked} divergent=${progress.divergentCount} ` +
    `inserted=${progress.applied} skippedPending=${progress.skippedPending} ` +
    `cursor=${progress.sourceCursor ?? "none"}${inventory}`
  );
};

const countReconcileProgressPage = (
  progress: ReconcileProjectionProgress,
  state: ReconcileProgressThrottleState
): void => {
  if (progress.done) {
    return;
  }
  if (progress.stage === "source") {
    state.sourcePages += 1;
    state.sourcePagesSinceLastPrint += 1;
  }
  if (progress.stage === "inventory") {
    state.inventoryPages = (state.inventoryPages ?? 0) + 1;
    state.inventoryPagesSinceLastPrint =
      (state.inventoryPagesSinceLastPrint ?? 0) + 1;
  }
};

const shouldPrintStagePage = (
  phase: ReconcileProjectionProgress["phase"],
  countersChanged: boolean,
  pages: number,
  pagesSinceLastPrint: number
): boolean =>
  phase === "preflight"
    ? pages % 100 === 0
    : (countersChanged && pagesSinceLastPrint >= 10) || pages % 100 === 0;

const shouldPrintReconcileProgress = (
  progress: ReconcileProjectionProgress,
  state: ReconcileProgressThrottleState
): boolean => {
  if (progress.done) {
    return true;
  }
  const countersChanged =
    state.lastPrintedApplied === undefined ||
    state.lastPrintedSkippedPending === undefined ||
    progress.applied !== state.lastPrintedApplied ||
    progress.skippedPending !== state.lastPrintedSkippedPending;
  if (progress.stage === "inventory") {
    return shouldPrintStagePage(
      progress.phase,
      countersChanged,
      state.inventoryPages ?? 0,
      state.inventoryPagesSinceLastPrint ?? 0
    );
  }
  return shouldPrintStagePage(
    progress.phase,
    countersChanged,
    state.sourcePages,
    state.sourcePagesSinceLastPrint
  );
};

export const nextReconcileProgressStatus = (
  progress: ReconcileProjectionProgress,
  previous: ReconcileProgressThrottleState
): ReconcileProgressStatus => {
  const state = { ...previous };
  countReconcileProgressPage(progress, state);
  const shouldPrint = shouldPrintReconcileProgress(progress, state);

  if (shouldPrint) {
    state.lastPrintedApplied = progress.applied;
    state.lastPrintedSkippedPending = progress.skippedPending;
    if (progress.stage === "source") {
      state.sourcePagesSinceLastPrint = 0;
    }
    if (progress.stage === "inventory") {
      state.inventoryPagesSinceLastPrint = 0;
    }
  }

  return {
    line: formatReconcileProgress(progress),
    shouldPrint,
    state,
  };
};
