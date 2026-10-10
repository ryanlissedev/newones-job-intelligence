/* oxlint-disable max-classes-per-file -- cohesive Postgres adapters share schema mapping */
import type {
  ExportActionType,
  ExportEffectKey,
  ExportEffectRecord,
  ExportEffectStatus,
  ExportEffectStore,
  ExportExternalIdSource,
  ExportAttemptRecord,
  ExportAttemptStore,
  ExportAttemptStatus,
  ExportTarget,
  ExternalIdCrosswalkRecord,
  ExternalIdCrosswalkStore,
  ExternalReceiptRecord,
  ExternalReceiptStore,
  FinalizeConfirmedExportResult,
} from "@ji/application/registry";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

import { assertExportIdOwnerAvailable } from "./export-id-ownership";
import type * as schema from "./schema";
import {
  exportAttempt,
  exportEffect,
  externalIdCrosswalk,
  externalReceipt,
} from "./schema";

export type ExportDatabase = PostgresJsDatabase<typeof schema>;
type ExportTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type ExportExecutor = ExportDatabase | ExportTransaction;

const parseExportTarget = (value: string): ExportTarget => {
  if (value === "spott") {
    return value;
  }
  throw new Error(`Unsupported export target: ${value}`);
};

const parseExportActionType = (value: string): ExportActionType => {
  if (value === "create") {
    return value;
  }
  throw new Error(`Unsupported export action type: ${value}`);
};

const parseExportAttemptStatus = (value: string): ExportAttemptStatus => {
  if (value === "created" || value === "failed" || value === "skipped") {
    return value;
  }
  throw new Error(`Unsupported export attempt status: ${value}`);
};

const parseExportEffectStatus = (value: string): ExportEffectStatus => {
  if (
    value === "reserved" ||
    value === "external_id_acquired" ||
    value === "confirmed"
  ) {
    return value;
  }
  throw new Error(`Unsupported export effect status: ${value}`);
};

const parseExternalIdSource = (
  value: string | null
): ExportExternalIdSource | null => {
  if (
    value === null ||
    value === "manual_evidence" ||
    value === "provider_response"
  ) {
    return value;
  }
  throw new Error(`Unsupported external ID source: ${value}`);
};

const requireRow = <Row>(rows: Row[], description: string): Row => {
  const [row] = rows;
  if (!row) {
    throw new Error(`Unable to ${description}`);
  }
  return row;
};

const requireExternalId = (externalId: string): string => {
  const value = externalId.trim();
  if (!value) {
    throw new Error("Export effect external ID must not be empty");
  }
  return value;
};

const requireResponseHash = (responseHash: string): string => {
  if (!responseHash.trim()) {
    throw new Error("Export effect response hash must not be empty");
  }
  return responseHash;
};

const effectWhere = (key: ExportEffectKey) =>
  and(
    eq(exportEffect.scopeId, key.scopeId),
    eq(exportEffect.target, key.target),
    eq(exportEffect.canonicalVacancyId, key.canonicalVacancyId),
    eq(exportEffect.actionType, key.actionType)
  );

const toExportEffectRecord = (
  row: typeof exportEffect.$inferSelect
): ExportEffectRecord => ({
  actionType: parseExportActionType(row.actionType),
  canonicalVacancyId: row.canonicalVacancyId,
  createdAt: row.createdAt,
  externalId: row.externalId,
  externalIdSource: parseExternalIdSource(row.externalIdSource),
  scopeId: row.scopeId,
  status: parseExportEffectStatus(row.status),
  target: parseExportTarget(row.target),
  updatedAt: row.updatedAt,
});

const toExternalIdCrosswalkRecord = (
  row: typeof externalIdCrosswalk.$inferSelect
): ExternalIdCrosswalkRecord => ({
  actionType: parseExportActionType(row.actionType),
  canonicalVacancyId: row.canonicalVacancyId,
  createdAt: row.createdAt,
  externalId: row.externalId,
  scopeId: row.scopeId,
  target: parseExportTarget(row.target),
});

const toExportAttemptRecord = (
  row: typeof exportAttempt.$inferSelect
): ExportAttemptRecord => ({
  actionType: parseExportActionType(row.actionType),
  approvalId: row.approvalId,
  canonicalVacancyId: row.canonicalVacancyId,
  createdAt: row.createdAt,
  errorMessage: row.errorMessage,
  externalId: row.externalId,
  id: row.id,
  idempotencyKey: row.idempotencyKey,
  scopeId: row.scopeId,
  snapshotId: row.snapshotId,
  status: parseExportAttemptStatus(row.status),
  target: parseExportTarget(row.target),
});

