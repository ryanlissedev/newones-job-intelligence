import { SpottExportReconciliationError } from "@ji/application/export/reconciliation";
import {
  AUTH_BEARER_OPTIONS,
  AUTH_EMAIL_PASSWORD_OPTIONS,
  AUTH_USER_ROLE_FIELD,
} from "@ji/auth/security-config";
import type { ReconcileSpottExportAuthorize } from "@ji/db/export-reconciliation";
import * as authSchema from "@ji/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";

import type { ReconciliationEnvironment } from "./reconciliation";
import { principalFromReconciliationSession } from "./reconciliation";

export const createSpottReconciliationAuthorize =
  (
    environment: ReconciliationEnvironment,
    now: () => Date = () => new Date()
  ): ReconcileSpottExportAuthorize =>
  async (transaction, mode) => {
    const transactionAuth = betterAuth({
      appName: "Catapulze Export Reconciliation",
      baseURL: environment.BETTER_AUTH_URL,
      database: drizzleAdapter(transaction, {
        provider: "pg",
        schema: authSchema,
      }),
      emailAndPassword: AUTH_EMAIL_PASSWORD_OPTIONS,
      logger: { disabled: true },
      plugins: [bearer(AUTH_BEARER_OPTIONS)],
      secret: environment.BETTER_AUTH_SECRET,
      session: { deferSessionRefresh: true },
      user: {
        additionalFields: {
          role: AUTH_USER_ROLE_FIELD,
        },
      },
    });
    const verified = await transactionAuth.api.getSession({
      headers: new Headers({
        Authorization: `Bearer ${environment.SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN}`,
      }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!verified) {
      throw new SpottExportReconciliationError(
        "UNAUTHORIZED",
        "An authenticated administrator is required for export reconciliation"
      );
    }

    const canonicalQuery = transaction
      .select({
        expiresAt: authSchema.session.expiresAt,
        role: authSchema.user.role,
        sessionId: authSchema.session.id,
        token: authSchema.session.token,
        userId: authSchema.user.id,
      })
      .from(authSchema.session)
      .innerJoin(
        authSchema.user,
        eq(authSchema.user.id, authSchema.session.userId)
      )
      .where(
        and(
          eq(authSchema.session.id, verified.session.id),
          eq(authSchema.user.id, verified.user.id)
        )
      )
      .limit(1);
    const canonicalRows = await (mode === "apply"
      ? canonicalQuery.for("update")
      : canonicalQuery);
    const principal = principalFromReconciliationSession(
      verified,
      canonicalRows[0] ?? null,
      now()
    );
    if (!principal) {
      throw new SpottExportReconciliationError(
        "UNAUTHORIZED",
        "An authenticated administrator is required for export reconciliation"
      );
    }
    return principal;
  };
