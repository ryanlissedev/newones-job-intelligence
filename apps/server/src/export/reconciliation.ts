import {
  reconcileSpottExportInputSchema,
  SpottExportReconciliationError,
} from "@ji/application/export/reconciliation";
import type { SpottExportReconciliationPrincipal } from "@ji/application/export/reconciliation";
import { permissionsForRole, ROLE_ADMIN } from "@ji/application/registry";
import type { SliceARole } from "@ji/application/registry";
import { z } from "zod";

import { CATAPULZE_DEPLOYMENT_SCOPE_ID } from "../deployment-scope";

export const RECONCILIATION_SCOPE_ID = CATAPULZE_DEPLOYMENT_SCOPE_ID;
export const RECONCILIATION_BEARER_ENV =
  "SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN" as const;

const valueFlags = {
  "--approval-id": "approvalId",
  "--authorization-ref": "authorizationRef",
  "--canonical-vacancy-id": "canonicalVacancyId",
  "--evidence-ref": "evidenceRef",
  "--external-id": "externalId",
  "--plan-hash": "planHash",
  "--scope": "scopeId",
  "--snapshot-id": "snapshotId",
} as const;

type ValueFlag = keyof typeof valueFlags;

export type ReconciliationArgumentFailureCode =
  | "APPLY_REQUIRES_PLAN_HASH"
  | "DRY_RUN_REJECTS_PLAN_HASH"
  | "INVALID_ARGUMENTS"
  | "INVALID_SCOPE";

export type ReconciliationArgumentResult =
  | {
      readonly code: ReconciliationArgumentFailureCode;
      readonly ok: false;
    }
  | {
      readonly input: z.output<typeof reconcileSpottExportInputSchema>;
      readonly ok: true;
    };

const isValueFlag = (value: string): value is ValueFlag =>
  Object.hasOwn(valueFlags, value);

export const parseReconciliationArguments = (
  args: readonly string[]
): ReconciliationArgumentResult => {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const values: Partial<Record<(typeof valueFlags)[ValueFlag], string>> = {};
  let apply = false;
  const seen = new Set<string>();

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const argument = normalizedArgs[index];
    if (!argument || seen.has(argument)) {
      return { code: "INVALID_ARGUMENTS", ok: false };
    }
    seen.add(argument);
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (!isValueFlag(argument)) {
      return { code: "INVALID_ARGUMENTS", ok: false };
    }
    const value = normalizedArgs[index + 1];
    if (!value || value.startsWith("--")) {
      return { code: "INVALID_ARGUMENTS", ok: false };
    }
    values[valueFlags[argument]] = value;
    index += 1;
  }

  if (values.scopeId !== RECONCILIATION_SCOPE_ID) {
    return { code: "INVALID_SCOPE", ok: false };
  }
  if (apply && values.planHash === undefined) {
    return { code: "APPLY_REQUIRES_PLAN_HASH", ok: false };
  }
  if (!apply && values.planHash !== undefined) {
    return { code: "DRY_RUN_REJECTS_PLAN_HASH", ok: false };
  }
  const parsed = reconcileSpottExportInputSchema.safeParse({
    ...values,
    apply,
  });
  if (!parsed.success) {
    return { code: "INVALID_ARGUMENTS", ok: false };
  }
  return { input: parsed.data, ok: true };
};

const reconciliationEnvironmentSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN: z.string().trim().min(1),
});

export type ReconciliationEnvironment = z.output<
  typeof reconciliationEnvironmentSchema
>;

export const parseReconciliationEnvironment = (
  environment: Record<string, string | undefined>
): ReconciliationEnvironment | null => {
  const parsed = reconciliationEnvironmentSchema.safeParse({
    BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: environment.BETTER_AUTH_URL,
    DATABASE_URL: environment.DATABASE_URL,
    SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN:
      environment.SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN,
  });
  return parsed.success ? parsed.data : null;
};

export interface ReconciliationSession {
  readonly session: {
    readonly expiresAt: Date | string;
    readonly id: string;
    readonly token: string;
  };
  readonly user: {
    readonly id: string;
    readonly role?: string | null;
  };
}

export interface CanonicalReconciliationSession {
  readonly expiresAt: Date;
  readonly role: string;
  readonly sessionId: string;
  readonly token: string;
  readonly userId: string;
}

const isSliceARole = (role: string): role is SliceARole =>
  role === "recruiter" ||
  role === "operator" ||
  role === ROLE_ADMIN ||
  role === "approver";

const expiryTime = (value: Date | string): number =>
  value instanceof Date ? value.getTime() : Date.parse(value);

export const principalFromReconciliationSession = (
  verified: ReconciliationSession | null,
  canonical: CanonicalReconciliationSession | null,
  now: Date
): SpottExportReconciliationPrincipal | null => {
  if (!verified || !canonical) {
    return null;
  }
  const actorId = verified.user.id;
  const { role } = verified.user;
  const verifiedExpiry = expiryTime(verified.session.expiresAt);
  const canonicalExpiry = canonical.expiresAt.getTime();
  const nowTime = now.getTime();
  if (
    !actorId ||
    actorId !== actorId.trim() ||
    !role ||
    !isSliceARole(role) ||
    canonical.sessionId !== verified.session.id ||
    canonical.token !== verified.session.token ||
    canonical.userId !== actorId ||
    canonical.role !== role ||
    !Number.isFinite(verifiedExpiry) ||
    !Number.isFinite(canonicalExpiry) ||
    !Number.isFinite(nowTime) ||
    verifiedExpiry <= nowTime ||
    canonicalExpiry <= nowTime
  ) {
    return null;
  }
  return {
    actorId,
    actorType: "agent",
    permissions: permissionsForRole(role),
  };
};

export const formatReconciliationRefusal = (code: string): string =>
  JSON.stringify({ code, status: "refused" });

export const reconciliationFailureCode = (error: Error): string =>
  error instanceof SpottExportReconciliationError
    ? error.code
    : "RECONCILIATION_FAILED";
