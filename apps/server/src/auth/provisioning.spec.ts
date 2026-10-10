import { describe, expect, it } from "bun:test";

import { AUTH_USER_ROLE_FIELD } from "@ji/auth/security-config";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import {
  formatProvisioningOutput,
  parseProvisioningEnvironment,
  provisionAuthUser,
} from "./provisioning";
import type { ProvisioningInput } from "./provisioning";

const validEnvironment = {
  AUTH_BOOTSTRAP_CONFIRM: "PROVISION_AUTH_USER",
  AUTH_BOOTSTRAP_EMAIL: "operator@example.invalid",
  AUTH_BOOTSTRAP_ENABLED: "1",
  AUTH_BOOTSTRAP_NAME: "Operator",
  AUTH_BOOTSTRAP_PASSWORD: "secret-password-123",
  AUTH_BOOTSTRAP_ROLE: "operator",
} as const;

const betterAuthTestSecret =
  "v1_dC5RX7k3Bm9pQ2sH8yN4wT6aF0jL1uE7oI9zG3cK5xM8rP2bW6qS4";

interface StoredUserFixture {
  readonly id: string;
  readonly role: string;
}

interface BetterAuthMemoryFixture extends Record<string, object[]> {
  account: object[];
  session: object[];
  user: { email?: string; id?: string; role?: string }[];
  verification: object[];
}

const findAfterCreation = (stored: StoredUserFixture) => {
  let lookupCalls = 0;
  return () => {
    lookupCalls += 1;
    return Promise.resolve(lookupCalls === 1 ? null : stored);
  };
};

