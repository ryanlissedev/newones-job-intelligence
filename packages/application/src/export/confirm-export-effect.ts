import { hashExportReceiptSource } from "./response-hash";
import type { SpottWriteClient } from "./spott/client";
import type { SpottCreateVacancyResponse } from "./spott/types";

export interface ConfirmSpottCreateEffectResult {
  readonly confirmedEffect: boolean;
  readonly errorMessage: string | null;
  readonly responseHash: string;
  readonly spottVacancyId: string | null;
}

export const confirmSpottCreateEffect = async (
  spottWriteClient: SpottWriteClient,
  createResponse: SpottCreateVacancyResponse
): Promise<ConfirmSpottCreateEffectResult> => {
  const responseHash = await hashExportReceiptSource(createResponse);

  try {
    const detail = await spottWriteClient.getVacancy(createResponse.id);
    if (detail.id !== createResponse.id) {
      return {
        confirmedEffect: false,
        errorMessage: `Confirmation mismatch: expected ${createResponse.id}, got ${detail.id}`,
        responseHash,
        spottVacancyId: createResponse.id,
      };
    }

    return {
      confirmedEffect: true,
      errorMessage: null,
      responseHash,
      spottVacancyId: createResponse.id,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Spott confirmation failed";
    return {
      confirmedEffect: false,
      errorMessage: message,
      responseHash,
      spottVacancyId: createResponse.id,
    };
  }
};

export const buildSkipReceiptPayload = (input: {
  readonly externalId: string;
  readonly idempotencyKey: string;
}) => ({
  externalId: input.externalId,
  idempotencyKey: input.idempotencyKey,
  status: "skipped" as const,
});
