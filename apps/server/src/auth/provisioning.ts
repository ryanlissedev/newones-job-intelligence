import { AUTH_USER_ROLES } from "@ji/auth/security-config";
import type { AuthUserRole } from "@ji/auth/security-config";
import { z } from "zod";

const confirmationPhrase = "PROVISION_AUTH_USER";

const provisioningInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12).max(128),
  role: z.enum(AUTH_USER_ROLES),
});

export interface ProvisioningEnvironment {
  readonly AUTH_BOOTSTRAP_CONFIRM?: string;
  readonly AUTH_BOOTSTRAP_EMAIL?: string;
  readonly AUTH_BOOTSTRAP_ENABLED?: string;
  readonly AUTH_BOOTSTRAP_NAME?: string;
  readonly AUTH_BOOTSTRAP_PASSWORD?: string;
  readonly AUTH_BOOTSTRAP_ROLE?: string;
}

export interface ProvisioningInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly role: AuthUserRole;
}

export type ProvisioningParseResult =
  | { readonly code: "BOOTSTRAP_DISABLED"; readonly ok: false }
  | { readonly code: "CONFIRMATION_REQUIRED"; readonly ok: false }
  | { readonly code: "INVALID_BOOTSTRAP_INPUT"; readonly ok: false }
  | { readonly input: ProvisioningInput; readonly ok: true };

type ProvisioningRefusalCode = Extract<
  ProvisioningParseResult,
  { readonly ok: false }
>["code"];

export const parseProvisioningEnvironment = (
  environment: ProvisioningEnvironment
): ProvisioningParseResult => {
  if (environment.AUTH_BOOTSTRAP_ENABLED !== "1") {
    return { code: "BOOTSTRAP_DISABLED", ok: false };
  }
  if (environment.AUTH_BOOTSTRAP_CONFIRM !== confirmationPhrase) {
    return { code: "CONFIRMATION_REQUIRED", ok: false };
  }
  const parsed = provisioningInputSchema.safeParse({
    email: environment.AUTH_BOOTSTRAP_EMAIL,
    name: environment.AUTH_BOOTSTRAP_NAME,
    password: environment.AUTH_BOOTSTRAP_PASSWORD,
    role: environment.AUTH_BOOTSTRAP_ROLE,
  });
  if (!parsed.success) {
    return { code: "INVALID_BOOTSTRAP_INPUT", ok: false };
  }
  return { input: parsed.data, ok: true };
};

interface ProvisionedUser {
  readonly id: string;
}

interface CanonicalUser extends ProvisionedUser {
  readonly role: string | undefined;
}

export interface ProvisioningDependencies {
  readonly createUser: (
    credentials: Omit<ProvisioningInput, "role">,
    serverRole: AuthUserRole
  ) => Promise<ProvisionedUser>;
  readonly findUserByEmail: (email: string) => Promise<CanonicalUser | null>;
}

export type ProvisioningEvidence =
  | {
      readonly created: false;
      readonly status: "already_exists";
    }
  | {
      readonly created: true;
      readonly role: AuthUserRole;
      readonly roleVerified: true;
      readonly status: "provisioned";
    }
  | {
      readonly code: "ROLE_READBACK_FAILED";
      readonly created: true;
      readonly roleVerified: false;
      readonly status: "reconciliation_required";
    };

export class ProvisioningFailureError extends Error {
  readonly code: "CREATE_FAILED";

  constructor(code: ProvisioningFailureError["code"]) {
    super("Auth user provisioning failed");
    this.code = code;
    this.name = "ProvisioningFailureError";
  }
}

const findCanonicalUserSafely = async (
  email: string,
  dependencies: ProvisioningDependencies
): Promise<CanonicalUser | null> => {
  try {
    return await dependencies.findUserByEmail(email);
  } catch {
    return null;
  }
};

const roleReconciliationRequired = (): ProvisioningEvidence => ({
  code: "ROLE_READBACK_FAILED",
  created: true,
  roleVerified: false,
  status: "reconciliation_required",
});

export const provisionAuthUser = async (
  input: ProvisioningInput,
  dependencies: ProvisioningDependencies
): Promise<ProvisioningEvidence> => {
  if (await dependencies.findUserByEmail(input.email)) {
    return { created: false, status: "already_exists" };
  }

  let created: ProvisionedUser;
  try {
    const { role, ...credentials } = input;
    created = await dependencies.createUser(credentials, role);
  } catch {
    if (await findCanonicalUserSafely(input.email, dependencies)) {
      return { created: false, status: "already_exists" };
    }
    throw new ProvisioningFailureError("CREATE_FAILED");
  }

  const canonicalUser = await findCanonicalUserSafely(
    input.email,
    dependencies
  );
  if (!canonicalUser) {
    return roleReconciliationRequired();
  }
  if (canonicalUser.id !== created.id) {
    return { created: false, status: "already_exists" };
  }
  if (canonicalUser.role !== input.role) {
    return roleReconciliationRequired();
  }

  return {
    created: true,
    role: input.role,
    roleVerified: true,
    status: "provisioned",
  };
};

export const formatProvisioningOutput = (
  result:
    | ProvisioningEvidence
    | {
        readonly code:
          | ProvisioningFailureError["code"]
          | ProvisioningRefusalCode;
        readonly status: "refused";
      }
): string => JSON.stringify(result);
