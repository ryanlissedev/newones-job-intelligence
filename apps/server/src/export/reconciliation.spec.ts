import { describe, expect, it } from "bun:test";

import {
  parseReconciliationArguments,
  parseReconciliationEnvironment,
  principalFromReconciliationSession,
  RECONCILIATION_SCOPE_ID,
} from "./reconciliation";

const UUIDS = {
  approval: "00000000-0000-4000-8000-000000000001",
  canonicalVacancy: "00000000-0000-4000-8000-000000000002",
  snapshot: "00000000-0000-4000-8000-000000000003",
} as const;

const requiredArgs = [
  "--scope",
  RECONCILIATION_SCOPE_ID,
  "--canonical-vacancy-id",
  UUIDS.canonicalVacancy,
  "--external-id",
  "spott-vacancy-42",
  "--snapshot-id",
  UUIDS.snapshot,
  "--approval-id",
  UUIDS.approval,
  "--evidence-ref",
  "ticket:RJC-435/provider-readback",
  "--authorization-ref",
  "change:RJC-435/operator-approved",
] as const;

const validEnvironment = {
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
  BETTER_AUTH_URL: "https://auth.example.invalid",
  DATABASE_URL: "postgres://example.invalid/job-intelligence",
  SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN: "signed.session-token",
};

describe("reconciliation CLI parsing", () => {
  it("defaults a complete argument set to dry-run", () => {
    const parsed = parseReconciliationArguments(["--", ...requiredArgs]);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.input).toEqual({
        apply: false,
        approvalId: UUIDS.approval,
        authorizationRef: "change:RJC-435/operator-approved",
        canonicalVacancyId: UUIDS.canonicalVacancy,
        evidenceRef: "ticket:RJC-435/provider-readback",
        externalId: "spott-vacancy-42",
        scopeId: RECONCILIATION_SCOPE_ID,
        snapshotId: UUIDS.snapshot,
      });
    }
  });

  it("requires the dry-run plan hash for apply", () => {
    expect(parseReconciliationArguments([...requiredArgs, "--apply"])).toEqual({
      code: "APPLY_REQUIRES_PLAN_HASH",
      ok: false,
    });
    expect(
      parseReconciliationArguments([
        ...requiredArgs,
        "--apply",
        "--plan-hash",
        "a".repeat(64),
      ]).ok
    ).toBe(true);
  });

  it("rejects unknown, duplicate, secret, actor, and role arguments", () => {
    for (const extra of [
      ["--unknown", "value"],
      ["--scope", RECONCILIATION_SCOPE_ID],
      ["--bearer", "secret"],
      ["--actor-id", "attacker"],
      ["--role", "admin"],
    ]) {
      expect(parseReconciliationArguments([...requiredArgs, ...extra]).ok).toBe(
        false
      );
    }
  });

  it("rejects a foreign scope and incomplete environment without exposing values", () => {
    const foreign: string[] = [...requiredArgs];
    foreign[1] = "other-tenant";
    expect(parseReconciliationArguments(foreign)).toEqual({
      code: "INVALID_SCOPE",
      ok: false,
    });
    expect(parseReconciliationEnvironment(validEnvironment)).not.toBeNull();
    expect(
      parseReconciliationEnvironment({
        ...validEnvironment,
        SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN: undefined,
      })
    ).toBeNull();
  });
});

describe("reconciliation session authorization", () => {
  const now = new Date("2026-09-05T12:00:00.000Z");
  const verified = {
    session: {
      expiresAt: new Date("2026-09-05T13:00:00.000Z"),
      id: "session-1",
      token: "raw-session-token-1",
    },
    user: { id: "admin-1", role: "admin" },
  } as const;
  const canonical = {
    expiresAt: new Date("2026-09-05T13:00:00.000Z"),
    role: "admin",
    sessionId: "session-1",
    token: "raw-session-token-1",
    userId: "admin-1",
  } as const;

  it("returns the exact server identity with operator and export permissions", () => {
    const principal = principalFromReconciliationSession(
      verified,
      canonical,
      now
    );

    expect(principal?.actorId).toBe("admin-1");
    expect(principal?.actorType).toBe("agent");
    expect(principal?.permissions.has("operator")).toBe(true);
    expect(principal?.permissions.has("export")).toBe(true);
  });

  it("rejects null, expired, downgraded, mismatched, and padded identities", () => {
    expect(principalFromReconciliationSession(null, canonical, now)).toBeNull();
    expect(
      principalFromReconciliationSession(
        verified,
        { ...canonical, expiresAt: new Date(0) },
        now
      )
    ).toBeNull();
    expect(
      principalFromReconciliationSession(
        {
          ...verified,
          session: { ...verified.session, expiresAt: "invalid-date" },
        },
        canonical,
        now
      )
    ).toBeNull();
    expect(
      principalFromReconciliationSession(
        verified,
        { ...canonical, role: "operator" },
        now
      )
    ).toBeNull();
    expect(
      principalFromReconciliationSession(
        verified,
        { ...canonical, token: "different-raw-session-token" },
        now
      )
    ).toBeNull();
    expect(
      principalFromReconciliationSession(
        verified,
        { ...canonical, sessionId: "revoked-session" },
        now
      )
    ).toBeNull();
    expect(
      principalFromReconciliationSession(
        verified,
        canonical,
        new Date(Number.NaN)
      )
    ).toBeNull();
    expect(
      principalFromReconciliationSession(
        { ...verified, user: { id: " admin-1", role: "admin" } },
        canonical,
        now
      )
    ).toBeNull();
  });
});
