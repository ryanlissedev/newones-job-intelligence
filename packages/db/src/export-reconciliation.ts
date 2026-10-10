/* oxlint-disable anti-slop/no-unknown-parameters -- This database entry point is an I/O boundary that validates raw CLI input with the strict reconciliation schema before opening a transaction. */
import { validateSnapshotApproval } from "@ji/application/approval";
import {
  hashExportApprovalMotivation,
  hashOrderedExportResultIds,
  hashSpottExportReconciliationPlan,
  reconcileSpottExportInputSchema,
  requireSpottExportReconciliationPrincipal,
  SpottExportReconciliationError,
} from "@ji/application/export/reconciliation";
import type {
  ReconcileSpottExportInput,
  SpottExportReconciliationPlan,
  SpottExportReconciliationPrincipal,
  SpottExportReconciliationResult,
} from "@ji/application/export/reconciliation";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hasConflictingExportIdOwner } from "./export-id-ownership";
import type * as schema from "./schema";
import {
  approvalRecord,
  exportEffect,
  externalIdCrosswalk,
  querySnapshot,
} from "./schema";
import { appendPostgresAuditEvent } from "./user-write-stores";

export type ExportReconciliationDatabase = PostgresJsDatabase<typeof schema>;
export type ExportReconciliationTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type ExportReconciliationMode = "apply" | "dry-run";

export type ReconcileSpottExportAuthorize = (
  transaction: ExportReconciliationTransaction,
  mode: ExportReconciliationMode
) => Promise<SpottExportReconciliationPrincipal>;

export interface ReconcileSpottExportOptions {
  readonly expectedScopeId: string;
  readonly now?: () => Date;
}

const resultIdsSchema = z.array(z.string().uuid());

const fail = (
  code: ConstructorParameters<typeof SpottExportReconciliationError>[0],
  message: string
): never => {
  throw new SpottExportReconciliationError(code, message);
};

const authorizeReconciliation = async (
  authorize: ReconcileSpottExportAuthorize,
  transaction: ExportReconciliationTransaction,
  mode: ExportReconciliationMode
): Promise<SpottExportReconciliationPrincipal> => {
  const principal = await authorize(transaction, mode);
  requireSpottExportReconciliationPrincipal(principal);
  return principal;
};

type ReconciliationEffect = typeof exportEffect.$inferSelect;
type ReconciliationSnapshot = typeof querySnapshot.$inferSelect;
type ReconciliationApproval = typeof approvalRecord.$inferSelect;

interface ReconciliationState {
  readonly approval: ReconciliationApproval | undefined;
  readonly effect: ReconciliationEffect | undefined;
  readonly hasCanonicalCrosswalk: boolean;
  readonly hasExternalIdConflict: boolean;
  readonly snapshot: ReconciliationSnapshot | undefined;
}

interface ValidatedReconciliationState {
  readonly approval: ReconciliationApproval;
  readonly approvalResultIds: string[];
  readonly effect: ReconciliationEffect;
  readonly snapshot: ReconciliationSnapshot;
  readonly snapshotResultIds: string[];
}

const readReconciliationState = async (
  transaction: ExportReconciliationTransaction,
  input: ReconcileSpottExportInput,
  mode: ExportReconciliationMode
): Promise<ReconciliationState> => {
  const effectQuery = transaction
    .select()
    .from(exportEffect)
    .where(
      and(
        eq(exportEffect.scopeId, input.scopeId),
        eq(exportEffect.target, "spott"),
        eq(exportEffect.canonicalVacancyId, input.canonicalVacancyId),
        eq(exportEffect.actionType, "create")
      )
    )
    .limit(1);
  const snapshotQuery = transaction
    .select()
    .from(querySnapshot)
    .where(
      and(
        eq(querySnapshot.id, input.snapshotId),
        eq(querySnapshot.scopeId, input.scopeId)
      )
    )
    .limit(1);
  const approvalQuery = transaction
    .select()
    .from(approvalRecord)
    .where(
      and(
        eq(approvalRecord.id, input.approvalId),
        eq(approvalRecord.scopeId, input.scopeId)
      )
    )
    .limit(1);

  const effects =
    mode === "apply" ? await effectQuery.for("update") : await effectQuery;
  const snapshots =
    mode === "apply" ? await snapshotQuery.for("update") : await snapshotQuery;
  const approvals =
    mode === "apply" ? await approvalQuery.for("update") : await approvalQuery;
  const crosswalks = await transaction
    .select({ id: externalIdCrosswalk.id })
    .from(externalIdCrosswalk)
    .where(
      and(
        eq(externalIdCrosswalk.scopeId, input.scopeId),
        eq(externalIdCrosswalk.target, "spott"),
        eq(externalIdCrosswalk.canonicalVacancyId, input.canonicalVacancyId),
        eq(externalIdCrosswalk.actionType, "create")
      )
    )
    .limit(1);
  const hasExternalIdConflict = await hasConflictingExportIdOwner(transaction, {
    actionType: "create",
    canonicalVacancyId: input.canonicalVacancyId,
    externalId: input.externalId,
    scopeId: input.scopeId,
    target: "spott",
  });

  return {
    approval: approvals[0],
    effect: effects[0],
    hasCanonicalCrosswalk: crosswalks.length > 0,
    hasExternalIdConflict,
    snapshot: snapshots[0],
  };
};