const toExternalReceiptRecord = (
  row: typeof externalReceipt.$inferSelect
): ExternalReceiptRecord => ({
  canonicalVacancyId: row.canonicalVacancyId,
  confirmedEffect: row.confirmedEffect,
  createdAt: row.createdAt,
  exportAttemptId: row.exportAttemptId,
  id: row.id,
  responseHash: row.responseHash,
  scopeId: row.scopeId,
  spottVacancyId: row.spottVacancyId,
});

const insertCrosswalk = async (
  executor: ExportTransaction,
  record: Omit<ExternalIdCrosswalkRecord, "createdAt">
): Promise<ExternalIdCrosswalkRecord> => {
  await assertExportIdOwnerAvailable(executor, record);
  const inserted = await executor
    .insert(externalIdCrosswalk)
    .values(record)
    .onConflictDoNothing({
      target: [
        externalIdCrosswalk.scopeId,
        externalIdCrosswalk.target,
        externalIdCrosswalk.canonicalVacancyId,
        externalIdCrosswalk.actionType,
      ],
    })
    .returning();
  const [row] = inserted;
  if (row) {
    return toExternalIdCrosswalkRecord(row);
  }

  const [existing] = await executor
    .select()
    .from(externalIdCrosswalk)
    .where(
      and(
        eq(externalIdCrosswalk.scopeId, record.scopeId),
        eq(externalIdCrosswalk.target, record.target),
        eq(externalIdCrosswalk.canonicalVacancyId, record.canonicalVacancyId),
        eq(externalIdCrosswalk.actionType, record.actionType)
      )
    )
    .limit(1);
  if (!existing || existing.externalId !== record.externalId) {
    throw new Error("External ID crosswalk conflicts with export effect");
  }
  return toExternalIdCrosswalkRecord(existing);
};

const insertAttempt = async (
  executor: ExportExecutor,
  record: Omit<ExportAttemptRecord, "createdAt" | "id">
): Promise<ExportAttemptRecord> => {
  const rows = await executor.insert(exportAttempt).values(record).returning();
  return toExportAttemptRecord(requireRow(rows, "create export attempt"));
};

const insertReceipt = async (
  executor: ExportExecutor,
  record: Omit<ExternalReceiptRecord, "createdAt" | "id">
): Promise<ExternalReceiptRecord> => {
  const rows = await executor
    .insert(externalReceipt)
    .values(record)
    .returning();
  return toExternalReceiptRecord(requireRow(rows, "create external receipt"));
};

export class PostgresExportEffectStore implements ExportEffectStore {
  private readonly database: ExportDatabase;

  constructor(database: ExportDatabase) {
    this.database = database;
  }

  async reserve(key: ExportEffectKey): Promise<{
    readonly acquired: boolean;
    readonly effect: ExportEffectRecord;
  }> {
    const rows = await this.database
      .insert(exportEffect)
      .values(key)
      .onConflictDoNothing({
        target: [
          exportEffect.scopeId,
          exportEffect.target,
          exportEffect.canonicalVacancyId,
          exportEffect.actionType,
        ],
      })
      .returning();
    const [inserted] = rows;
    if (inserted) {
      return { acquired: true, effect: toExportEffectRecord(inserted) };
    }

    const [existing] = await this.database
      .select()
      .from(exportEffect)
      .where(effectWhere(key))
      .limit(1);
    if (!existing) {
      throw new Error("Export effect reservation conflict could not be read");
    }
    return { acquired: false, effect: toExportEffectRecord(existing) };
  }

