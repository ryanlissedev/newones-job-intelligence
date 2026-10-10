import path from "node:path";

import { z } from "zod";

export const EFFECT_E2E_SCHEMA_VERSION = 1 as const;

export type EffectE2eEnvironment = Readonly<Record<string, string | undefined>>;

export interface EffectE2eConfig {
  readonly apiUrl: string;
  readonly artifactDir: string;
  readonly baseUrl: string;
  readonly canaryDigest: string;
  readonly canaryId: string;
  readonly databaseMarker: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly expectedSha: string;
  readonly privateDir: string;
  readonly runId: string;
}

export interface EffectE2eAuthFile {
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly role: "operator" | "recruiter";
  readonly subjectId: string;
}

export interface EffectE2eAuthBundle {
  readonly operator: EffectE2eAuthFile & { readonly role: "operator" };
  readonly recruiter: EffectE2eAuthFile & { readonly role: "recruiter" };
}

export interface EffectE2eAuthEvidence {
  readonly operator: { readonly role: "operator"; readonly subjectId: string };
  readonly recruiter: {
    readonly role: "recruiter";
    readonly subjectId: string;
  };
}

export interface EffectE2eSeedArtifact {
  readonly auth: EffectE2eAuthEvidence;
  readonly canary: {
    readonly digest: string;
    readonly id: string;
    readonly query: string;
    readonly title: string;
  };
  readonly cleanup: {
    readonly aanvraagId: string;
    readonly bronId: string;
    readonly database: "disposable";
    readonly outboxId: string;
    readonly scrapeRunId: string;
  };
  readonly evidence: {
    readonly authStoredPrivately: true;
    readonly seedPath: string;
  };
  readonly rows: {
    readonly booleanJobs: 1;
    readonly bronnen: 1;
  };
  readonly schemaVersion: 1;
  readonly status: "passed";
}