const validateReconciliationState = (
  state: ReconciliationState,
  input: ReconcileSpottExportInput,
  now: Date
): ValidatedReconciliationState => {
  const { approval, effect, snapshot } = state;
  if (!effect) {
    return fail(
      "RESERVATION_NOT_FOUND",
      "The scoped export reservation does not exist"
    );
  }
  if (
    effect.status !== "reserved" ||
    effect.externalId !== null ||
    effect.externalIdSource !== null
  ) {
    return fail(
      "RESERVATION_NOT_RECONCILABLE",
      "The export reservation already has provider evidence or is confirmed"
    );
  }
  if (state.hasCanonicalCrosswalk) {
    return fail(
      "CROSSWALK_EXISTS",
      "An external ID crosswalk already exists for this export"
    );
  }
  if (state.hasExternalIdConflict) {
    return fail(
      "EXTERNAL_ID_CONFLICT",
      "The external ID is already bound to another scoped export"
    );
  }
  if (!snapshot) {
    return fail("SNAPSHOT_NOT_FOUND", "The scoped snapshot does not exist");
  }
  if (!approval) {
    return fail("APPROVAL_NOT_FOUND", "The scoped approval does not exist");
  }

  const snapshotResultIds = resultIdsSchema.safeParse(snapshot.resultIds);
  const approvalResultIds = resultIdsSchema.safeParse(approval.resultIds);
  if (!snapshotResultIds.success || !approvalResultIds.success) {
    return fail(
      "APPROVAL_MISMATCH",
      "The approval does not match the current snapshot and vacancy"
    );
  }
  const approvalValidation = validateSnapshotApproval({
    approval: {
      expiresAt: approval.expiresAt,
      id: approval.id,
      resultIds: approvalResultIds.data,
      scopeId: approval.scopeId,
      snapshotId: approval.snapshotId,
    },
    now,
    scopeId: input.scopeId,
    snapshot: {
      id: snapshot.id,
      resultIds: snapshotResultIds.data,
      scopeId: snapshot.scopeId,
    },
    snapshotId: input.snapshotId,
  });
  if (!approvalValidation.ok) {
    return fail(
      approvalValidation.error.code === "APPROVAL_EXPIRED"
        ? "APPROVAL_EXPIRED"
        : "APPROVAL_MISMATCH",
      approvalValidation.error.code === "APPROVAL_EXPIRED"
        ? "The approval has expired"
        : "The approval does not match the current snapshot and vacancy"
    );
  }
  if (!snapshotResultIds.data.includes(input.canonicalVacancyId)) {
    return fail(
      "APPROVAL_MISMATCH",
      "The approval does not include the requested vacancy"
    );
  }

  return {
    approval,
    approvalResultIds: approvalResultIds.data,
    effect,
    snapshot,
    snapshotResultIds: snapshotResultIds.data,
  };
};

