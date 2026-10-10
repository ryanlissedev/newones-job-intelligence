import {
  BRON_STATUSES,
  BronStatusSchema,
  VOORWAARDEN_STATUSES,
  VoorwaardenStatusSchema,
} from "./ids";
import type { BronId, BronStatus, VoorwaardenStatus } from "./ids";
import {
  BRON_NAAM_MAX_LENGTH,
  BronNaamSchema,
  DomainIdString,
  NonNegativeInteger,
  PositiveInteger,
  Schema,
} from "./schema-helpers";

/**
 * Bron configuration public schemas (ADR-0014 Slice 5 / CTP-470).
 *
 * Effect Schema is the SoT for shape + enums. Domain rules
 * (`validateBronConfig`, activation, scheduling) stay pure / Effect-free.
 */

export const CONNECTOR_METHODS = [
  "feed",
  "json-api",
  "json-ld",
  "html",
  "playwright",
] as const;

/** Effect Schema SoT for connector method. */
export const ConnectorMethodSchema = Schema.Literals(CONNECTOR_METHODS);

export type ConnectorMethod = typeof ConnectorMethodSchema.Type;

/** Effect Schema SoT for a bron configuration record. */
export const BronConfigSchema = Schema.Struct({
  bronId: DomainIdString,
  crawlDelayMs: NonNegativeInteger,
  interval: Schema.String,
  loginVereist: Schema.Boolean,
  mappingRef: Schema.NullOr(Schema.String),
  method: ConnectorMethodSchema,
  naam: BronNaamSchema,
  rateLimitPerMinute: PositiveInteger,
  secretRef: Schema.NullOr(Schema.String),
  status: BronStatusSchema,
  voorwaardenStatus: VoorwaardenStatusSchema,
});

export type BronConfig = typeof BronConfigSchema.Type;

export type BronConfigInput = Omit<BronConfig, "bronId"> & {
  bronId?: BronId;
};

export interface BronConfigValidationIssue {
  field: keyof BronConfig | "general";
  message: string;
}

export const requiresSecretRef = (
  config: Pick<BronConfig, "loginVereist" | "method">
): boolean => config.loginVereist || config.method === "playwright";

export const isConnectorMethod = (value: string): value is ConnectorMethod => {
  for (const method of CONNECTOR_METHODS) {
    if (method === value) {
      return true;
    }
  }
  return false;
};

export const isBronStatus = (value: string): value is BronStatus => {
  for (const status of BRON_STATUSES) {
    if (status === value) {
      return true;
    }
  }
  return false;
};

export const isVoorwaardenStatus = (
  value: string
): value is VoorwaardenStatus => {
  for (const status of VOORWAARDEN_STATUSES) {
    if (status === value) {
      return true;
    }
  }
  return false;
};

/**
 * Domain-rule validation (Effect-free). Complements {@link BronConfigSchema}
 * with messages and cross-field rules (secret_ref for login connectors).
 */
export const validateBronConfig = (
  input: BronConfigInput
): BronConfigValidationIssue[] => {
  const issues: BronConfigValidationIssue[] = [];

  if (!input.naam.trim()) {
    issues.push({ field: "naam", message: "naam is required" });
  } else if (input.naam.length > BRON_NAAM_MAX_LENGTH) {
    issues.push({
      field: "naam",
      message: `naam must be at most ${BRON_NAAM_MAX_LENGTH} characters`,
    });
  }

  if (!isConnectorMethod(input.method)) {
    issues.push({
      field: "method",
      message: `method must be one of ${CONNECTOR_METHODS.join(", ")}`,
    });
  }

  if (!input.interval.trim()) {
    issues.push({ field: "interval", message: "interval is required" });
  }

  if (
    !Number.isInteger(input.rateLimitPerMinute) ||
    input.rateLimitPerMinute < 1
  ) {
    issues.push({
      field: "rateLimitPerMinute",
      message: "rateLimitPerMinute must be a positive integer",
    });
  }

  if (!Number.isInteger(input.crawlDelayMs) || input.crawlDelayMs < 0) {
    issues.push({
      field: "crawlDelayMs",
      message: "crawlDelayMs must be a nonnegative integer",
    });
  }

  if (!isBronStatus(input.status)) {
    issues.push({
      field: "status",
      message: `status must be one of ${BRON_STATUSES.join(", ")}`,
    });
  }

  if (!isVoorwaardenStatus(input.voorwaardenStatus)) {
    issues.push({
      field: "voorwaardenStatus",
      message: `voorwaardenStatus must be one of ${VOORWAARDEN_STATUSES.join(", ")}`,
    });
  }

  if (requiresSecretRef(input) && !input.secretRef?.trim()) {
    issues.push({
      field: "secretRef",
      message: "secret_ref is required for login connectors",
    });
  }

  return issues;
};

export const canTransitionBronStatus = (
  current: BronStatus,
  next: BronStatus,
  voorwaardenStatus: VoorwaardenStatus
): boolean => {
  if (current === next) {
    return true;
  }

  if (next === "ready" && voorwaardenStatus === "verboden") {
    return false;
  }

  return true;
};

export const shouldScheduleBronPoll = (
  config: Pick<BronConfig, "status" | "voorwaardenStatus">
): boolean =>
  config.status === "ready" && config.voorwaardenStatus === "toegestaan";

export interface ActivateBronInput {
  config: BronConfig;
  testImportPassed: boolean;
}

export type ActivateBronResult =
  | { ok: true; status: "ready" }
  | { ok: false; reason: string };

export const activateBron = (input: ActivateBronInput): ActivateBronResult => {
  const validationIssues = validateBronConfig(input.config);
  if (validationIssues.length > 0) {
    return {
      ok: false,
      reason: validationIssues.map((issue) => issue.message).join("; "),
    };
  }

  if (!input.testImportPassed) {
    return {
      ok: false,
      reason: "test-import must pass before activation (JI-BRN-04)",
    };
  }

  if (input.config.voorwaardenStatus !== "toegestaan") {
    return {
      ok: false,
      reason: "voorwaarden_status must be toegestaan before activation",
    };
  }

  if (
    !canTransitionBronStatus(
      input.config.status,
      "ready",
      input.config.voorwaardenStatus
    )
  ) {
    return {
      ok: false,
      reason: "verboden bron cannot transition to ready",
    };
  }

  return { ok: true, status: "ready" };
};
