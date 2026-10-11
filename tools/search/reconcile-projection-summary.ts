export interface ReconcileProjectionSummaryInput {
  apply: boolean;
  applied: number;
  checked: number;
  divergentCount: number;
  generation: number;
  inventoryCounts: {
    active: number;
    archive: number;
  } | null;
  invalidDocumentIdCount: number;
  orphanManticoreCount: number;
  physicalCleanupCount: number;
  physicalCorruptionCount: number;
  staleManticoreHashCount: number;
  skippedPending: number;
  pendingOutboxCount?: number;
  divergentPendingOutboxCount?: number;
  deadLetteredOutboxCount?: number;
  oldestPendingOutboxCreatedAt?: Date | null;
}

export const formatReconcileProjectionSummary = (
  result: ReconcileProjectionSummaryInput
): string => {
  const activeInventoryCount = result.inventoryCounts?.active ?? 0;
  const archiveInventoryCount = result.inventoryCounts?.archive ?? 0;
  const hasOutboxHealth =
    !result.apply &&
    result.pendingOutboxCount !== undefined &&
    result.divergentPendingOutboxCount !== undefined &&
    result.deadLetteredOutboxCount !== undefined &&
    result.oldestPendingOutboxCreatedAt !== undefined;
  const outboxHealth = hasOutboxHealth
    ? ` ${result.pendingOutboxCount} pending aanvraag outbox event(s), ${result.divergentPendingOutboxCount} covering divergent candidates, ${result.deadLetteredOutboxCount} dead-lettered aanvraag event(s), oldest pending ${result.oldestPendingOutboxCreatedAt?.toISOString() ?? "none"},`
    : "";

  return (
    `${result.apply ? "repair" : "dry run"} against generation ${result.generation}: ` +
    `${result.checked} curated aanvragen checked; Manticore active=${activeInventoryCount}, ` +
    `archive=${archiveInventoryCount}; ${result.divergentCount} divergent, ` +
    `${result.orphanManticoreCount} valid orphan(s), ${result.invalidDocumentIdCount} invalid engine id(s), ` +
    `${result.physicalCorruptionCount} corrupt physical row(s), ${result.physicalCleanupCount} physically deleted, ` +
    `${result.staleManticoreHashCount} stale physical hash(es), ${result.skippedPending} already covered by a pending outbox event,` +
    `${outboxHealth} ${result.applied} durable event(s) inserted.`
  );
};