const buildReconciliationPlan = async (
  state: ValidatedReconciliationState,
  input: ReconcileSpottExportInput,
  principal: SpottExportReconciliationPrincipal
): Promise<SpottExportReconciliationPlan> => {
  const resultIdsHash = await hashOrderedExportResultIds(
    state.snapshotResultIds
  );
  const motivationHash = await hashExportApprovalMotivation(
    state.approval.motivatie
  );

  return {
    actionType: "create",
    actorId: principal.actorId,
    actorType: principal.actorType,
    approval: {
      actorId: state.approval.actorId,
      createdAt: state.approval.createdAt.toISOString(),
      expiresAt: state.approval.expiresAt.toISOString(),
      id: state.approval.id,
      motivationHash,
      resultCount: state.approvalResultIds.length,
      resultIdsHash,
      snapshotId: state.approval.snapshotId,
    },
    authorizationRef: input.authorizationRef,
    canonicalVacancyId: input.canonicalVacancyId,
    effect: {
      createdAt: state.effect.createdAt.toISOString(),
      id: state.effect.id,
      status: "reserved",
      updatedAt: state.effect.updatedAt.toISOString(),
    },
    evidenceRef: input.evidenceRef,
    externalId: input.externalId,
    scopeId: input.scopeId,
    snapshot: {
      createdAt: state.snapshot.createdAt.toISOString(),
      id: state.snapshot.id,
      resultCount: state.snapshotResultIds.length,
      resultIdsHash,
    },
    target: "spott",
  };
};

const applyReconciliation = async (
  transaction: ExportReconciliationTransaction,
  state: ValidatedReconciliationState,
  input: ReconcileSpottExportInput,
  principal: SpottExportReconciliationPrincipal,
  plan: SpottExportReconciliationPlan,
  planHash: string
): Promise<SpottExportReconciliationResult> => {
  if (!input.planHash) {
    return fail(
      "PLAN_HASH_REQUIRED",
      "Apply requires the exact hash from a current dry run"
    );
  }
  if (input.planHash !== planHash) {
    return fail(
      "PLAN_HASH_MISMATCH",
      "The reconciliation plan changed; run dry-run again"
    );
  }

  const rows = await transaction
    .update(exportEffect)
    .set({
      externalId: input.externalId,
      externalIdSource: "manual_evidence",
      status: "external_id_acquired",
      updatedAt: new Date(),
    })
    .where(eq(exportEffect.id, state.effect.id))
    .returning({ id: exportEffect.id });
  if (rows.length !== 1) {
    throw new Error("Export reconciliation update did not affect one row");
  }
  const audit = await appendPostgresAuditEvent(transaction, {
    action: "reconcile_spott_export_id",
    actorId: principal.actorId,
    actorType: principal.actorType,
    auditClass: "effect",
    entityId: state.effect.id,
    entityType: "export_effect",
    metadata: {
      actionType: "create",
      approvalId: state.approval.id,
      authorizationRef: input.authorizationRef,
      canonicalVacancyId: input.canonicalVacancyId,
      evidenceRef: input.evidenceRef,
      externalId: input.externalId,
      planHash,
      snapshotId: state.snapshot.id,
      target: "spott",
    },
    scopeId: input.scopeId,
  });
  return {
    applied: true,
    auditEventId: audit.id,
    mode: "apply",
    plan,
    planHash,
  };
};

export const reconcileSpottExportId = async (
  database: ExportReconciliationDatabase,
  untrustedInput: unknown,
  authorize: ReconcileSpottExportAuthorize,
  options: ReconcileSpottExportOptions
): Promise<SpottExportReconciliationResult> => {
  const parsed = reconcileSpottExportInputSchema.safeParse(untrustedInput);
  if (!parsed.success) {
    return fail("INVALID_INPUT", "Export reconciliation input is invalid");
  }
  const input = parsed.data;
  if (input.scopeId !== options.expectedScopeId) {
    return fail(
      "SCOPE_MISMATCH",
      "Export reconciliation scope does not match this deployment"
    );
  }
  const mode: ExportReconciliationMode = input.apply ? "apply" : "dry-run";

  return await database.transaction(
    async (transaction): Promise<SpottExportReconciliationResult> => {
      const principal = await authorizeReconciliation(
        authorize,
        transaction,
        mode
      );
      const state = await readReconciliationState(transaction, input, mode);
      const now = options.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) {
        return fail("INVALID_INPUT", "Export reconciliation clock is invalid");
      }
      const validatedState = validateReconciliationState(state, input, now);
      const plan = await buildReconciliationPlan(
        validatedState,
        input,
        principal
      );
      const planHash = await hashSpottExportReconciliationPlan(plan);
      if (mode === "dry-run") {
        return { applied: false, mode, plan, planHash };
      }
      return await applyReconciliation(
        transaction,
        validatedState,
        input,
        principal,
        plan,
        planHash
      );
    },
    input.apply
      ? { isolationLevel: "serializable" }
      : { accessMode: "read only", isolationLevel: "repeatable read" }
  );
};
