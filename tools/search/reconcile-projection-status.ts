import type { ReconcileProjectionResult } from "@ji/db";

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
