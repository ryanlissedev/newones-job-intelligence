import { describe, expect, it } from "bun:test";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";

import {
  AUTH_BEARER_OPTIONS,
  AUTH_EMAIL_PASSWORD_OPTIONS,
  AUTH_USER_ROLE_FIELD,
} from "./security-config";

const testSecret = "v1_dC5RX7k3Bm9pQ2sH8yN4wT6aF0jL1uE7oI9zG3cK5xM8rP2bW6qS4";

interface MemorySessionRecord {
  expiresAt?: Date;
}

interface MemoryUserRecord {
  role?: string;
}

const createMemory = () => {
  const account: object[] = [];
  const session: MemorySessionRecord[] = [];
  const user: MemoryUserRecord[] = [];
  const verification: object[] = [];
  return { account, session, user, verification };
};

const createTestAuth = (disableSignUp: boolean) => {
  const memory = createMemory();
  const auth = betterAuth({
    baseURL: "http://auth.test",
    database: memoryAdapter(memory),
    emailAndPassword: {
      ...AUTH_EMAIL_PASSWORD_OPTIONS,
      disableSignUp,
    },
    plugins: [bearer(AUTH_BEARER_OPTIONS)],
    secret: testSecret,
    user: {
      additionalFields: {
        role: AUTH_USER_ROLE_FIELD,
      },
    },
  });
  return { auth, memory };
};

const signUp = (
  auth: ReturnType<typeof createTestAuth>["auth"],
  role?: string
): Promise<Response> =>
  auth.handler(
    new Request("http://auth.test/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: `${crypto.randomUUID()}@example.invalid`,
        name: "Test User",
        password: "valid-password-123",
        role,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  );

const bearerHeaders = (token: string): Headers =>
  new Headers({ Authorization: `Bearer ${token}` });

describe("Better Auth security configuration", () => {
  it("disables public sign-up", async () => {
    const { auth, memory } = createTestAuth(true);

    const response = await signUp(auth);

    expect(response.ok).toBe(false);
    expect(memory.user).toHaveLength(0);
  });

  it("keeps role server-owned and defaults a new user to recruiter", async () => {
    const { auth, memory } = createTestAuth(false);

    const response = await signUp(auth, "admin");

    expect(response.status).toBe(200);
    expect(memory.user[0]?.role).toBe("recruiter");
  });

  it("accepts a signed session bearer and rejects unsigned or forged variants", async () => {
    const { auth } = createTestAuth(false);
    const response = await signUp(auth);
    const token = response.headers.get("set-auth-token");
    expect(token).toContain(".");
    if (!token) {
      throw new Error("Better Auth did not return a signed session token");
    }

    const valid = await auth.api.getSession({ headers: bearerHeaders(token) });
    const unsigned = await auth.api.getSession({
      headers: bearerHeaders(token.split(".")[0] ?? token),
    });
    const forged = await auth.api.getSession({
      headers: bearerHeaders(`${token.slice(0, -1)}x`),
    });

    expect(valid?.user.role).toBe("recruiter");
    expect(unsigned).toBeNull();
    expect(forged).toBeNull();
  });

  it("rejects an expired session and a replay after revocation", async () => {
    const expiredFixture = createTestAuth(false);
    const expiredResponse = await signUp(expiredFixture.auth);
    const expiredToken = expiredResponse.headers.get("set-auth-token");
    if (!expiredToken || !expiredFixture.memory.session[0]) {
      throw new Error("Better Auth did not create the expiration fixture");
    }
    expiredFixture.memory.session[0].expiresAt = new Date(0);

    const expired = await expiredFixture.auth.api.getSession({
      headers: bearerHeaders(expiredToken),
    });
    expect(expired).toBeNull();

    const revokedFixture = createTestAuth(false);
    const revokedResponse = await signUp(revokedFixture.auth);
    const revokedToken = revokedResponse.headers.get("set-auth-token");
    if (!revokedToken) {
      throw new Error("Better Auth did not create the revocation fixture");
    }
    const headers = bearerHeaders(revokedToken);
    expect(
      await revokedFixture.auth.api.getSession({ headers })
    ).not.toBeNull();

    await revokedFixture.auth.api.signOut({ headers });

    expect(await revokedFixture.auth.api.getSession({ headers })).toBeNull();
  });
});
