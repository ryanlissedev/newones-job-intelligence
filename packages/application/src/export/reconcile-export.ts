import { z } from "zod";

import { PERM_EXPORT, ROLE_OPERATOR } from "../registry/roles";
import type { AuditActorType } from "../registry/stores/types";

// oxlint-disable-next-line no-control-regex -- This validator deliberately rejects ASCII control characters at the operator-input boundary.
const SAFE_REFERENCE_PATTERN = /^[^\u0000-\u001F\u007F]+$/u;
const REFERENCE_IDENTIFIER_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{0,94}$/u;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/u;

const boundedText = (name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .max(512, `${name} must not exceed 512 characters`)
    .regex(SAFE_REFERENCE_PATTERN, `${name} contains control characters`);

/** Short nonsecret pointer such as `linear:RJC-435` or `provider-case:123`. */
const referenceIdentifier = (name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .max(128, `${name} must not exceed 128 characters`)
    .regex(
      REFERENCE_IDENTIFIER_PATTERN,
      `${name} must be a namespaced identifier`
    )
    .refine((value) => !value.includes("://"), {
      message: `${name} must not be a URL`,
    });

export const reconcileSpottExportInputSchema = z
  .object({
    apply: z.boolean().default(false),
    approvalId: z.string().uuid(),
    authorizationRef: referenceIdentifier("authorizationRef"),
    canonicalVacancyId: z.string().uuid(),
    evidenceRef: referenceIdentifier("evidenceRef"),
    externalId: boundedText("externalId").max(
      256,
      "externalId must not exceed 256 characters"
    ),
    planHash: z.string().regex(PLAN_HASH_PATTERN).optional(),
    scopeId: boundedText("scopeId"),
    snapshotId: z.string().uuid(),
  })
  .strict();

export type ReconcileSpottExportInput = z.output<
  typeof reconcileSpottExportInputSchema
>;

export type SpottExportReconciliationErrorCode =
  | "APPROVAL_EXPIRED"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_NOT_FOUND"
  | "CROSSWALK_EXISTS"
  | "EXTERNAL_ID_CONFLICT"
  | "INVALID_INPUT"
  | "PLAN_HASH_MISMATCH"
  | "PLAN_HASH_REQUIRED"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_NOT_RECONCILABLE"
  | "SCOPE_MISMATCH"
  | "SNAPSHOT_NOT_FOUND"
  | "UNAUTHORIZED";

export class SpottExportReconciliationError extends Error {
  readonly code: SpottExportReconciliationErrorCode;

  constructor(code: SpottExportReconciliationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SpottExportReconciliationError";
  }
}

export interface SpottExportReconciliationPrincipal {
  readonly actorId: string;
  readonly actorType: AuditActorType;
  readonly permissions: ReadonlySet<string>;
}

export const requireSpottExportReconciliationPrincipal = (
  principal: SpottExportReconciliationPrincipal
): void => {
  if (
    !principal.actorId.trim() ||
    !principal.permissions.has(ROLE_OPERATOR) ||
    !principal.permissions.has(PERM_EXPORT)
  ) {
    throw new SpottExportReconciliationError(
      "UNAUTHORIZED",
      "An authenticated administrator is required for export reconciliation"
    );
  }
};

export interface SpottExportReconciliationPlan {
  readonly actionType: "create";
  readonly actorId: string;
  readonly actorType: AuditActorType;
  readonly approval: {
    readonly actorId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly id: string;
    readonly motivationHash: string;
    readonly resultCount: number;
    readonly resultIdsHash: string;
    readonly snapshotId: string;
  };
  readonly authorizationRef: string;
  readonly canonicalVacancyId: string;
  readonly effect: {
    readonly createdAt: string;
    readonly id: string;
    readonly status: "reserved";
    readonly updatedAt: string;
  };
  readonly evidenceRef: string;
  readonly externalId: string;
  readonly scopeId: string;
  readonly snapshot: {
    readonly createdAt: string;
    readonly id: string;
    readonly resultCount: number;
    readonly resultIdsHash: string;
  };
  readonly target: "spott";
}

type HashableReconciliationValue =
  | SpottExportReconciliationPlan
  | readonly string[]
  | string;

const hashJsonValue = async (
  value: HashableReconciliationValue
): Promise<string> => {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const hashOrderedExportResultIds = (
  resultIds: readonly string[]
): Promise<string> => hashJsonValue(resultIds);

export const hashExportApprovalMotivation = (
  motivation: string
): Promise<string> => hashJsonValue(motivation);

export const hashSpottExportReconciliationPlan = (
  plan: SpottExportReconciliationPlan
): Promise<string> => hashJsonValue(plan);

export type SpottExportReconciliationResult =
  | {
      readonly applied: false;
      readonly mode: "dry-run";
      readonly plan: SpottExportReconciliationPlan;
      readonly planHash: string;
    }
  | {
      readonly applied: true;
      readonly auditEventId: string;
      readonly mode: "apply";
      readonly plan: SpottExportReconciliationPlan;
      readonly planHash: string;
    };
