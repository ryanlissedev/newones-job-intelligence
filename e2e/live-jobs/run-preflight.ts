import {
  assertAnonymousLiveRun,
  assertAuthenticatedLiveRun,
  assertMutationLiveRun,
} from "./config";
import type {
  LiveJobsConfig,
  LiveJobsEnvironment,
  MutationLiveJobsConfig,
} from "./config";
import { preflightLiveJobsCleanup } from "./mutation-cleanup";
import type { MutationCleanupBaseline } from "./mutation-cleanup";
import { preflightReleaseIdentity } from "./release-preflight";
import {
  assertExpectedSessionSubject,
  assertMutationSessionSubject,
  verifyAuthenticatedSession,
} from "./session-verifier";
import type {
  AuthenticatedSessionVerifier,
  AuthenticatedSession,
} from "./session-verifier";

export type LiveJobsRunMode = "anonymous" | "session" | "writes";

export interface LiveJobsRunPreflightDependencies {
  readonly cleanupPreflight?: (
    config: MutationLiveJobsConfig
  ) => Promise<MutationCleanupBaseline>;
  readonly releasePreflight?: (config: LiveJobsConfig) => Promise<void>;
  readonly sessionVerifier?: AuthenticatedSessionVerifier;
}

export interface LiveJobsRunPreflightResult {
  readonly cleanupBaseline?: MutationCleanupBaseline;
  readonly config: LiveJobsConfig;
  readonly session?: AuthenticatedSession;
}

/**
 * The browser is launched only after release identity, session subject, and
 * (for writes) baseline-preserving cleanup gates succeed. Unit tests inject safe fake
 * gates. The default verifier uses only the narrowly authorized Better Auth
 * cookie-to-configured-API preflight.
 */
export const preflightLiveJobsRun = async (
  mode: LiveJobsRunMode,
  environment: LiveJobsEnvironment = process.env,
  dependencies: LiveJobsRunPreflightDependencies = {}
): Promise<LiveJobsRunPreflightResult> => {
  const releasePreflight =
    dependencies.releasePreflight ?? preflightReleaseIdentity;
  const sessionVerifier =
    dependencies.sessionVerifier ?? verifyAuthenticatedSession;

  if (mode === "anonymous") {
    const config = assertAnonymousLiveRun(environment);
    await releasePreflight(config);
    return { config };
  }

  if (mode === "session") {
    const config = assertAuthenticatedLiveRun(environment);
    await releasePreflight(config);
    const session = await sessionVerifier(config);
    assertExpectedSessionSubject(config, session);
    return { config, session };
  }

  const config = assertMutationLiveRun(environment);
  await releasePreflight(config);
  const session = await sessionVerifier(config);
  assertMutationSessionSubject(config, session);
  const cleanupBaseline = await (
    dependencies.cleanupPreflight ?? preflightLiveJobsCleanup
  )(config);
  return { cleanupBaseline, config, session };
};
