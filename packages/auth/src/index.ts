import { db } from "@ji/db";
import * as schema from "@ji/db/schema/auth";
import { env } from "@ji/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";

import {
  AUTH_BEARER_OPTIONS,
  AUTH_EMAIL_PASSWORD_OPTIONS,
  AUTH_USER_ROLE_FIELD,
  resolveCrossSubDomainCookieDomain,
} from "./security-config";
import type { AuthAdvancedCookieConfig } from "./security-config";

export {
  AUTH_BEARER_OPTIONS,
  AUTH_EMAIL_PASSWORD_OPTIONS,
  AUTH_USER_ROLES,
  AUTH_USER_ROLE_FIELD,
  DEFAULT_AUTH_USER_ROLE,
  resolveCrossSubDomainCookieDomain,
  type AuthUserRole,
} from "./security-config";

export const createAuth = () => {
  const isProduction = env.NODE_ENV === "production";
  const trustedOrigin = new URL(env.CORS_ORIGIN).origin;
  const crossSubDomainCookieDomain = resolveCrossSubDomainCookieDomain(
    env.BETTER_AUTH_URL,
    env.CORS_ORIGIN
  );

  const advanced: AuthAdvancedCookieConfig = {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
    },
  };

  if (crossSubDomainCookieDomain) {
    advanced.crossSubDomainCookies = {
      domain: crossSubDomainCookieDomain,
      enabled: true,
    };
  }

  return betterAuth({
    advanced,
    appName: "Newones",
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: AUTH_EMAIL_PASSWORD_OPTIONS,
    plugins: [bearer(AUTH_BEARER_OPTIONS)],
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [trustedOrigin],
    user: {
      additionalFields: {
        role: AUTH_USER_ROLE_FIELD,
      },
    },
  });
};

export const auth = createAuth();
