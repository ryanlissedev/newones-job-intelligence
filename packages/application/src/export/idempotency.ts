export const EXPORT_TARGET_SPOTT = "spott" as const;

export const EXPORT_ACTION_CREATE = "create" as const;

export type ExportTarget = typeof EXPORT_TARGET_SPOTT;

export type ExportActionType = typeof EXPORT_ACTION_CREATE;

export const buildExportIdempotencyKey = (
  target: ExportTarget,
  canonicalVacancyId: string,
  actionType: ExportActionType
): string => `${target}:${canonicalVacancyId}:${actionType}`;
