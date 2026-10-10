import type { ExportActionType, ExportTarget } from "@ji/application/registry";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, eq, ne } from "drizzle-orm";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { exportEffect, externalIdCrosswalk } from "./schema";

type ExportIdOwnershipTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface ExportIdOwnershipKey {
  readonly actionType: ExportActionType;
  readonly canonicalVacancyId: string;
  readonly externalId: string;
  readonly scopeId: string;
  readonly target: ExportTarget;
}

export const hasConflictingExportIdOwner = async (
  transaction: ExportIdOwnershipTransaction,
  input: ExportIdOwnershipKey
): Promise<boolean> => {
  // Every supported writer must read both predicates in the same SERIALIZABLE
  // transaction as its write. Do not short-circuit these reads or lower isolation.
  const reverseEffects = await transaction
    .select({ canonicalVacancyId: exportEffect.canonicalVacancyId })
    .from(exportEffect)
    .where(
      and(
        eq(exportEffect.scopeId, input.scopeId),
        eq(exportEffect.target, input.target),
        eq(exportEffect.actionType, input.actionType),
        eq(exportEffect.externalId, input.externalId),
        ne(exportEffect.canonicalVacancyId, input.canonicalVacancyId)
      )
    )
    .limit(1);
  const reverseCrosswalks = await transaction
    .select({ canonicalVacancyId: externalIdCrosswalk.canonicalVacancyId })
    .from(externalIdCrosswalk)
    .where(
      and(
        eq(externalIdCrosswalk.scopeId, input.scopeId),
        eq(externalIdCrosswalk.target, input.target),
        eq(externalIdCrosswalk.actionType, input.actionType),
        eq(externalIdCrosswalk.externalId, input.externalId),
        ne(externalIdCrosswalk.canonicalVacancyId, input.canonicalVacancyId)
      )
    )
    .limit(1);

  return reverseEffects.length > 0 || reverseCrosswalks.length > 0;
};

export const assertExportIdOwnerAvailable = async (
  transaction: ExportIdOwnershipTransaction,
  input: ExportIdOwnershipKey
): Promise<void> => {
  if (await hasConflictingExportIdOwner(transaction, input)) {
    throw new Error("External ID is already bound to another scoped export");
  }
};
