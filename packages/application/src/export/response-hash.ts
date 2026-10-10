import type { SpottCreateVacancyResponse } from "./spott/types";

export interface ExportErrorHashSource {
  readonly error: string;
}

export interface ExportSkipHashSource {
  readonly externalId: string;
  readonly idempotencyKey: string;
  readonly status: "skipped";
}

export type ExportReceiptHashSource =
  | ExportErrorHashSource
  | ExportSkipHashSource
  | SpottCreateVacancyResponse;

export const hashExportReceiptSource = async (
  source: ExportReceiptHashSource
): Promise<string> => {
  const encoded = new TextEncoder().encode(JSON.stringify(source));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