export const seedArtifactSchema = z.object({
  auth: z.object({
    operator: z.object({
      role: z.literal("operator"),
      subjectId: z.string().min(1),
    }),
    recruiter: z.object({
      role: z.literal("recruiter"),
      subjectId: z.string().min(1),
    }),
  }),
  canary: z.object({
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    id: z.string().uuid(),
    query: z.string().min(1),
    title: z.string().min(1),
  }),
  cleanup: z.object({
    aanvraagId: z.string().uuid(),
    bronId: z.string().uuid(),
    database: z.literal("disposable"),
    outboxId: z.string().uuid(),
    scrapeRunId: z.string().uuid(),
  }),
  evidence: z.object({
    authStoredPrivately: z.literal(true),
    seedPath: z.string().min(1),
  }),
  rows: z.object({
    booleanJobs: z.literal(1),
    bronnen: z.literal(1),
  }),
  schemaVersion: z.literal(EFFECT_E2E_SCHEMA_VERSION),
  status: z.literal("passed"),
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUIRED_EFFECT_FLAGS = [
  "JI_EFFECT_DB",
  "JI_EFFECT_SERVER",
  "JI_EFFECT_WORKER",
  "PERF_EFFECT_SPANS",
] as const;

const required = (environment: EffectE2eEnvironment, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the Effect E2E lane.`);
  }
  return value;
};

const parseUrl = (name: string, value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTP(S).`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials.`);
  }
  return parsed.origin;
};

const parseDatabaseUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("EFFECT_E2E_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("EFFECT_E2E_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (!parsed.hostname || parsed.pathname.length < 2) {
    throw new Error("EFFECT_E2E_DATABASE_URL must include a database name.");
  }
  return parsed.toString();
};

const requireAbsolutePath = (
  environment: EffectE2eEnvironment,
  name: string
): string => {
  const value = required(environment, name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
};

const assertOutsideWorkingTree = (name: string, candidate: string): void => {
  const relative = path.relative(process.cwd(), candidate);
  if (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  ) {
    throw new Error(`${name} must be outside the working tree.`);
  }
};

const readRunId = (artifactDir: string): string => {
  const runId = path.basename(artifactDir);
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/u.test(runId)) {
    throw new Error("EFFECT_E2E_ARTIFACT_DIR must end in a safe run id.");
  }
  return runId;
};

export const readEffectE2eConfig = (
  environment: EffectE2eEnvironment = process.env
): EffectE2eConfig => {
  if (environment.EFFECT_E2E_DISPOSABLE_DB !== "1") {
    throw new Error(
      "Refusing Effect E2E seed/check without EFFECT_E2E_DISPOSABLE_DB=1."
    );
  }
  if (environment.EFFECT_E2E_SYNTHETIC !== "1") {
    throw new Error("Refusing Effect E2E without EFFECT_E2E_SYNTHETIC=1.");
  }
  for (const flag of REQUIRED_EFFECT_FLAGS) {
    if (environment[flag] !== "1") {
      throw new Error(`Refusing Effect E2E without ${flag}=1.`);
    }
  }
  if (environment.NEXT_PUBLIC_USE_FIXTURES === "1") {
    throw new Error(
      "Effect E2E refuses NEXT_PUBLIC_USE_FIXTURES=1. Synthetic data must use real APIs."
    );
  }

  const artifactDir = requireAbsolutePath(
    environment,
    "EFFECT_E2E_ARTIFACT_DIR"
  );
  const privateDir = requireAbsolutePath(environment, "EFFECT_E2E_PRIVATE_DIR");
  assertOutsideWorkingTree("EFFECT_E2E_PRIVATE_DIR", privateDir);

  const canaryId = required(environment, "EFFECT_E2E_CANARY_ID").toLowerCase();
  if (!UUID_PATTERN.test(canaryId)) {
    throw new Error("EFFECT_E2E_CANARY_ID must be a UUID.");
  }
  const canaryDigest = required(
    environment,
    "EFFECT_E2E_CANARY_DIGEST"
  ).toLowerCase();
  if (!SHA256_PATTERN.test(canaryDigest)) {
    throw new Error("EFFECT_E2E_CANARY_DIGEST must be a SHA-256 digest.");
  }
  const databaseMarker = required(environment, "EFFECT_E2E_DB_MARKER");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,80}$/u.test(databaseMarker)) {
    throw new Error("EFFECT_E2E_DB_MARKER must be a safe non-secret marker.");
  }
  const expectedSha = required(
    environment,
    "EFFECT_E2E_EXPECTED_SHA"
  ).toLowerCase();
  if (!SHA_PATTERN.test(expectedSha)) {
    throw new Error("EFFECT_E2E_EXPECTED_SHA must be a 40-character Git SHA.");
  }

  return {
    apiUrl: parseUrl(
      "EFFECT_E2E_API_URL",
      required(environment, "EFFECT_E2E_API_URL")
    ),
    artifactDir,
    baseUrl: parseUrl(
      "EFFECT_E2E_BASE_URL",
      required(environment, "EFFECT_E2E_BASE_URL")
    ),
    canaryDigest,
    canaryId,
    databaseMarker,
    databaseName: required(environment, "EFFECT_E2E_DATABASE_NAME"),
    databaseUrl: parseDatabaseUrl(
      required(environment, "EFFECT_E2E_DATABASE_URL")
    ),
    expectedSha,
    privateDir,
    runId: readRunId(artifactDir),
  };
};

export const canaryQuery = (canaryId: string): string =>
  `EFFECTE2E${canaryId.slice(0, 8).toUpperCase()}`;

export const privateAuthPath = (
  environment: EffectE2eEnvironment,
  privateDir: string
): string => {
  const configured = environment.EFFECT_E2E_AUTH_FILE?.trim();
  const authPath = configured
    ? path.normalize(configured)
    : path.join(privateDir, "auth.json");
  if (!path.isAbsolute(authPath)) {
    throw new Error("EFFECT_E2E_AUTH_FILE must be an absolute path.");
  }
  assertOutsideWorkingTree("EFFECT_E2E_AUTH_FILE", authPath);
  return authPath;
};