  recordExternalId(
    input: ExportEffectKey & {
      readonly externalId: string;
      readonly source: ExportExternalIdSource;
    }
  ): Promise<ExportEffectRecord> {
    const externalId = requireExternalId(input.externalId);
    return this.database.transaction(
      async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(exportEffect)
          .where(effectWhere(input))
          .limit(1)
          .for("update");
        if (!existing) {
          throw new Error("Export effect reservation not found");
        }
        if (existing.externalId && existing.externalId !== externalId) {
          throw new Error("Export effect already has a different external ID");
        }
        if (existing.status === "confirmed") {
          return toExportEffectRecord(existing);
        }

        await assertExportIdOwnerAvailable(transaction, {
          ...input,
          externalId,
        });

        const rows = await transaction
          .update(exportEffect)
          .set({
            externalId,
            externalIdSource: existing.externalIdSource ?? input.source,
            status: "external_id_acquired",
            updatedAt: new Date(),
          })
          .where(effectWhere(input))
          .returning();
        return toExportEffectRecord(
          requireRow(rows, "record export effect external ID")
        );
      },
      { isolationLevel: "serializable" }
    );
  }

  async finalizeConfirmed(
    input: ExportEffectKey & {
      readonly approvalId: string;
      readonly externalId: string;
      readonly idempotencyKey: string;
      readonly responseHash: string;
      readonly snapshotId: string;
    }
  ): Promise<FinalizeConfirmedExportResult> {
    const externalId = requireExternalId(input.externalId);
    const responseHash = requireResponseHash(input.responseHash);
    const result =
      await this.database.transaction<FinalizeConfirmedExportResult>(
        async (transaction) => {
          const [existing] = await transaction
            .select()
            .from(exportEffect)
            .where(effectWhere(input))
            .limit(1)
            .for("update");
          if (!existing?.externalId) {
            throw new Error("Export effect has no durable external ID");
          }
          if (existing.externalId !== externalId) {
            throw new Error(
              "Export effect external ID does not match confirmation"
            );
          }
          if (existing.status === "confirmed") {
            return { created: false, externalId };
          }

          await insertCrosswalk(transaction, {
            actionType: input.actionType,
            canonicalVacancyId: input.canonicalVacancyId,
            externalId,
            scopeId: input.scopeId,
            target: input.target,
          });
          const attempt = await insertAttempt(transaction, {
            actionType: input.actionType,
            approvalId: input.approvalId,
            canonicalVacancyId: input.canonicalVacancyId,
            errorMessage: null,
            externalId,
            idempotencyKey: input.idempotencyKey,
            scopeId: input.scopeId,
            snapshotId: input.snapshotId,
            status: "created",
            target: input.target,
          });
          const receipt = await insertReceipt(transaction, {
            canonicalVacancyId: input.canonicalVacancyId,
            confirmedEffect: true,
            exportAttemptId: attempt.id,
            responseHash,
            scopeId: input.scopeId,
            spottVacancyId: externalId,
          });
          await transaction
            .update(exportEffect)
            .set({ status: "confirmed", updatedAt: new Date() })
            .where(effectWhere(input));
          return { attempt, created: true, externalId, receipt };
        },
        { isolationLevel: "serializable" }
      );
    return result;
  }
}

export class PostgresExternalIdCrosswalkStore implements ExternalIdCrosswalkStore {
  private readonly database: ExportDatabase;

  constructor(database: ExportDatabase) {
    this.database = database;
  }

  async get(input: {
    actionType: ExportActionType;
    canonicalVacancyId: string;
    scopeId: string;
    target: ExportTarget;
  }): Promise<ExternalIdCrosswalkRecord | null> {
    const row = await this.database.query.externalIdCrosswalk.findFirst({
      where: and(
        eq(externalIdCrosswalk.target, input.target),
        eq(externalIdCrosswalk.canonicalVacancyId, input.canonicalVacancyId),
        eq(externalIdCrosswalk.actionType, input.actionType),
        eq(externalIdCrosswalk.scopeId, input.scopeId)
      ),
    });
    return row ? toExternalIdCrosswalkRecord(row) : null;
  }

  create(
    record: Omit<ExternalIdCrosswalkRecord, "createdAt">
  ): Promise<ExternalIdCrosswalkRecord> {
    return this.database.transaction(
      (transaction) => insertCrosswalk(transaction, record),
      { isolationLevel: "serializable" }
    );
  }
}

export class PostgresExportAttemptStore implements ExportAttemptStore {
  private readonly database: ExportDatabase;

  constructor(database: ExportDatabase) {
    this.database = database;
  }

  create(
    record: Omit<ExportAttemptRecord, "createdAt" | "id">
  ): Promise<ExportAttemptRecord> {
    return insertAttempt(this.database, record);
  }

  async listBySnapshotId(snapshotId: string, scopeId: string) {
    const rows = await this.database.query.exportAttempt.findMany({
      where: and(
        eq(exportAttempt.snapshotId, snapshotId),
        eq(exportAttempt.scopeId, scopeId)
      ),
    });
    return rows.map(toExportAttemptRecord);
  }
}

export class PostgresExternalReceiptStore implements ExternalReceiptStore {
  private readonly database: ExportDatabase;

  constructor(database: ExportDatabase) {
    this.database = database;
  }

  create(
    record: Omit<ExternalReceiptRecord, "createdAt" | "id">
  ): Promise<ExternalReceiptRecord> {
    return insertReceipt(this.database, record);
  }

  async getByExportAttemptId(
    exportAttemptId: string,
    scopeId: string
  ): Promise<ExternalReceiptRecord | null> {
    const row = await this.database.query.externalReceipt.findFirst({
      where: and(
        eq(externalReceipt.exportAttemptId, exportAttemptId),
        eq(externalReceipt.scopeId, scopeId)
      ),
    });
    return row ? toExternalReceiptRecord(row) : null;
  }

  async listByCanonicalVacancyId(
    canonicalVacancyId: string,
    scopeId: string
  ): Promise<readonly ExternalReceiptRecord[]> {
    const rows = await this.database.query.externalReceipt.findMany({
      where: and(
        eq(externalReceipt.canonicalVacancyId, canonicalVacancyId),
        eq(externalReceipt.scopeId, scopeId)
      ),
    });
    return rows.map(toExternalReceiptRecord);
  }
}