describe("auth user provisioning", () => {
  it("is disabled by default and requires explicit confirmation", () => {
    expect(parseProvisioningEnvironment({})).toEqual({
      code: "BOOTSTRAP_DISABLED",
      ok: false,
    });
    expect(
      parseProvisioningEnvironment({
        ...validEnvironment,
        AUTH_BOOTSTRAP_CONFIRM: undefined,
      })
    ).toEqual({ code: "CONFIRMATION_REQUIRED", ok: false });
  });

  it("rejects an injected role outside the server allowlist", () => {
    expect(
      parseProvisioningEnvironment({
        ...validEnvironment,
        AUTH_BOOTSTRAP_ROLE: "root",
      })
    ).toEqual({ code: "INVALID_BOOTSTRAP_INPUT", ok: false });
  });

  it("normalizes email before existence lookup and account creation", async () => {
    const parsed = parseProvisioningEnvironment({
      ...validEnvironment,
      AUTH_BOOTSTRAP_EMAIL: "  Operator@Example.Invalid ",
    });
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }
    const observedEmails: string[] = [];
    let lookupCalls = 0;

    const result = await provisionAuthUser(parsed.input, {
      createUser: (credentials) => {
        observedEmails.push(credentials.email);
        return Promise.resolve({ id: "created-user" });
      },
      findUserByEmail: (email) => {
        lookupCalls += 1;
        observedEmails.push(email);
        return Promise.resolve(
          lookupCalls === 1 ? null : { id: "created-user", role: "operator" }
        );
      },
    });

    expect(parsed.input.email).toBe("operator@example.invalid");
    expect(observedEmails).toEqual([
      "operator@example.invalid",
      "operator@example.invalid",
      "operator@example.invalid",
    ]);
    expect(result.status).toBe("provisioned");
  });

  it("treats a mixed-case retry as the same existing email", async () => {
    const parsed = parseProvisioningEnvironment({
      ...validEnvironment,
      AUTH_BOOTSTRAP_EMAIL: "OPERATOR@EXAMPLE.INVALID",
    });
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }
    let createCalls = 0;

    const result = await provisionAuthUser(parsed.input, {
      createUser: () => {
        createCalls += 1;
        return Promise.resolve({ id: "not-created" });
      },
      findUserByEmail: (email) =>
        Promise.resolve(
          email === "operator@example.invalid"
            ? { id: "existing-user", role: "operator" }
            : null
        ),
    });

    expect(result).toEqual({ created: false, status: "already_exists" });
    expect(createCalls).toBe(0);
  });

  it("refuses an existing email without creating or changing the user", async () => {
    let createCalls = 0;
    const parsed = parseProvisioningEnvironment(validEnvironment);
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }

    const result = await provisionAuthUser(parsed.input, {
      createUser: () => {
        createCalls += 1;
        return Promise.resolve({ id: "not-created" });
      },
      findUserByEmail: () =>
        Promise.resolve({ id: "existing-user", role: "operator" }),
    });

    expect(result).toEqual({ created: false, status: "already_exists" });
    expect(createCalls).toBe(0);
  });

  it("passes credentials separately from the validated server role and verifies readback", async () => {
    const parsed = parseProvisioningEnvironment(validEnvironment);
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }
    let receivedCredentials: Omit<ProvisioningInput, "role"> | null = null;

    const result = await provisionAuthUser(parsed.input, {
      createUser: (credentials, role) => {
        receivedCredentials = credentials;
        expect(role).toBe("operator");
        return Promise.resolve({ id: "created-user" });
      },
      findUserByEmail: findAfterCreation({
        id: "created-user",
        role: "operator",
      }),
    });

    expect(receivedCredentials).not.toHaveProperty("role");
    expect(result).toEqual({
      created: true,
      role: "operator",
      roleVerified: true,
      status: "provisioned",
    });
  });

  it("treats a concurrent duplicate as already existing", async () => {
    const parsed = parseProvisioningEnvironment(validEnvironment);
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }
    let lookupCalls = 0;

    const result = await provisionAuthUser(parsed.input, {
      createUser: () => Promise.reject(new Error("duplicate")),
      findUserByEmail: () => {
        lookupCalls += 1;
        return Promise.resolve(
          lookupCalls === 1 ? null : { id: "concurrent-user", role: "operator" }
        );
      },
    });

    expect(result).toEqual({ created: false, status: "already_exists" });
    expect(lookupCalls).toBe(2);
  });

  it("detects Better Auth's synthetic duplicate response after a stale precheck", async () => {
    const parsed = parseProvisioningEnvironment({
      ...validEnvironment,
      AUTH_BOOTSTRAP_EMAIL: "  Operator@Example.Invalid ",
    });
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }

    const memory: BetterAuthMemoryFixture = {
      account: [],
      session: [],
      user: [],
      verification: [],
    };
    const provisioner = betterAuth({
      baseURL: "http://auth.test",
      database: memoryAdapter(memory),
      emailAndPassword: {
        autoSignIn: false,
        disableSignUp: false,
        enabled: true,
      },
      secret: betterAuthTestSecret,
      user: {
        additionalFields: {
          role: {
            ...AUTH_USER_ROLE_FIELD,
            defaultValue: parsed.input.role,
          },
        },
      },
    });
    const canonical = await provisioner.api.signUpEmail({
      body: {
        email: parsed.input.email,
        name: "Concurrent Operator",
        password: "concurrent-password-123",
      },
    });
    let lookupCalls = 0;
    let duplicateResponseId: string | undefined;

    const result = await provisionAuthUser(parsed.input, {
      createUser: async (credentials) => {
        const duplicate = await provisioner.api.signUpEmail({
          body: credentials,
        });
        duplicateResponseId = duplicate.user.id;
        return { id: duplicate.user.id };
      },
      findUserByEmail: (email) => {
        lookupCalls += 1;
        if (lookupCalls === 1) {
          return Promise.resolve(null);
        }
        const stored = memory.user.find((user) => user.email === email);
        return Promise.resolve(
          stored?.id ? { id: stored.id, role: stored.role } : null
        );
      },
    });

    expect(canonical.user.id).not.toBe(duplicateResponseId);
    expect(result).toEqual({ created: false, status: "already_exists" });
    expect(memory.user).toHaveLength(1);
  });

  it("reports created-but-unverified evidence when role readback fails", async () => {
    const parsed = parseProvisioningEnvironment(validEnvironment);
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }
    let lookupCalls = 0;

    const result = await provisionAuthUser(parsed.input, {
      createUser: () => Promise.resolve({ id: "created-user" }),
      findUserByEmail: () => {
        lookupCalls += 1;
        return lookupCalls === 1
          ? Promise.resolve(null)
          : Promise.reject(new Error("sensitive database detail"));
      },
    });

    expect(result).toEqual({
      code: "ROLE_READBACK_FAILED",
      created: true,
      roleVerified: false,
      status: "reconciliation_required",
    });
    expect(formatProvisioningOutput(result)).toBe(
      '{"code":"ROLE_READBACK_FAILED","created":true,"roleVerified":false,"status":"reconciliation_required"}'
    );
  });

  it("requires reconciliation when the stored role differs", async () => {
    const parsed = parseProvisioningEnvironment(validEnvironment);
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }

    const result = await provisionAuthUser(parsed.input, {
      createUser: () => Promise.resolve({ id: "created-user" }),
      findUserByEmail: findAfterCreation({
        id: "created-user",
        role: "recruiter",
      }),
    });

    expect(result).toEqual({
      code: "ROLE_READBACK_FAILED",
      created: true,
      roleVerified: false,
      status: "reconciliation_required",
    });
  });

  it("never includes email or password in operator evidence", async () => {
    const parsed = parseProvisioningEnvironment(validEnvironment);
    if (!parsed.ok) {
      throw new Error("Expected a valid provisioning fixture");
    }
    const result = await provisionAuthUser(parsed.input, {
      createUser: () => Promise.resolve({ id: "created-user" }),
      findUserByEmail: findAfterCreation({
        id: "created-user",
        role: "operator",
      }),
    });

    const output = formatProvisioningOutput(result);
    expect(output).not.toContain(validEnvironment.AUTH_BOOTSTRAP_EMAIL);
    expect(output).not.toContain(validEnvironment.AUTH_BOOTSTRAP_PASSWORD);
    expect(output).toBe(
      '{"created":true,"role":"operator","roleVerified":true,"status":"provisioned"}'
    );
  });
});
