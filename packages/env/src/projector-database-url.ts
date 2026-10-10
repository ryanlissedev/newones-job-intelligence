import { Schema, toEnvSchema } from "./schema-helpers";
import type { EnvStandardSchema } from "./schema-helpers";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

/**
 * Neon exposes pooled endpoints in both the current `*-pooler.<region>` form
 * and the older/documented `*.pooler.<region>` form. Session-level advisory
 * locks cannot be trusted through either endpoint because PgBouncer can move
 * consecutive queries between backend sessions.
 */
export const isKnownNeonPoolerHostname = (hostname: string): boolean => {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  if (!normalizedHostname.endsWith(".neon.tech")) {
    return false;
  }

  const hostnameLabels = normalizedHostname.split(".");
  return (
    normalizedHostname.includes("-pooler.") || hostnameLabels.includes("pooler")
  );
};

export const directDatabaseUrlMessage = (variableName: string): string =>
  `${variableName} must use a direct Postgres connection; Neon pooler hosts cannot hold a session advisory lock`;

/**
 * Effect Schema SoT for a singleton process's lock endpoint. Every
 * long-running process that holds a session advisory lock (projector, poller)
 * declares its own variable name and gets messages that name it. Error
 * messages never echo the URL (credentials live in the authority component).
 */
export const directDatabaseUrlEffectSchema = (variableName: string) =>
  Schema.Trim.check(
    Schema.isMinLength(1, {
      message: `${variableName} is required to hold the process advisory lock`,
    }),
    Schema.makeFilter((databaseUrl) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(databaseUrl);
      } catch {
        return `${variableName} must be a valid Postgres URL`;
      }

      if (!POSTGRES_PROTOCOLS.has(parsedUrl.protocol)) {
        return `${variableName} must use postgres:// or postgresql://`;
      }

      if (isKnownNeonPoolerHostname(parsedUrl.hostname)) {
        return directDatabaseUrlMessage(variableName);
      }
    })
  );

/** Parse at the lock boundary as well as in the typed process env. */
export const parseDirectDatabaseUrl = (
  databaseUrl: string,
  variableName: string
): string => {
  const schema: EnvStandardSchema<string> = toEnvSchema(
    directDatabaseUrlEffectSchema(variableName)
  );
  const result = schema["~standard"].validate(databaseUrl);
  if (result instanceof Promise) {
    throw new TypeError(`${variableName} validation must be synchronous`);
  }
  if (result.issues) {
    throw new Error(result.issues[0]?.message ?? `Invalid ${variableName}`);
  }
  return result.value;
};

export const PROJECTOR_DATABASE_URL_DIRECT_MESSAGE = directDatabaseUrlMessage(
  "PROJECTOR_DATABASE_URL"
);

export const projectorDatabaseUrlEffectSchema = directDatabaseUrlEffectSchema(
  "PROJECTOR_DATABASE_URL"
);

/** Standard Schema adapter for createEnv / projector env. */
export const projectorDatabaseUrlSchema: EnvStandardSchema<string> =
  toEnvSchema(projectorDatabaseUrlEffectSchema);

export const parseProjectorDatabaseUrl = (databaseUrl: string): string =>
  parseDirectDatabaseUrl(databaseUrl, "PROJECTOR_DATABASE_URL");
