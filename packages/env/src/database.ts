import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";

import {
  NonEmptyString,
  onEnvValidationError,
  skipEnvValidation,
  toEnvSchema,
} from "./schema-helpers";

/**
 * Scoped env validation for database-only consumers (`@ji/db` and anything
 * that imports it, such as the worker's poll-bron scripts and Trigger.dev
 * tasks). Those consumers only ever read `DATABASE_URL` from `@ji/env` — the
 * server-wide schema in `./server.ts` additionally requires
 * `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `CORS_ORIGIN`, which are real
 * requirements for `apps/server` but irrelevant to a DB-only process. Pulling
 * the full server schema into every DB consumer meant a worker script with
 * only `DATABASE_URL` and `MANTICORE_URL` set would fail at import time on
 * auth variables it never uses.
 *
 * Keep this schema's required fields limited to what `@ji/db` actually
 * reads. Do not add `apps/server`-only fields here, and do not loosen
 * `./server.ts` to work around a DB-only consumer — that would remove a real
 * guard for `apps/server`.
 *
 * Effect Schema SoT (CTP-471 / ADR-0014 Slice 6).
 */
export const databaseEnvEffectSchemas = {
  DATABASE_URL: NonEmptyString,
} as const;

export const env = createEnv({
  emptyStringAsUndefined: true,
  onValidationError: onEnvValidationError,
  runtimeEnv: process.env,
  server: {
    DATABASE_URL: toEnvSchema(databaseEnvEffectSchemas.DATABASE_URL),
  },
  skipValidation: skipEnvValidation(),
});
