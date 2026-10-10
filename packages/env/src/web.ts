import { createEnv } from "@t3-oss/env-nextjs";

import { resolveInternalServerUrl } from "./internal-server-url";
import {
  HttpUrlString,
  onEnvValidationError,
  Schema,
  toEnvSchema,
  UrlString,
} from "./schema-helpers";

const RELEASE_SHA_MESSAGE =
  "Release SHA must be a 40-character lowercase Git SHA (read from APP_RELEASE_SHA, or from Coolify's SOURCE_COMMIT when APP_RELEASE_SHA is unset).";

/** Effect Schema SoT for web env fields (ADR-0014 Slice 6). */
export const webEnvEffectSchemas = {
  APP_RELEASE_SHA: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[a-f0-9]{40}$/u, { message: RELEASE_SHA_MESSAGE })
    )
  ),
  INTERNAL_SERVER_URL: Schema.optional(HttpUrlString),
  NEXT_PUBLIC_SERVER_URL: UrlString,
  NEXT_PUBLIC_USE_FIXTURES: Schema.optional(Schema.String),
} as const;

export const env = createEnv({
  client: {
    NEXT_PUBLIC_SERVER_URL: toEnvSchema(
      webEnvEffectSchemas.NEXT_PUBLIC_SERVER_URL
    ),
    NEXT_PUBLIC_USE_FIXTURES: toEnvSchema(
      webEnvEffectSchemas.NEXT_PUBLIC_USE_FIXTURES
    ),
  },
  emptyStringAsUndefined: true,
  onValidationError: onEnvValidationError,
  runtimeEnv: {
    // Same resolution as @ji/env/server: Coolify injects SOURCE_COMMIT into
    // every container, so the web /version route echoes the built commit
    // without a hand-maintained APP_RELEASE_SHA.
    APP_RELEASE_SHA: process.env.APP_RELEASE_SHA || process.env.SOURCE_COMMIT,
    INTERNAL_SERVER_URL: process.env.INTERNAL_SERVER_URL,
    NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL,
    NEXT_PUBLIC_USE_FIXTURES: process.env.NEXT_PUBLIC_USE_FIXTURES,
  },
  server: {
    APP_RELEASE_SHA: toEnvSchema(webEnvEffectSchemas.APP_RELEASE_SHA),
    // Server-only: the API address as seen from inside the web container
    // (http://server:3000 in Compose). Optional so plain local dev, where the
    // browser and the Next.js server share one URL, keeps working unchanged.
    // http(s) only: "server:3000" is a *valid* WHATWG URL (scheme "server"),
    // so a bare URL check would accept the classic forgotten-scheme typo.
    INTERNAL_SERVER_URL: toEnvSchema(webEnvEffectSchemas.INTERNAL_SERVER_URL),
  },
});

/**
 * Base URL for every fetch the Next.js *server* makes to the API (dashboard
 * SSR session lookup, route handlers). Falls back to NEXT_PUBLIC_SERVER_URL
 * when INTERNAL_SERVER_URL is unset. Server-only: t3-env throws if this is
 * evaluated in the browser, which is the intended guard against leaking an
 * internal hostname into client code.
 */
export const getInternalServerUrl = (): string => resolveInternalServerUrl(env);

/** Fixture kill-switch for the web data source: "true" or "1" enables fixtures. */
export const fixturesEnabled =
  env.NEXT_PUBLIC_USE_FIXTURES === "true" ||
  env.NEXT_PUBLIC_USE_FIXTURES === "1";
