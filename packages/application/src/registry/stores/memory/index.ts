import type { SliceAStores } from "../types";
import { MemoryAanvraagStore } from "./aanvraag-store";
import { MemoryAlertStore } from "./alert-store";
import { MemoryApprovalStore } from "./approval-store";
import { MemoryAuditStore } from "./audit-store";
import { MemoryBronHealthStore } from "./bron-health-store";
import { MemoryExportAttemptStore } from "./export-attempt-store";
import { MemoryExportEffectStore } from "./export-effect-store";
import { MemoryExternalIdCrosswalkStore } from "./external-crosswalk-store";
import { MemoryExternalReceiptStore } from "./external-receipt-store";
import { MemoryMarkeringStore } from "./markering-store";
import { MemoryOperatorRunStore } from "./operator-run-store";
import { MemoryQuerySnapshotStore } from "./query-snapshot-store";
import { MemoryRawPayloadStore } from "./raw-payload-store";
import { MemorySavedSearchStore } from "./saved-search-store";

export const createMemorySliceAStores = (): SliceAStores & {
  readonly aanvragen: MemoryAanvraagStore;
  readonly alerts: MemoryAlertStore;
  readonly bronHealth: MemoryBronHealthStore;
  readonly exportAttempts: MemoryExportAttemptStore;
  readonly exportEffects: MemoryExportEffectStore;
  readonly externalReceipts: MemoryExternalReceiptStore;
  readonly rawPayloads: MemoryRawPayloadStore;
} => {
  const audit = new MemoryAuditStore();
  const approvals = new MemoryApprovalStore(audit);
  const exportAttempts = new MemoryExportAttemptStore();
  const externalCrosswalk = new MemoryExternalIdCrosswalkStore();
  const externalReceipts = new MemoryExternalReceiptStore();
  return {
    aanvragen: new MemoryAanvraagStore(),
    alerts: new MemoryAlertStore(),
    approvals,
    audit,
    bronHealth: new MemoryBronHealthStore(),
    exportAttempts,
    exportEffects: new MemoryExportEffectStore(
      externalCrosswalk,
      exportAttempts,
      externalReceipts
    ),
    externalCrosswalk,
    externalReceipts,
    markeringen: new MemoryMarkeringStore(audit),
    operatorRuns: new MemoryOperatorRunStore(),
    rawPayloads: new MemoryRawPayloadStore(),
    savedSearches: new MemorySavedSearchStore(audit),
    snapshots: new MemoryQuerySnapshotStore(approvals, exportAttempts),
  };
};

export { MemoryAanvraagStore } from "./aanvraag-store";
export { MemoryAlertStore } from "./alert-store";
export { MemoryApprovalStore } from "./approval-store";
export { MemoryAuditStore } from "./audit-store";
export { MemoryBronHealthStore } from "./bron-health-store";
export { MemoryMarkeringStore } from "./markering-store";
export { MemoryOperatorRunStore } from "./operator-run-store";
export { MemoryQuerySnapshotStore } from "./query-snapshot-store";
export { MemoryRawPayloadStore } from "./raw-payload-store";
export { MemoryExportAttemptStore } from "./export-attempt-store";
export { MemoryExportEffectStore } from "./export-effect-store";
export { MemoryExternalIdCrosswalkStore } from "./external-crosswalk-store";
export { MemoryExternalReceiptStore } from "./external-receipt-store";
export { MutationKeyQueue } from "./mutation-queue";
export { MemorySavedSearchStore } from "./saved-search-store";
export { MemoryScrapeRunReader } from "./scrape-run-reader";
export { MemoryMartsReader } from "./marts-reader";
