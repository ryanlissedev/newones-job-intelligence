import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import {
  AUTH_BEARER_OPTIONS,
  AUTH_EMAIL_PASSWORD_OPTIONS,
  AUTH_USER_ROLE_FIELD,
} from "@ji/auth/security-config";
import { session, user } from "@ji/db/schema/auth";
import * as schema from "@ji/db/schema/index";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ReconciliationEnvironment } from "./reconciliation";
import { createSpottReconciliationAuthorize } from "./transaction-auth";

const testDatabaseUrl =
  process.env.DATABASE_APP_TEST_URL ?? process.env.DATABASE_TEST_URL;
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" || testDatabaseUrl !== undefined;
const TEST_SECRET =
  "test-secret-test-secret-test-secret-transaction-auth-123456789";

const requireDisposableDatabaseUrl = (
  candidate: string | undefined
): string | null => {
  if (!candidate) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("DATABASE_APP_TEST_URL must be a valid Postgres URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.searchParams.has("database") ||
    parsed.searchParams.has("db") ||
    !/^\/ji_test_iso_[a-z0-9_]+$/u.test(parsed.pathname)
  ) {
    throw new Error(
      "DATABASE_APP_TEST_URL must name a disposable ji_test_iso database"
    );
  }
  return candidate;
};

const disposableDatabaseUrl = requireDisposableDatabaseUrl(testDatabaseUrl);

const isPostgresAvailable = async (): Promise<boolean> => {
  if (!disposableDatabaseUrl) {
    return false;
  }
  const probe = postgres(disposableDatabaseUrl, {
    connect_timeout: 2,
    max: 1,
  });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && testDatabaseRequired) {
  throw new Error("Required disposable test database is unavailable");
}

describe
  .skipIf(!postgresAvailable)
  .serial("Spott reconciliation transaction authentication", () => {
    let client: ReturnType<typeof postgres>;
    let database: ReturnType<typeof drizzle<typeof schema>>;
    const testEmails = new Set<string>();

    beforeAll(() => {
      if (!disposableDatabaseUrl) {
        throw new Error("Disposable database URL unexpectedly unavailable");
      }
      client = postgres(disposableDatabaseUrl, { max: 1 });
      database = drizzle(client, { schema });
    });

    afterEach(async () => {
      await Promise.all(
        [...testEmails].map((email) =>
          database.delete(user).where(eq(user.email, email))
        )
      );
      testEmails.clear();
    });

    afterAll(async () => {
      await client.end({ timeout: 1 });
    });

    it("accepts only a current signed admin bearer without refreshing or deleting sessions", async () => {
      const email = `reconciliation-${crypto.randomUUID()}@example.invalid`;
      testEmails.add(email);
      const fixtureAuth = betterAuth({
        baseURL: "https://auth.example.invalid",
        database: drizzleAdapter(database, { provider: "pg", schema }),
        emailAndPassword: {
          ...AUTH_EMAIL_PASSWORD_OPTIONS,
          disableSignUp: false,
        },
        logger: { disabled: true },
        plugins: [bearer(AUTH_BEARER_OPTIONS)],
        secret: TEST_SECRET,
        user: { additionalFields: { role: AUTH_USER_ROLE_FIELD } },
      });
      const response = await fixtureAuth.handler(
        new Request("https://auth.example.invalid/api/auth/sign-up/email", {
          body: JSON.stringify({
            email,
            name: "Reconciliation Admin",
            password: "valid-password-123",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      );
      const bearerToken = response.headers.get("set-auth-token");
      if (!bearerToken) {
        throw new Error("Better Auth did not return a signed fixture token");
      }
      const [createdUser] = await database
        .update(user)
        .set({ role: "admin" })
        .where(eq(user.email, email))
        .returning({ id: user.id });
      if (!createdUser) {
        throw new Error("Better Auth did not persist the fixture user");
      }
      const [before] = await database
        .select()
        .from(session)
        .where(eq(session.userId, createdUser.id));
      if (!before) {
        throw new Error("Better Auth did not persist the fixture session");
      }
      const environment: ReconciliationEnvironment = {
        BETTER_AUTH_SECRET: TEST_SECRET,
        BETTER_AUTH_URL: "https://auth.example.invalid",
        DATABASE_URL: disposableDatabaseUrl ?? "",
        SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN: bearerToken,
      };
      const authorize = createSpottReconciliationAuthorize(environment);
      const authorizeToken = (token: string) =>
        createSpottReconciliationAuthorize({
          ...environment,
          SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN: token,
        });

      const principal = await database.transaction(
        (transaction) => authorize(transaction, "dry-run"),
        { accessMode: "read only", isolationLevel: "repeatable read" }
      );
      expect(principal.actorId).toBe(createdUser.id);
      expect(principal.permissions.has("operator")).toBe(true);
      expect(principal.permissions.has("export")).toBe(true);

      const [afterValid] = await database
        .select()
        .from(session)
        .where(eq(session.id, before.id));
      expect(afterValid?.updatedAt).toEqual(before.updatedAt);
      expect(afterValid?.expiresAt).toEqual(before.expiresAt);

      const unsignedToken = bearerToken.split(".")[0] ?? bearerToken;
      const forgedToken = `${bearerToken.slice(0, -1)}${bearerToken.endsWith("x") ? "y" : "x"}`;
      await Promise.all(
        [authorizeToken(unsignedToken), authorizeToken(forgedToken)].map(
          (invalidAuthorize) =>
            expect(
              database.transaction(
                (transaction) => invalidAuthorize(transaction, "dry-run"),
                { accessMode: "read only", isolationLevel: "repeatable read" }
              )
            ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
        )
      );

      await database
        .update(session)
        .set({ expiresAt: new Date(0) })
        .where(eq(session.id, before.id));
      await expect(
        database.transaction(
          (transaction) => authorize(transaction, "dry-run"),
          { accessMode: "read only", isolationLevel: "repeatable read" }
        )
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(
        await database.select().from(session).where(eq(session.id, before.id))
      ).toHaveLength(1);

      await database.delete(session).where(eq(session.id, before.id));
      await expect(
        database.transaction(
          (transaction) => authorize(transaction, "dry-run"),
          { accessMode: "read only", isolationLevel: "repeatable read" }
        )
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });
