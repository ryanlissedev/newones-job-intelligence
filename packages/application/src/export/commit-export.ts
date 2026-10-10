import { z } from "zod";

import { validateSnapshotApproval } from "../approval/validate-snapshot-approval";
import type {
  ExportAttemptRecord,
  ExportAttemptStore,
  ExternalReceiptStore,
  SliceAStores,
} from "../registry/stores/types";
import {
  buildSkipReceiptPayload,
  confirmSpottCreateEffect,
} from "./confirm-export-effect";
import {
  buildExportIdempotencyKey,
  EXPORT_ACTION_CREATE,
  EXPORT_TARGET_SPOTT,
} from "./idempotency";
import { mapAanvraagToSpottCreateRequest } from "./map-aanvraag-to-spott";
import { hashExportReceiptSource } from "./response-hash";
import type { SpottWriteClient } from "./spott/client";

/** Outcome of this invocation; `failed` never proves the provider did nothing. */
export type CommitExportItemStatus = "created" | "failed" | "skipped";

export interface CommitExportItemResult {
  readonly canonicalVacancyId: string;
  readonly externalId: string | null;
  readonly idempotencyKey: string;
  readonly receiptId: string;
  readonly status: CommitExportItemStatus;
}

export interface CommitExportSuccess {
  readonly approvalId: string;
  readonly results: readonly CommitExportItemResult[];
  readonly snapshotId: string;
  readonly summary: {
    readonly created: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

export type CommitExportFailureCode =
  | "APPROVAL_EXPIRED"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_NOT_FOUND"
  | "NOT_FOUND"
  | "VALIDATION_ERROR";

export interface CommitExportFailure {
  readonly code: CommitExportFailureCode;
  readonly message: string;
}

export interface CommitExportDeps {
  readonly scopeId: string;
  readonly spottWriteClient: SpottWriteClient;
  readonly stores: Pick<
    SliceAStores,
    | "aanvragen"
    | "approvals"
    | "exportEffects"
    | "exportAttempts"
    | "externalCrosswalk"
    | "externalReceipts"
    | "snapshots"
  >;
}

const spottCreateResponseSchema = z.object({
  id: z.string().trim().min(1),
});

const recordAttempt = (
  store: ExportAttemptStore,
  record: Omit<ExportAttemptRecord, "createdAt" | "id">
): Promise<ExportAttemptRecord> => store.create(record);

const recordReceipt = (
  store: ExternalReceiptStore,
  input: {
    readonly attempt: ExportAttemptRecord;
    readonly canonicalVacancyId: string;
    readonly confirmedEffect: boolean;
    readonly responseHash: string;
    readonly spottVacancyId: string | null;
  }
) =>
  store.create({
    canonicalVacancyId: input.canonicalVacancyId,
    confirmedEffect: input.confirmedEffect,
    exportAttemptId: input.attempt.id,
    responseHash: input.responseHash,
    scopeId: input.attempt.scopeId,
    spottVacancyId: input.spottVacancyId,
  });

const recordFailedExport = async (input: {
  readonly approvalId: string;
  readonly canonicalVacancyId: string;
  readonly deps: CommitExportDeps;
  readonly errorMessage: string;
  readonly externalId: string | null;
  readonly idempotencyKey: string;
  readonly responseHash: string;
  readonly snapshotId: string;
}): Promise<CommitExportItemResult> => {
  const attempt = await recordAttempt(input.deps.stores.exportAttempts, {
    actionType: EXPORT_ACTION_CREATE,
    approvalId: input.approvalId,
    canonicalVacancyId: input.canonicalVacancyId,
    errorMessage: input.errorMessage,
    externalId: input.externalId,
    idempotencyKey: input.idempotencyKey,
    scopeId: input.deps.scopeId,
    snapshotId: input.snapshotId,
    status: "failed",
    target: EXPORT_TARGET_SPOTT,
  });
  const receipt = await recordReceipt(input.deps.stores.externalReceipts, {
    attempt,
    canonicalVacancyId: input.canonicalVacancyId,
    confirmedEffect: false,
    responseHash: input.responseHash,
    spottVacancyId: input.externalId,
  });
  return {
    canonicalVacancyId: input.canonicalVacancyId,
    externalId: input.externalId,
    idempotencyKey: input.idempotencyKey,
    receiptId: receipt.id,
    status: "failed",
  };
};

const recordSkippedExport = async (input: {
  readonly approvalId: string;
  readonly canonicalVacancyId: string;
  readonly deps: CommitExportDeps;
  readonly externalId: string;
  readonly idempotencyKey: string;
  readonly snapshotId: string;
}): Promise<CommitExportItemResult> => {
  const responseHash = await hashExportReceiptSource(
    buildSkipReceiptPayload({
      externalId: input.externalId,
      idempotencyKey: input.idempotencyKey,
    })
  );
  const attempt = await recordAttempt(input.deps.stores.exportAttempts, {
    actionType: EXPORT_ACTION_CREATE,
    approvalId: input.approvalId,
    canonicalVacancyId: input.canonicalVacancyId,
    errorMessage: null,
    externalId: input.externalId,
    idempotencyKey: input.idempotencyKey,
    scopeId: input.deps.scopeId,
    snapshotId: input.snapshotId,
    status: "skipped",
    target: EXPORT_TARGET_SPOTT,
  });
  const receipt = await recordReceipt(input.deps.stores.externalReceipts, {
    attempt,
    canonicalVacancyId: input.canonicalVacancyId,
    confirmedEffect: true,
    responseHash,
    spottVacancyId: input.externalId,
  });
  return {
    canonicalVacancyId: input.canonicalVacancyId,
    externalId: input.externalId,
    idempotencyKey: input.idempotencyKey,
    receiptId: receipt.id,
    status: "skipped",
  };
};

const processCanonicalVacancyExport = async (
  canonicalVacancyId: string,
  deps: CommitExportDeps,
  approvedApproval: { readonly id: string },
  boundSnapshot: { readonly id: string }
): Promise<
  | { readonly item: CommitExportItemResult; readonly ok: true }
  | { readonly error: CommitExportFailure; readonly ok: false }
> => {
  const idempotencyKey = buildExportIdempotencyKey(
    EXPORT_TARGET_SPOTT,
    canonicalVacancyId,
    EXPORT_ACTION_CREATE
  );

  const existingCrosswalk = await deps.stores.externalCrosswalk.get({
    actionType: EXPORT_ACTION_CREATE,
    canonicalVacancyId,
    scopeId: deps.scopeId,
    target: EXPORT_TARGET_SPOTT,
  });

  if (existingCrosswalk) {
    return {
      item: await recordSkippedExport({
        approvalId: approvedApproval.id,
        canonicalVacancyId,
        deps,
        externalId: existingCrosswalk.externalId,
        idempotencyKey,
        snapshotId: boundSnapshot.id,
      }),
      ok: true,
    };
  }

  const aanvraag = await deps.stores.aanvragen.getById(canonicalVacancyId);
  if (!aanvraag) {
    return {
      error: {
        code: "NOT_FOUND",
        message: `Approved aanvraag not found: ${canonicalVacancyId}`,
      },
      ok: false,
    };
  }

  const effectKey = {
    actionType: EXPORT_ACTION_CREATE,
    canonicalVacancyId,
    scopeId: deps.scopeId,
    target: EXPORT_TARGET_SPOTT,
  } as const;
  const reservation = await deps.stores.exportEffects.reserve(effectKey);
  if (!reservation.acquired && reservation.effect.status === "confirmed") {
    const completedCrosswalk =
      await deps.stores.externalCrosswalk.get(effectKey);
    if (!completedCrosswalk) {
      throw new Error(
        "Confirmed export effect is missing its atomic external ID crosswalk"
      );
    }
    return {
      item: await recordSkippedExport({
        approvalId: approvedApproval.id,
        canonicalVacancyId,
        deps,
        externalId: completedCrosswalk.externalId,
        idempotencyKey,
        snapshotId: boundSnapshot.id,
      }),
      ok: true,
    };
  }
  let { externalId } = reservation.effect;

  if (reservation.acquired) {
    let createResponse;
    try {
      createResponse = await deps.spottWriteClient.createVacancy(
        mapAanvraagToSpottCreateRequest(aanvraag)
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Spott create vacancy failed";
      return {
        item: await recordFailedExport({
          approvalId: approvedApproval.id,
          canonicalVacancyId,
          deps,
          errorMessage: message,
          externalId: null,
          idempotencyKey,
          responseHash: await hashExportReceiptSource({ error: message }),
          snapshotId: boundSnapshot.id,
        }),
        ok: true,
      };
    }

    const parsedCreateResponse =
      spottCreateResponseSchema.safeParse(createResponse);
    if (!parsedCreateResponse.success) {
      const message =
        "Spott create returned no external ID; manual reconciliation required";
      return {
        item: await recordFailedExport({
          approvalId: approvedApproval.id,
          canonicalVacancyId,
          deps,
          errorMessage: message,
          externalId: null,
          idempotencyKey,
          responseHash: await hashExportReceiptSource(createResponse),
          snapshotId: boundSnapshot.id,
        }),
        ok: true,
      };
    }

    const { externalId: durableExternalId } =
      await deps.stores.exportEffects.recordExternalId({
        ...effectKey,
        externalId: parsedCreateResponse.data.id,
        source: "provider_response",
      });
    externalId = durableExternalId;
  }

  if (!externalId) {
    const message =
      "Export effect is reserved and its outcome is pending or uncertain; no new create is permitted. Retry readback after an ID is recorded, or follow manual reconciliation.";
    return {
      item: await recordFailedExport({
        approvalId: approvedApproval.id,
        canonicalVacancyId,
        deps,
        errorMessage: message,
        externalId: null,
        idempotencyKey,
        responseHash: await hashExportReceiptSource({ error: message }),
        snapshotId: boundSnapshot.id,
      }),
      ok: true,
    };
  }

  const confirmation = await confirmSpottCreateEffect(deps.spottWriteClient, {
    id: externalId,
  });

  if (!confirmation.confirmedEffect) {
    return {
      item: await recordFailedExport({
        approvalId: approvedApproval.id,
        canonicalVacancyId,
        deps,
        errorMessage:
          confirmation.errorMessage ??
          "Spott vacancy could not be confirmed after create",
        externalId,
        idempotencyKey,
        responseHash: confirmation.responseHash,
        snapshotId: boundSnapshot.id,
      }),
      ok: true,
    };
  }

  const finalized = await deps.stores.exportEffects.finalizeConfirmed({
    ...effectKey,
    approvalId: approvedApproval.id,
    externalId,
    idempotencyKey,
    responseHash: confirmation.responseHash,
    snapshotId: boundSnapshot.id,
  });

  if (!finalized.created) {
    return {
      item: await recordSkippedExport({
        approvalId: approvedApproval.id,
        canonicalVacancyId,
        deps,
        externalId: finalized.externalId,
        idempotencyKey,
        snapshotId: boundSnapshot.id,
      }),
      ok: true,
    };
  }

  return {
    item: {
      canonicalVacancyId,
      externalId: finalized.externalId,
      idempotencyKey,
      receiptId: finalized.receipt.id,
      status: "created",
    },
    ok: true,
  };
};

export const commitExport = async (
  input: { readonly snapshotId: string },
  deps: CommitExportDeps
): Promise<
  | { readonly ok: true; readonly value: CommitExportSuccess }
  | { readonly error: CommitExportFailure; readonly ok: false }
> => {
  const snapshot = await deps.stores.snapshots.getById(
    input.snapshotId,
    deps.scopeId
  );
  const approval = snapshot
    ? await deps.stores.approvals.getBySnapshotId(
        input.snapshotId,
        deps.scopeId
      )
    : null;

  const validation = validateSnapshotApproval({
    approval,
    scopeId: deps.scopeId,
    snapshot,
    snapshotId: input.snapshotId,
  });

  if (!validation.ok) {
    return {
      error: {
        code: validation.error.code,
        message: validation.error.message,
      },
      ok: false,
    };
  }

  if (!snapshot) {
    return {
      error: {
        code: "NOT_FOUND",
        message: "QuerySnapshot not found",
      },
      ok: false,
    };
  }

  const boundSnapshot = snapshot;
  const approvedApproval = validation.value;
  const results: CommitExportItemResult[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;

  /* oxlint-disable eslint/no-await-in-loop -- sequential export keeps crosswalk/idempotency checks deterministic */
  for (const canonicalVacancyId of boundSnapshot.resultIds) {
    const itemResult = await processCanonicalVacancyExport(
      canonicalVacancyId,
      deps,
      approvedApproval,
      boundSnapshot
    );
    if (!itemResult.ok) {
      return { error: itemResult.error, ok: false };
    }
    results.push(itemResult.item);
    if (itemResult.item.status === "created") {
      created += 1;
    } else if (itemResult.item.status === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return {
    ok: true,
    value: {
      approvalId: approvedApproval.id,
      results,
      snapshotId: boundSnapshot.id,
      summary: { created, failed, skipped },
    },
  };
};
