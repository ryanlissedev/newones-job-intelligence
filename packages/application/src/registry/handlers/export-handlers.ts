import { Schema } from "effect";

import { commitExport } from "../../export/commit-export";
import type { SchemaType } from "../schema-helpers";
import {
  NonNegativeInteger,
  toCapabilitySchema,
  UuidString,
} from "../schema-helpers";
import type { SliceAHandlerDeps } from "./deps";

type ExportEnabledDeps = Pick<SliceAHandlerDeps, "spottWriteClient"> & {
  readonly spottWriteClient: NonNullable<SliceAHandlerDeps["spottWriteClient"]>;
};

export const isExportEnabled = (
  deps: Pick<SliceAHandlerDeps, "spottWriteClient">
): deps is ExportEnabledDeps =>
  deps.spottWriteClient !== undefined && deps.spottWriteClient !== null;

export const commitExportInputSchema = toCapabilitySchema(
  Schema.Struct({
    snapshotId: UuidString,
  })
);

const commitExportItem = Schema.Struct({
  canonicalVacancyId: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  idempotencyKey: Schema.String,
  receiptId: Schema.String,
  status: Schema.Literals(["created", "failed", "skipped"]),
});

export const commitExportItemSchema = toCapabilitySchema(commitExportItem);

export const commitExportOutputSchema = toCapabilitySchema(
  Schema.Struct({
    approvalId: Schema.String,
    auditEventId: Schema.String,
    results: Schema.Array(commitExportItem),
    snapshotId: Schema.String,
    summary: Schema.Struct({
      created: NonNegativeInteger,
      failed: NonNegativeInteger,
      skipped: NonNegativeInteger,
    }),
  })
);

export const createCommitExportHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof commitExportInputSchema>,
    context: {
      principal: {
        kind: "agent" | "service" | "user";
        subjectId: string;
      };
    }
  ) => {
    if (!isExportEnabled(deps)) {
      return {
        error: {
          code: "EXPORT_DISABLED" as const,
          details: { id: input.snapshotId },
          message:
            "Export is disabled because no Spott write client is configured",
        },
        ok: false as const,
      };
    }
    const { spottWriteClient } = deps;

    const result = await commitExport(
      { snapshotId: input.snapshotId },
      {
        scopeId: deps.scopeId,
        spottWriteClient,
        stores: deps.stores,
      }
    );

    if (!result.ok) {
      return {
        error: {
          code: result.error.code,
          details: { id: input.snapshotId },
          message: result.error.message,
        },
        ok: false as const,
      };
    }

    const audit = await deps.stores.audit.append({
      action: "commit_export",
      actorId: context.principal.subjectId,
      actorType: context.principal.kind,
      auditClass: "effect",
      entityId: result.value.snapshotId,
      entityType: "query_snapshot",
      metadata: {
        approvalId: result.value.approvalId,
        created: result.value.summary.created,
        failed: result.value.summary.failed,
        skipped: result.value.summary.skipped,
        snapshotId: result.value.snapshotId,
      },
      scopeId: deps.scopeId,
    });

    return {
      ok: true as const,
      value: {
        approvalId: result.value.approvalId,
        auditEventId: audit.id,
        results: result.value.results.map((item) => ({ ...item })),
        snapshotId: result.value.snapshotId,
        summary: { ...result.value.summary },
      },
    };
  };

export const getExportStatusInputSchema = toCapabilitySchema(
  Schema.Struct({ snapshotId: UuidString })
);

const exportReadbackStatus = Schema.Literals([
  "no_attempt",
  "attempted",
  "confirmed",
  "failed",
  "unknown",
]);

type ExportReadbackStatus = typeof exportReadbackStatus.Type;

const attemptReadbackStatus = (
  attemptStatus: "created" | "failed" | "skipped",
  confirmedEffect: boolean | undefined
): ExportReadbackStatus => {
  if (confirmedEffect) {
    return "unknown";
  }
  if (attemptStatus === "failed") {
    return "failed";
  }
  return "attempted";
};

const aggregateReadbackStatus = (
  attempts: readonly { readonly status: ExportReadbackStatus }[]
): ExportReadbackStatus => {
  if (attempts.length === 0) {
    return "no_attempt";
  }
  if (attempts.some((attempt) => attempt.status === "unknown")) {
    return "unknown";
  }
  if (attempts.every((attempt) => attempt.status === "failed")) {
    return "failed";
  }
  return "attempted";
};

export const getExportStatusOutputSchema = toCapabilitySchema(
  Schema.Struct({
    attempts: Schema.Array(
      Schema.Struct({
        canonicalVacancyId: Schema.String,
        createdAt: Schema.String,
        errorMessage: Schema.NullOr(Schema.String),
        externalId: Schema.NullOr(Schema.String),
        id: Schema.String,
        idempotencyKey: Schema.String,
        receipt: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            responseHash: Schema.String,
          })
        ),
        status: exportReadbackStatus,
      })
    ),
    liveConfirmationAvailable: Schema.Literal(false),
    snapshotId: Schema.String,
    status: exportReadbackStatus,
  })
);

export const createGetExportStatusHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof getExportStatusInputSchema>,
    context: { principal: { subjectId: string } }
  ) => {
    const snapshot = await deps.stores.snapshots.getById(
      input.snapshotId,
      deps.scopeId
    );
    if (!snapshot || snapshot.userId !== context.principal.subjectId) {
      return {
        error: {
          code: "NOT_FOUND" as const,
          details: { id: input.snapshotId },
          message: "QuerySnapshot not found",
        },
        ok: false as const,
      };
    }
    const attempts = await deps.stores.exportAttempts.listBySnapshotId(
      snapshot.id,
      deps.scopeId
    );
    const views = await Promise.all(
      attempts.map(async (attempt) => {
        const receipt = await deps.stores.externalReceipts.getByExportAttemptId(
          attempt.id,
          deps.scopeId
        );
        const status = attemptReadbackStatus(
          attempt.status,
          receipt?.confirmedEffect
        );
        return {
          canonicalVacancyId: attempt.canonicalVacancyId,
          createdAt: attempt.createdAt.toISOString(),
          errorMessage: attempt.errorMessage,
          externalId: attempt.externalId,
          id: attempt.id,
          idempotencyKey: attempt.idempotencyKey,
          receipt: receipt
            ? {
                id: receipt.id,
                responseHash: receipt.responseHash,
              }
            : null,
          status,
        };
      })
    );
    const status = aggregateReadbackStatus(views);
    return {
      ok: true as const,
      value: {
        attempts: views,
        liveConfirmationAvailable: false as const,
        snapshotId: snapshot.id,
        status,
      },
    };
  };
