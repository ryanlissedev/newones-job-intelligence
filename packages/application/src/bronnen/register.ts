import type { RunFailureEnvelope } from "@ji/connectors";
import type { BronConfig, BronConfigValidationIssue, BronId } from "@ji/domain";
import {
  activateBron as validateActivation,
  shouldScheduleBronPoll,
  validateBronConfig,
} from "@ji/domain";

export type BronLastRunSummary = {
  scrapeRunId: string;
  status: string;
  gestart: Date;
  found: number;
  new: number;
  changed: number;
  rejected: number;
  error: number;
  closed: number;
  geindigd: Date | null;
  failure: RunFailureEnvelope | null;
} | null;

export interface BronPersistence {
  create: (record: BronRegisterRecord) => Promise<BronRegisterRecord>;
  findById: (bronId: BronId) => Promise<BronRegisterRecord | null>;
  list: () => Promise<BronRegisterRecord[]>;
  /** Atomically validates and persists the ready/active transition. */
  activate: (
    input: ActivateBronPersistenceInput
  ) => Promise<BronRegisterRecord>;
}

export interface ActivateBronPersistenceInput {
  bronId: BronId;
  testImportRunId: string;
  minimumTestImportObservations?: number;
}

const OPAQUE_SECRET_REF = /^(?:op|vault|trigger):\/\/[^\s/]+(?:\/[^\s]*)?$/u;

export const validateSecretRef = (secretRef: string | null): string[] => {
  if (secretRef === null || secretRef.trim() === "") {
    return [];
  }
  if (!OPAQUE_SECRET_REF.test(secretRef)) {
    return [
      "secretRef must be an opaque op://, vault://, or trigger:// reference",
    ];
  }
  return [];
};

export type BronRegisterRecord = BronConfig & {
  actief: boolean;
  categorie: string;
  lastRun: BronLastRunSummary;
  retentionDays: number;
};

export interface PublicBronView {
  bronId: BronId;
  naam: string;
  method: BronConfig["method"];
  interval: string;
  rateLimitPerMinute: number;
  crawlDelayMs: number;
  status: BronConfig["status"];
  voorwaardenStatus: BronConfig["voorwaardenStatus"];
  mappingRef: string | null;
  loginVereist: boolean;
  retentionDays: number;
  hasSecretRef: boolean;
  actief: boolean;
  lastRun: BronLastRunSummary;
}

export const toPublicBronView = (
  record: BronRegisterRecord
): PublicBronView => ({
  actief: record.actief,
  bronId: record.bronId,
  crawlDelayMs: record.crawlDelayMs,
  hasSecretRef: Boolean(record.secretRef?.trim()),
  interval: record.interval,
  lastRun: record.lastRun,
  loginVereist: record.loginVereist,
  mappingRef: record.mappingRef,
  method: record.method,
  naam: record.naam,
  rateLimitPerMinute: record.rateLimitPerMinute,
  retentionDays: record.retentionDays,
  status: record.status,
  voorwaardenStatus: record.voorwaardenStatus,
});

export type CreateBronInput = Omit<BronConfig, "bronId"> & {
  bronId?: BronId;
  categorie?: string;
  retentionDays?: number;
};

export type CreateBronResult =
  | { ok: true; record: BronRegisterRecord }
  | { ok: false; issues: CreateBronValidationIssue[] };

export type CreateBronValidationIssue =
  | BronConfigValidationIssue
  | { field: "retentionDays"; message: string };

export const createBron = (input: CreateBronInput): CreateBronResult => {
  const bronId = input.bronId ?? crypto.randomUUID();
  const secretRef = input.secretRef?.trim() || null;
  const record: BronRegisterRecord = {
    actief: false,
    bronId,
    categorie: input.categorie ?? "overig",
    crawlDelayMs: input.crawlDelayMs,
    interval: input.interval,
    lastRun: null,
    loginVereist: input.loginVereist,
    mappingRef: input.mappingRef,
    method: input.method,
    naam: input.naam,
    rateLimitPerMinute: input.rateLimitPerMinute,
    retentionDays: input.retentionDays ?? 90,
    secretRef,
    status: input.status,
    voorwaardenStatus: input.voorwaardenStatus,
  };

  const issues: CreateBronValidationIssue[] = validateBronConfig(record);
  for (const message of validateSecretRef(record.secretRef)) {
    issues.push({ field: "secretRef", message });
  }
  if (!Number.isInteger(record.retentionDays) || record.retentionDays <= 0) {
    issues.push({
      field: "retentionDays",
      message: "retentionDays must be a positive integer",
    });
  }
  if (issues.length > 0) {
    return { issues, ok: false };
  }

  return { ok: true, record };
};

export type ActivateBronRegisterResult =
  | { ok: true; record: BronRegisterRecord }
  | { ok: false; reason: string };

export const activateBron = async (
  persistence: BronPersistence,
  input: {
    bronId: BronId;
    testImportRunId: string;
    minimumTestImportObservations?: number;
  }
): Promise<ActivateBronRegisterResult> => {
  const record = await persistence.findById(input.bronId);
  if (!record) {
    return { ok: false, reason: "bron not found" };
  }
  const activation = validateActivation({
    config: record,
    testImportPassed: true,
  });
  if (!activation.ok) {
    return activation;
  }
  return {
    ok: true,
    record: await persistence.activate({
      bronId: input.bronId,
      minimumTestImportObservations: input.minimumTestImportObservations,
      testImportRunId: input.testImportRunId,
    }),
  };
};

export const mapPublicBronnen = (
  records: BronRegisterRecord[]
): PublicBronView[] => records.map(toPublicBronView);

export const listPublicBronnen = async (
  persistence: BronPersistence
): Promise<PublicBronView[]> => mapPublicBronnen(await persistence.list());

export const isPollableBron = (record: BronRegisterRecord): boolean =>
  record.actief && shouldScheduleBronPoll(record);
