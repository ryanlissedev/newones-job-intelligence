import path from "node:path";

export type LiveJobsEnvironment = Readonly<Record<string, string | undefined>>;

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

const TEST_HOST_SUFFIXES = [".invalid", ".local", ".test"] as const;
const FIXTURE_VALUES = new Set(["1", "true"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TEST_NAMESPACE_PATTERN = /^e2e-[a-z0-9][a-z0-9-]{2,60}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LiveJobsConfig {
  readonly apiUrl: string;
  readonly baseUrl: string;
  readonly expectedReleaseSha: string;
  readonly localMode: boolean;
  readonly query: string;
  readonly timeoutMs: number;
}

export interface AuthenticatedLiveJobsConfig extends LiveJobsConfig {
  readonly canaryDigest: string;
  readonly canaryId: string;
  readonly expectedSubjectId: string;
  readonly storageStatePath: string;
}

export interface MutationLiveJobsConfig extends AuthenticatedLiveJobsConfig {
  readonly cleanupToken: string;
  readonly cleanupUrl: string;
  readonly testAccountId: string;
  readonly testNamespace: string;
}

const value = (
  environment: LiveJobsEnvironment,
  name: string
): string | undefined => environment[name]?.trim();

const requireValue = (
  environment: LiveJobsEnvironment,
  name: string
): string => {
  const configured = value(environment, name);
  if (!configured) {
    throw new Error(`${name} is required for the live jobs E2E run.`);
  }
  return configured;
};

const isEnabled = (configured: string | undefined): boolean =>
  configured === "1";

const usesFixtures = (configured: string | undefined): boolean =>
  configured ? FIXTURE_VALUES.has(configured.toLowerCase()) : false;

const parseUrl = (name: string, configured: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials.`);
  }
  return parsed;
};

const parseOriginUrl = (name: string, configured: string): URL => {
  const parsed = parseUrl(name, configured);
  if (parsed.hash || parsed.pathname !== "/" || parsed.search) {
    throw new Error(
      `${name} must be an origin URL without a path, query, or hash.`
    );
  }
  return parsed;
};

export const isLocalHost = (hostname: string): boolean =>
  LOCAL_HOSTNAMES.has(hostname.toLowerCase());

export const isTestHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return (
    isLocalHost(normalized) ||
    TEST_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
};

const parseTimeout = (configured: string | undefined): number => {
  if (!configured) {
    return 30_000;
  }
  if (!/^\d+$/u.test(configured)) {
    throw new Error("E2E_TIMEOUT_MS must be a whole number of milliseconds.");
  }
  const parsed = Number(configured);
  if (parsed < 1000 || parsed > 60_000) {
    throw new Error("E2E_TIMEOUT_MS must be between 1000 and 60000.");
  }
  return parsed;
};

const readExpectedReleaseSha = (environment: LiveJobsEnvironment): string => {
  const expectedReleaseSha = requireValue(
    environment,
    "E2E_EXPECTED_RELEASE_SHA"
  ).toLowerCase();
  if (!SHA_PATTERN.test(expectedReleaseSha)) {
    throw new Error(
      "E2E_EXPECTED_RELEASE_SHA must be an exact 40-character lowercase Git SHA."
    );
  }
  return expectedReleaseSha;
};

const readCanaryId = (environment: LiveJobsEnvironment): string => {
  const canaryId = requireValue(environment, "E2E_CANARY_ID");
  if (!UUID_PATTERN.test(canaryId)) {
    throw new Error("E2E_CANARY_ID must be an immutable UUID.");
  }
  return canaryId.toLowerCase();
};

const readCanaryDigest = (environment: LiveJobsEnvironment): string => {
  const digest = requireValue(environment, "E2E_CANARY_DIGEST");
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(
      "E2E_CANARY_DIGEST must be an exact lowercase SHA-256 digest."
    );
  }
  return digest;
};

const readExpectedSubjectId = (environment: LiveJobsEnvironment): string => {
  const expectedSubjectId = requireValue(
    environment,
    "E2E_EXPECTED_SUBJECT_ID"
  );
  if (expectedSubjectId.length > 200) {
    throw new Error("E2E_EXPECTED_SUBJECT_ID must be at most 200 characters.");
  }
  return expectedSubjectId;
};

const validateEndpointSafety = (
  baseUrl: URL,
  apiUrl: URL,
  localMode: boolean,
  environment: LiveJobsEnvironment
): void => {
  if (usesFixtures(value(environment, "NEXT_PUBLIC_USE_FIXTURES"))) {
    throw new Error(
      "Live jobs E2E refuses NEXT_PUBLIC_USE_FIXTURES. It never accepts fixture or mock evidence."
    );
  }

  const endpoints = [
    ["E2E_BASE_URL", baseUrl],
    ["E2E_API_URL", apiUrl],
  ] as const;

  if (localMode) {
    for (const [name, endpoint] of endpoints) {
      if (!isLocalHost(endpoint.hostname)) {
        throw new Error(
          `${name} must use a localhost address when E2E_LOCAL_MODE=1.`
        );
      }
    }
    return;
  }

  for (const [name, endpoint] of endpoints) {
    if (isTestHost(endpoint.hostname)) {
      throw new Error(
        `${name} points at a test host. Set E2E_LOCAL_MODE=1 for an explicit local run.`
      );
    }
    if (endpoint.protocol !== "https:") {
      throw new Error(`${name} must use HTTPS outside E2E_LOCAL_MODE=1.`);
    }
  }
};

export const readLiveJobsConfig = (
  environment: LiveJobsEnvironment = process.env
): LiveJobsConfig => {
  const baseUrl = parseOriginUrl(
    "E2E_BASE_URL",
    requireValue(environment, "E2E_BASE_URL")
  );
  const apiUrl = parseOriginUrl(
    "E2E_API_URL",
    requireValue(environment, "E2E_API_URL")
  );
  const query = value(environment, "E2E_QUERY") ?? "";
  const localMode = isEnabled(value(environment, "E2E_LOCAL_MODE"));

  validateEndpointSafety(baseUrl, apiUrl, localMode, environment);

  return {
    apiUrl: apiUrl.origin,
    baseUrl: baseUrl.origin,
    expectedReleaseSha: readExpectedReleaseSha(environment),
    localMode,
    query,
    timeoutMs: parseTimeout(value(environment, "E2E_TIMEOUT_MS")),
  };
};

export const assertReadOnlyLiveRun = (
  environment: LiveJobsEnvironment = process.env
): LiveJobsConfig => {
  if (!isEnabled(value(environment, "E2E_LIVE"))) {
    throw new Error("Refusing live jobs E2E: set E2E_LIVE=1 explicitly.");
  }
  return readLiveJobsConfig(environment);
};

const requireStorageState = (environment: LiveJobsEnvironment): string => {
  const storageStatePath = requireValue(environment, "E2E_STORAGE_STATE");
  const relativeToWorkingTree = path.relative(process.cwd(), storageStatePath);
  const isOutsideWorkingTree =
    relativeToWorkingTree === ".." ||
    relativeToWorkingTree.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToWorkingTree);
  if (!path.isAbsolute(storageStatePath) || !isOutsideWorkingTree) {
    throw new Error(
      "E2E_STORAGE_STATE must be an absolute path outside the working tree."
    );
  }
  return storageStatePath;
};

export const assertAuthenticatedLiveRun = (
  environment: LiveJobsEnvironment = process.env
): AuthenticatedLiveJobsConfig => {
  const config = assertReadOnlyLiveRun(environment);
  if (value(environment, "E2E_AUTH_MODE") !== "session") {
    throw new Error(
      "Authenticated live jobs E2E requires E2E_AUTH_MODE=session explicitly."
    );
  }
  if (!config.query) {
    throw new Error("Authenticated live jobs E2E requires E2E_QUERY.");
  }
  if (value(environment, "E2E_DATA_MODE") !== "canary") {
    throw new Error(
      "Authenticated live jobs E2E requires E2E_DATA_MODE=canary so artifacts never contain production business data."
    );
  }

  return {
    ...config,
    canaryDigest: readCanaryDigest(environment),
    canaryId: readCanaryId(environment),
    expectedSubjectId: readExpectedSubjectId(environment),
    storageStatePath: requireStorageState(environment),
  };
};

export const assertAnonymousLiveRun = (
  environment: LiveJobsEnvironment = process.env
): LiveJobsConfig => {
  const config = assertReadOnlyLiveRun(environment);
  if (value(environment, "E2E_AUTH_MODE") !== "anonymous") {
    throw new Error(
      "Anonymous live jobs E2E requires E2E_AUTH_MODE=anonymous explicitly."
    );
  }
  if (value(environment, "E2E_STORAGE_STATE")) {
    throw new Error(
      "Anonymous live jobs E2E refuses E2E_STORAGE_STATE so the proof is genuinely unauthenticated."
    );
  }
  return config;
};

const parseCleanupUrl = (
  environment: LiveJobsEnvironment,
  apiUrl: string
): string => {
  const cleanupUrl = parseUrl(
    "E2E_CLEANUP_URL",
    requireValue(environment, "E2E_CLEANUP_URL")
  );
  if (cleanupUrl.hash || cleanupUrl.search) {
    throw new Error("E2E_CLEANUP_URL must not include a query or hash.");
  }
  if (cleanupUrl.origin !== new URL(apiUrl).origin) {
    throw new Error(
      "E2E_CLEANUP_URL must be on the configured E2E_API_URL origin."
    );
  }
  if (cleanupUrl.pathname !== "/e2e/cleanup") {
    throw new Error(
      "E2E_CLEANUP_URL must be the isolated /e2e/cleanup endpoint."
    );
  }
  return cleanupUrl.toString();
};

export const assertMutationLiveRun = (
  environment: LiveJobsEnvironment = process.env
): MutationLiveJobsConfig => {
  const config = assertAuthenticatedLiveRun(environment);
  if (!config.localMode) {
    throw new Error(
      "Live jobs mutation E2E only supports E2E_LOCAL_MODE=1 against an isolated local environment."
    );
  }
  if (!isEnabled(value(environment, "E2E_ALLOW_WRITES"))) {
    throw new Error(
      "Refusing mutation E2E: set E2E_ALLOW_WRITES=1 explicitly."
    );
  }
  if (value(environment, "E2E_TEST_ENV") !== "isolated") {
    throw new Error("Mutation E2E requires E2E_TEST_ENV=isolated.");
  }

  const testAccountId = requireValue(environment, "E2E_TEST_ACCOUNT_ID");
  if (testAccountId === "web-recruiter") {
    throw new Error("E2E_TEST_ACCOUNT_ID must be a dedicated test account.");
  }
  if (testAccountId !== config.expectedSubjectId) {
    throw new Error(
      "E2E_TEST_ACCOUNT_ID must exactly equal E2E_EXPECTED_SUBJECT_ID before mutation E2E can start."
    );
  }

  const testNamespace = requireValue(environment, "E2E_TEST_NAMESPACE");
  if (!TEST_NAMESPACE_PATTERN.test(testNamespace)) {
    throw new Error(
      "E2E_TEST_NAMESPACE must start with e2e- and contain only lowercase letters, numbers, and hyphens."
    );
  }

  return {
    ...config,
    cleanupToken: requireValue(environment, "E2E_CLEANUP_TOKEN"),
    cleanupUrl: parseCleanupUrl(environment, config.apiUrl),
    testAccountId,
    testNamespace,
  };
};

export const buildJobsUrl = (baseUrl: string): string =>
  new URL("/jobs", baseUrl).toString();

export const buildCanaryJobsUrl = (
  baseUrl: string,
  query: string,
  canaryId: string
): string => {
  const url = new URL("/jobs", baseUrl);
  url.searchParams.set("job", canaryId);
  url.searchParams.set("q", query);
  return url.toString();
};

export const buildNamespacedQuery = (
  namespace: string,
  query: string
): string => `("${namespace}" OR (${query}))`;
