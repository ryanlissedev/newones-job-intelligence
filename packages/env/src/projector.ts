import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";

import { projectorDatabaseUrlEffectSchema } from "./projector-database-url";
import {
  Effect,
  onEnvValidationError,
  Schema,
  skipEnvValidation,
  toEnvSchema,
  TrimmedNonEmptyString,
  UrlString,
} from "./schema-helpers";

const RELEASE_SHA_MESSAGE =
  "Release SHA must be a 40-character lowercase Git SHA (read from APP_RELEASE_SHA, or from Coolify's SOURCE_COMMIT when APP_RELEASE_SHA is unset).";

/**
 * Dedicated env contract for the long-running on-box projector. Runtime data
 * queries may use Neon's pooled DATABASE_URL, while the session advisory lock
 * must use the direct PROJECTOR_DATABASE_URL endpoint.
 *
 * Effect Schema SoT (CTP-471 / ADR-0014 Slice 6).
 */
export const projectorEnvEffectSchemas = {
  APP_RELEASE_SHA: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[a-f0-9]{40}$/u, { message: RELEASE_SHA_MESSAGE })
    )
  ),
  DATABASE_URL: TrimmedNonEmptyString,
  MANTICORE_URL: UrlString,
  PROJECTOR_DATABASE_URL: projectorDatabaseUrlEffectSchema,
  /** Must match the server while rebuilding/draining the hybrid generation. */
  SEARCH_HYBRID: Schema.Literals(["0", "1"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("0" as const))
  ),
} as const;

export const env = createEnv({
  emptyStringAsUndefined: true,
  onValidationError: onEnvValidationError,
  runtimeEnv: {
    ...process.env,
    // Coolify injects SOURCE_COMMIT (the exact commit it built) into every
    // container, so a hand-maintained APP_RELEASE_SHA is optional and only
    // overrides it when set. Resolved here, once: the runtime row the
    // projector publishes reads env.APP_RELEASE_SHA.
    APP_RELEASE_SHA: process.env.APP_RELEASE_SHA || process.env.SOURCE_COMMIT,
  },
  server: {
    APP_RELEASE_SHA: toEnvSchema(projectorEnvEffectSchemas.APP_RELEASE_SHA),
    DATABASE_URL: toEnvSchema(projectorEnvEffectSchemas.DATABASE_URL),
    MANTICORE_URL: toEnvSchema(projectorEnvEffectSchemas.MANTICORE_URL),
    PROJECTOR_DATABASE_URL: toEnvSchema(
      projectorEnvEffectSchemas.PROJECTOR_DATABASE_URL
    ),
    SEARCH_HYBRID: toEnvSchema(projectorEnvEffectSchemas.SEARCH_HYBRID),
  },
  skipValidation: skipEnvValidation(),
});
