import type {
  ApprovalRecord,
  QuerySnapshotRecord,
} from "../registry/stores/types";

export type SnapshotApprovalFailureCode =
  | "APPROVAL_EXPIRED"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_NOT_FOUND"
  | "NOT_FOUND";

export interface SnapshotApprovalFailure {
  readonly code: SnapshotApprovalFailureCode;
  readonly message: string;
}

export interface SnapshotApprovalValidationInput {
  readonly approval: Pick<
    ApprovalRecord,
    "expiresAt" | "id" | "resultIds" | "scopeId" | "snapshotId"
  > | null;
  readonly now?: Date;
  readonly scopeId: string;
  readonly snapshot: Pick<
    QuerySnapshotRecord,
    "id" | "resultIds" | "scopeId"
  > | null;
  readonly snapshotId: string;
}

const resultIdsMatch = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  for (const [index, id] of left.entries()) {
    if (id !== right[index]) {
      return false;
    }
  }
  return true;
};

export const validateSnapshotApproval = (
  input: SnapshotApprovalValidationInput
):
  | {
      readonly ok: true;
      readonly value: NonNullable<SnapshotApprovalValidationInput["approval"]>;
    }
  | { readonly error: SnapshotApprovalFailure; readonly ok: false } => {
  const { approval, scopeId, snapshot, snapshotId } = input;
  const now = input.now ?? new Date();

  if (!snapshot || snapshot.scopeId !== scopeId) {
    return {
      error: {
        code: "NOT_FOUND",
        message: "QuerySnapshot not found",
      },
      ok: false,
    };
  }

  if (!approval || approval.scopeId !== scopeId) {
    return {
      error: {
        code: approval ? "NOT_FOUND" : "APPROVAL_NOT_FOUND",
        message: approval
          ? "Approval scope does not match this deployment"
          : "No approval exists for this snapshot",
      },
      ok: false,
    };
  }

  if (
    approval.snapshotId !== snapshotId ||
    approval.snapshotId !== snapshot.id
  ) {
    return {
      error: {
        code: "APPROVAL_MISMATCH",
        message: "Approval is bound to a different snapshot",
      },
      ok: false,
    };
  }

  if (!resultIdsMatch(approval.resultIds, snapshot.resultIds)) {
    return {
      error: {
        code: "APPROVAL_MISMATCH",
        message: "Approval result set does not match snapshot",
      },
      ok: false,
    };
  }

  if (approval.expiresAt.getTime() <= now.getTime()) {
    return {
      error: {
        code: "APPROVAL_EXPIRED",
        message: "Approval has expired",
      },
      ok: false,
    };
  }

  return { ok: true, value: approval };
};
