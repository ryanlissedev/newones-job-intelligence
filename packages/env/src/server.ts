import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";

import {
  Effect,
  NonEmptyString,
  onEnvValidationError,
  Schema,
  skipEnvValidation,
  toEnvSchema,
  UrlString,
} from "./schema-helpers";

const RELEASE_SHA_MESSAGE =
  "Release SHA must be a 40-character lowercase Git SHA (read from APP_RELEASE_SHA, or from Coolify's SOURCE_COMMIT when APP_RELEASE_SHA is unset).";

/** Effect Schema SoT for server env fields (ADR-0014 Slice 6). */
export const serverEnvEffectSchemas = {
  APP_RELEASE_SHA: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[a-f0-9]{40}$/u, { message: RELEASE_SHA_MESSAGE })
    )
  ),
  BETTER_AUTH_SECRET: Schema.String.check(Schema.isMinLength(32)),
  BETTER_AUTH_URL: UrlString,
  CORS_ORIGIN: UrlString,
  DATABASE_URL: NonEmptyString,
  JI_EFFECT_DB: Schema.Literals(["0", "1"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("0" as const))
  ),
  JI_EFFECT_SERVER: Schema.Literals(["0", "1"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("0" as const))
  ),
  MANTICORE_URL: UrlString.pipe(
    Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:9308"))
  ),
  MARKTVRAGEN_CHAT_MODEL: Schema.optional(NonEmptyString),
  MARKTVRAGEN_MAX_TURNS_PER_HOUR: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isBetween({ maximum: 10_000, minimum: 1 })
    )
  ),
  NODE_ENV: Schema.Literals(["development", "production", "test"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("development" as const))
  ),
  OPENROUTER_API_KEY: Schema.optional(NonEmptyString),
  PERF_EFFECT_SPANS: Schema.Literals(["0", "1"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("0" as const))
  ),
  PORT: Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: 65_535, minimum: 1 })
  ).pipe(Schema.withDecodingDefault(Effect.succeed("3000"))),
  RAW_OBJECT_STORE_PATH: Schema.optional(NonEmptyString),
  RAW_S3_ACCESS_KEY_ID: Schema.optional(NonEmptyString),
  RAW_S3_BUCKET: Schema.optional(NonEmptyString),
  RAW_S3_ENDPOINT: Schema.optional(NonEmptyString),
  RAW_S3_REGION: Schema.optional(NonEmptyString),
  RAW_S3_SECRET_ACCESS_KEY: Schema.optional(NonEmptyString),
  REDIS_URL: Schema.optional(UrlString),
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
    // overrides it when set. Resolved here, once: everything that needs the
    // release SHA (/version, readiness, telemetry) reads env.APP_RELEASE_SHA.
    APP_RELEASE_SHA: process.env.APP_RELEASE_SHA || process.env.SOURCE_COMMIT,
  },
  server: {
    APP_RELEASE_SHA: toEnvSchema(serverEnvEffectSchemas.APP_RELEASE_SHA),
    BETTER_AUTH_SECRET: toEnvSchema(serverEnvEffectSchemas.BETTER_AUTH_SECRET),
    BETTER_AUTH_URL: toEnvSchema(serverEnvEffectSchemas.BETTER_AUTH_URL),
    CORS_ORIGIN: toEnvSchema(serverEnvEffectSchemas.CORS_ORIGIN),
    DATABASE_URL: toEnvSchema(serverEnvEffectSchemas.DATABASE_URL),
    JI_EFFECT_DB: toEnvSchema(serverEnvEffectSchemas.JI_EFFECT_DB),
    JI_EFFECT_SERVER: toEnvSchema(serverEnvEffectSchemas.JI_EFFECT_SERVER),
    MANTICORE_URL: toEnvSchema(serverEnvEffectSchemas.MANTICORE_URL),
    MARKTVRAGEN_CHAT_MODEL: toEnvSchema(
      serverEnvEffectSchemas.MARKTVRAGEN_CHAT_MODEL
    ),
    MARKTVRAGEN_MAX_TURNS_PER_HOUR: toEnvSchema(
      serverEnvEffectSchemas.MARKTVRAGEN_MAX_TURNS_PER_HOUR
    ),
    NODE_ENV: toEnvSchema(serverEnvEffectSchemas.NODE_ENV),
    OPENROUTER_API_KEY: toEnvSchema(serverEnvEffectSchemas.OPENROUTER_API_KEY),
    PERF_EFFECT_SPANS: toEnvSchema(serverEnvEffectSchemas.PERF_EFFECT_SPANS),
    PORT: toEnvSchema(serverEnvEffectSchemas.PORT),
    RAW_OBJECT_STORE_PATH: toEnvSchema(
      serverEnvEffectSchemas.RAW_OBJECT_STORE_PATH
    ),
    RAW_S3_ACCESS_KEY_ID: toEnvSchema(
      serverEnvEffectSchemas.RAW_S3_ACCESS_KEY_ID
    ),
    RAW_S3_BUCKET: toEnvSchema(serverEnvEffectSchemas.RAW_S3_BUCKET),
    RAW_S3_ENDPOINT: toEnvSchema(serverEnvEffectSchemas.RAW_S3_ENDPOINT),
    RAW_S3_REGION: toEnvSchema(serverEnvEffectSchemas.RAW_S3_REGION),
    RAW_S3_SECRET_ACCESS_KEY: toEnvSchema(
      serverEnvEffectSchemas.RAW_S3_SECRET_ACCESS_KEY
    ),
    REDIS_URL: toEnvSchema(serverEnvEffectSchemas.REDIS_URL),
    SEARCH_HYBRID: toEnvSchema(serverEnvEffectSchemas.SEARCH_HYBRID),
  },
  skipValidation: skipEnvValidation(),
});
