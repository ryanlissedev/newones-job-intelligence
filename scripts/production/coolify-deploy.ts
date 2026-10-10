/* oxlint-disable eslint/complexity, eslint/max-classes-per-file, eslint/no-await-in-loop, unicorn/no-array-reverse, unicorn/no-array-sort, eslint/no-promise-executor-return, promise/avoid-new, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This driver parses untyped Coolify and public health payloads at guarded I/O boundaries. Deployment, rollback, cancellation, and polling awaits must remain serial to preserve the release ordering and mutation invariants. */
import { readFile, writeFile } from "node:fs/promises";
import { exit } from "node:process";

import { isReleaseLedgerEntry } from "./release-gate";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TERMINAL_SUCCESS = new Set([
  "completed",
  "done",
  "finished",
  "success",
  "successful",
]);
const TERMINAL_FAILURE = new Set([
  "cancelled",
  "canceled",
  "cancelled-by-user",
  "error",
  "failed",
  "failure",
  "stopped",
]);
const ACTIVE_STATES = new Set([
  "building",
  "deploying",
  "in_progress",
  "pending",
  "queued",
  "running",
  "waiting",
]);
const HEALTHY_APPLICATION_STATES = new Set(["healthy", "running:healthy"]);
// Coolify 4.3.19 writes plain `running` immediately after its own health check
// passes. Its Application model serializes that DB value as `running:unhealthy`
// until the asynchronous server-status aggregation writes `running:healthy`. This
// post-finished convergence loop therefore treats it as transient, not terminal.
const TRANSIENT_APPLICATION_STATES = new Set([
  "running",
  "running:unknown",
  "running:unhealthy",
  "starting",
]);
const OBSERVED_APPLICATION_STATES = new Set([
  ...HEALTHY_APPLICATION_STATES,
  ...TRANSIENT_APPLICATION_STATES,
  "degraded:unhealthy",
  "exited:unhealthy",
  "paused:unknown",
  "restarting:unknown",
  "starting:unhealthy",
]);
const safeApplicationStatus = (status: string): string =>
  OBSERVED_APPLICATION_STATES.has(status) ? status : "unknown";
const APPLICATION_HEALTH_CONVERGENCE_MS = 90_000;

export type FetchInput = Request | string | URL;

export type FetchLike = (
  input: FetchInput,
  init?: RequestInit
) => Promise<Response>;

export type Role = "server" | "web" | "projector";
export const DEPLOYMENT_ORDER: readonly Role[] = ["server", "web", "projector"];
export const rollbackOrder = <T>(items: readonly T[]): readonly T[] =>
  [...items].reverse();

export interface CoolifyConfig {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly candidateSha: string;
  readonly repository: string;
  readonly applicationUuids: Readonly<Record<Role, string>>;
  readonly apiPublicUrl: string;
  readonly webPublicUrl: string;
  readonly projectorSchemaHash: string;
  readonly githubToken: string;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  /** Absolute wall-clock budget for the complete sequence, including rollback. */
  readonly deadlineMs?: number;
  /** Time reserved for cancelling an active deployment and rolling back. */
  readonly rollbackReserveMs?: number;
  readonly nowImpl?: () => number;
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly sleepImpl?: (milliseconds: number) => Promise<void>;
  /** Optional same-origin web runtime identity endpoint. */
  readonly webVersionUrl?: string;
  /** Optional projector runtime evidence endpoint. */
  readonly projectorRuntimeUrl?: string;
  /** JSON output written by the read-only release gate in the preceding step. */
  readonly releaseEvidenceFile?: string;
  readonly lastDeployedRelease?: TrustedReleaseBaseline;
}

export interface TrustedReleaseBaseline {
  readonly source: "trusted-complete-release";
  readonly repository: string;
  readonly releaseId: string;
  readonly releaseSha: string;
  readonly componentShas: Readonly<Record<Role, string>>;
  readonly verifiedAt: string;
}

interface ReleaseGateEvidence {
  readonly candidateSha: string;
  readonly workflows: readonly unknown[];
  readonly pullRequests: readonly unknown[];
}

interface ReleaseGateModule {
  readonly revalidateReleaseEvidence?: (
    gateConfig: {
      readonly candidateSha: string;
      readonly repository: string;
      readonly token: string;
      readonly lastDeployedRelease?: TrustedReleaseBaseline;
    },
    expected: ReleaseGateEvidence
  ) => Promise<unknown>;
}

interface ApplicationRecord {
  readonly uuid?: string;
  readonly git_commit_sha?: string | null;
  readonly status?: string | null;
}

export class DeploymentError extends Error {
  readonly code: string;
  readonly role?: Role;

  constructor(code: string, message: string, role?: Role) {
    super(`${code}: ${message}`);
    this.name = "DeploymentError";
    this.code = code;
    this.role = role;
  }
}

export interface DeploymentRecord {
  readonly status?: string;
  readonly commit?: string;
  readonly commit_sha?: string;
  readonly git_commit_sha?: string;
  readonly source_commit?: string;
  readonly created_at?: string;
}

export const extractLatestFinishedDeploymentSha = (
  records: readonly DeploymentRecord[],
  role: Role
): string => {
  const finished = records.filter((record) => record.status === "finished");
  let latest: DeploymentRecord | undefined;
  for (const record of finished) {
    if (
      !latest ||
      (record.created_at ?? "").localeCompare(latest.created_at ?? "") > 0
    ) {
      latest = record;
    }
  }
  const commits = [
    latest?.commit,
    latest?.commit_sha,
    latest?.git_commit_sha,
    latest?.source_commit,
  ].filter(
    (commit): commit is string =>
      typeof commit === "string" && SHA_PATTERN.test(commit)
  );
  const [commit] = commits;
  if (commit === undefined) {
    throw new DeploymentError(
      "runtime_identity_missing",
      `${role} deployment history did not expose the latest finished full commit SHA`,
      role
    );
  }
  if (new Set(commits).size !== 1) {
    throw new DeploymentError(
      "runtime_identity_ambiguous",
      `${role} latest finished deployment exposed conflicting commit SHAs`,
      role
    );
  }
  return commit;
};

interface DeploymentStartEntry {
  readonly resource_uuid?: string;
  readonly deployment_uuid?: string;
}

interface Readiness {
  readonly status?: string;
  readonly components?: Record<string, unknown>;
}

interface Deadline {
  readonly at: number;
  readonly rollbackReserveMs: number;
  readonly now: () => number;
}

const remainingBudget = (deadline: Deadline): number =>
  Math.max(0, deadline.at - deadline.now());

const requireBudget = (
  deadline: Deadline,
  requiredMs: number,
  role?: Role
): void => {
  if (remainingBudget(deadline) < requiredMs) {
    throw new DeploymentError(
      "deployment_deadline_exhausted",
      "the absolute deployment deadline does not leave the required rollback reserve",
      role
    );
  }
};

export interface DeploymentEvidence {
  readonly role: Role;
  readonly applicationUuid: string;
  readonly deploymentUuid: string;
  readonly previousSha: string;
  readonly candidateSha: string;
  readonly deploymentStatus: string;
}

const requireSha = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new DeploymentError(
      "invalid_sha",
      `${name} must be a full lowercase 40-character SHA`
    );
  }
  return value;
};

const asObject = (value: unknown, context: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeploymentError(
      "malformed_response",
      `${context} was not an object`
    );
  }
  return value as Record<string, unknown>;
};

const parseJson = async (
  response: Response,
  context: string
): Promise<unknown> => {
  if (!response.ok) {
    throw new DeploymentError(
      "coolify_api_error",
      `${context} returned HTTP ${response.status}`
    );
  }
  try {
    return await response.json();
  } catch {
    throw new DeploymentError(
      "malformed_response",
      `${context} returned invalid JSON`
    );
  }
};

const trimUrl = (value: string): string => value.replace(/\/$/u, "");

const safeReason = (error: unknown): string => {
  if (error instanceof DeploymentError) {
    return error.code;
  }
  return "unexpected_failure";
};

const assertReleaseEvidence = async (config: CoolifyConfig): Promise<void> => {
  if (!config.releaseEvidenceFile) {
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(
      await readFile(config.releaseEvidenceFile, { encoding: "utf-8" })
    );
  } catch {
    throw new DeploymentError(
      "release_evidence_missing",
      "the trusted release-gate evidence could not be read"
    );
  }
  const value = asObject(body, "release-gate evidence");
  const evidence = (value.evidence ?? value) as ReleaseGateEvidence;
  if (
    value.result === "block" ||
    evidence.candidateSha !== config.candidateSha ||
    !Array.isArray(evidence.workflows) ||
    !Array.isArray(evidence.pullRequests)
  ) {
    throw new DeploymentError(
      "release_evidence_invalid",
      "trusted release-gate evidence did not match the candidate"
    );
  }
  const gateModule = await import("./release-gate");
  const gate = gateModule as ReleaseGateModule;
  if (typeof gate.revalidateReleaseEvidence !== "function") {
    throw new DeploymentError(
      "release_evidence_invalid",
      "the release gate did not expose evidence revalidation"
    );
  }
  if (!config.lastDeployedRelease) {
    throw new DeploymentError(
      "release_evidence_missing",
      "the deploy driver did not receive the trusted complete-release baseline"
    );
  }
  try {
    await gate.revalidateReleaseEvidence(
      {
        candidateSha: config.candidateSha,
        lastDeployedRelease: config.lastDeployedRelease,
        repository: config.repository,
        token: config.githubToken,
      },
      evidence
    );
  } catch {
    throw new DeploymentError(
      "release_evidence_stale",
      "trusted release-gate evidence failed its recheck before the first mutation"
    );
  }
};

const assertTrustedReleaseLedger = async (
  config: CoolifyConfig
): Promise<void> => {
  const baseline = config.lastDeployedRelease;
  if (!baseline) {
    return;
  }
  if (
    baseline.source !== "trusted-complete-release" ||
    baseline.repository !== config.repository ||
    baseline.releaseId.trim().length === 0 ||
    Number.isNaN(Date.parse(baseline.verifiedAt))
  ) {
    throw new DeploymentError(
      "release_baseline_invalid",
      "the complete-release baseline metadata was malformed or untrusted"
    );
  }
  requireSha(baseline.releaseSha, "trusted release baseline SHA");
  for (const role of DEPLOYMENT_ORDER) {
    requireSha(baseline.componentShas[role], `trusted ${role} baseline SHA`);
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const deploymentResponse = await fetchImpl(
    `https://api.github.com/repos/${config.repository}/deployments/${encodeURIComponent(baseline.releaseId)}`,
    { headers, signal: AbortSignal.timeout(30_000) }
  );
  if (!deploymentResponse.ok) {
    throw new DeploymentError(
      "release_baseline_unreadable",
      "the trusted release ledger entry could not be read"
    );
  }
  const deployment = asObject(
    await deploymentResponse.json(),
    "trusted release ledger"
  );
  if (
    deployment.environment !== "production" ||
    deployment.sha !== baseline.releaseSha ||
    !isReleaseLedgerEntry(deployment)
  ) {
    throw new DeploymentError(
      "release_baseline_mismatch",
      "the trusted release ledger entry did not match its complete baseline"
    );
  }
  const statusResponse = await fetchImpl(
    `https://api.github.com/repos/${config.repository}/deployments/${encodeURIComponent(baseline.releaseId)}/statuses?per_page=100`,
    { headers, signal: AbortSignal.timeout(30_000) }
  );
  if (!statusResponse.ok) {
    throw new DeploymentError(
      "release_baseline_unreadable",
      "the trusted release ledger status could not be read"
    );
  }
  const statuses = await statusResponse.json();
  if (
    !Array.isArray(statuses) ||
    statuses[0] === null ||
    typeof statuses[0] !== "object" ||
    Array.isArray(statuses[0]) ||
    (statuses[0] as Record<string, unknown>).state !== "success"
  ) {
    throw new DeploymentError(
      "release_baseline_not_successful",
      "the trusted release ledger does not have a successful terminal status"
    );
  }
};

export const nextReleaseBaseline = (
  evidence: readonly DeploymentEvidence[],
  context: {
    readonly candidateSha: string;
    readonly deploymentId: string;
    readonly repository: string;
    readonly verifiedAt: string;
  }
): TrustedReleaseBaseline => {
  if (context.deploymentId.trim().length === 0) {
    throw new DeploymentError(
      "release_baseline_unwritable",
      "the production deployment id was not available for baseline rotation"
    );
  }
  if (context.repository.trim().length === 0) {
    throw new DeploymentError(
      "release_baseline_unwritable",
      "the repository was not available for baseline rotation"
    );
  }
  if (Number.isNaN(Date.parse(context.verifiedAt))) {
    throw new DeploymentError(
      "release_baseline_unwritable",
      "the rotation timestamp was malformed"
    );
  }
  const componentSha = (role: Role): string => {
    const entry = evidence.find((item) => item.role === role);
    if (!entry) {
      throw new DeploymentError(
        "release_baseline_unwritable",
        `${role} produced no deployment evidence for baseline rotation`,
        role
      );
    }
    return requireSha(entry.candidateSha, `rotated ${role} baseline SHA`);
  };
  return {
    componentShas: {
      projector: componentSha("projector"),
      server: componentSha("server"),
      web: componentSha("web"),
    },
    releaseId: context.deploymentId,
    releaseSha: requireSha(context.candidateSha, "rotated baseline SHA"),
    repository: context.repository,
    source: "trusted-complete-release",
    verifiedAt: context.verifiedAt,
  };
};

class CoolifyApi {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly requestTimeoutMs: number;

  constructor(config: CoolifyConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = trimUrl(config.apiBaseUrl);
    this.requestTimeoutMs = 30_000;
    this.headers = {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  async get(
    path: string,
    context = path,
    timeoutMs = this.requestTimeoutMs
  ): Promise<unknown> {
    const requestTimeoutMs = Math.max(
      1,
      Math.min(this.requestTimeoutMs, timeoutMs)
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new DeploymentError(
        "coolify_transport_error",
        `${context} could not be reached`
      );
    }
    return parseJson(response, context);
  }

  async patch(
    path: string,
    body: Record<string, unknown>,
    context = path
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: this.headers,
        method: "PATCH",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new DeploymentError(
        "coolify_transport_error",
        `${context} could not be reached`
      );
    }
    return parseJson(response, context);
  }

  async post(
    path: string,
    body?: Record<string, unknown>,
    context = path
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: this.headers,
        method: "POST",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new DeploymentError(
        "coolify_transport_error",
        `${context} could not be reached`
      );
    }
    return parseJson(response, context);
  }
}

const rolePath = (uuid: string): string =>
  `/applications/${encodeURIComponent(uuid)}`;

const application = async (
  api: CoolifyApi,
  uuid: string,
  role: Role,
  timeoutMs?: number
): Promise<ApplicationRecord> => {
  const body = await api.get(rolePath(uuid), `${role} application`, timeoutMs);
  const value = asObject(body, `${role} application`);
  if (value.uuid !== uuid) {
    throw new DeploymentError(
      "application_identity_mismatch",
      `${role} application UUID did not match`,
      role
    );
  }
  return value as ApplicationRecord;
};

const waitForApplicationHealthy = async (
  api: CoolifyApi,
  uuid: string,
  role: Role,
  expectedSha: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleepImpl: (milliseconds: number) => Promise<void>,
  absoluteDeadlineAt: number,
  nowImpl: () => number
): Promise<ApplicationRecord> => {
  const deadline = Math.min(
    nowImpl() + Math.min(timeoutMs, APPLICATION_HEALTH_CONVERGENCE_MS),
    absoluteDeadlineAt
  );
  let lastStatus = "unknown";
  while (nowImpl() < deadline) {
    const remainingMs = deadline - nowImpl();
    if (remainingMs <= 0) {
      break;
    }
    const after = await application(api, uuid, role, Math.max(1, remainingMs));
    if (nowImpl() >= deadline) {
      break;
    }
    const status = safeApplicationStatus(after.status ?? "unknown");
    if (after.git_commit_sha !== expectedSha) {
      throw new DeploymentError(
        "application_readback_failed",
        `${
          role
        } application did not read back candidate and healthy; observed ${
          status
        }`,
        role
      );
    }
    if (HEALTHY_APPLICATION_STATES.has(status)) {
      return after;
    }
    if (!TRANSIENT_APPLICATION_STATES.has(status)) {
      throw new DeploymentError(
        "application_readback_failed",
        `${
          role
        } application did not read back candidate and healthy; observed ${
          status
        }`,
        role
      );
    }
    lastStatus = status;
    await sleepImpl(
      Math.min(pollIntervalMs, Math.max(0, deadline - nowImpl()))
    );
  }
  throw new DeploymentError(
    "application_readback_failed",
    `${role} application remained ${lastStatus} after deployment`,
    role
  );
};

const readActualDeployedSha = async (
  api: CoolifyApi,
  uuid: string,
  role: Role
): Promise<string> => {
  const body = await api.get(
    `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=100`,
    `${role} deployment history`
  );
  const root = asObject(body, `${role} deployment history`);
  if (!Array.isArray(root.deployments)) {
    throw new DeploymentError(
      "runtime_identity_missing",
      `${role} deployment history did not expose deployments`,
      role
    );
  }
  const records = root.deployments.map((record, index) => {
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record)
    ) {
      throw new DeploymentError(
        "malformed_response",
        `${role} deployment history record ${index} was malformed`,
        role
      );
    }
    return record as DeploymentRecord;
  });
  return extractLatestFinishedDeploymentSha(records, role);
};

export const extractDeploymentUuid = (
  body: unknown,
  resourceUuid: string
): string => {
  const value = asObject(body, "deploy response");
  if (!Array.isArray(value.deployments)) {
    throw new DeploymentError(
      "deployment_identity_missing",
      "Coolify deploy response did not return deployments"
    );
  }
  if (
    (value.deployments as unknown[]).some(
      (deployment) =>
        deployment === null ||
        typeof deployment !== "object" ||
        Array.isArray(deployment)
    )
  ) {
    throw new DeploymentError(
      "malformed_response",
      "Coolify deploy response contained malformed deployments"
    );
  }
  const deployments = value.deployments as DeploymentStartEntry[];
  const matches = deployments.filter(
    (deployment) => deployment.resource_uuid === resourceUuid
  );
  if (
    matches.length !== 1 ||
    typeof matches[0]?.deployment_uuid !== "string" ||
    matches[0].deployment_uuid.length < 8
  ) {
    throw new DeploymentError(
      "deployment_identity_missing",
      "Coolify deploy response did not return exactly one matching deployment UUID"
    );
  }
  return matches[0].deployment_uuid;
};

const extractDeploymentStatus = (body: unknown): string => {
  const value = asObject(body, "deployment detail");
  if (typeof value.status !== "string" || value.status.trim().length === 0) {
    throw new DeploymentError(
      "deployment_status_unreadable",
      "Coolify deployment detail did not expose status"
    );
  }
  return value.status.toLowerCase();
};

const extractDeploymentSha = (body: unknown): string => {
  const value = asObject(body, "deployment detail");
  const candidates = [
    value.commit,
    value.commit_sha,
    value.git_commit_sha,
    value.source_commit,
  ];
  const shas = candidates.filter(
    (candidate): candidate is string => typeof candidate === "string"
  );
  const valid = shas.filter((candidate) => SHA_PATTERN.test(candidate));
  const [sha] = valid;
  if (sha === undefined) {
    throw new DeploymentError(
      "deployment_identity_missing",
      "Coolify deployment detail did not expose a commit SHA"
    );
  }
  if (new Set(valid).size !== 1) {
    throw new DeploymentError(
      "deployment_identity_ambiguous",
      "Coolify deployment detail exposed conflicting commit SHAs"
    );
  }
  return sha;
};

const assertNoActiveDeployments = async (api: CoolifyApi): Promise<void> => {
  const body = await api.get("/deployments", "active deployments");
  if (!Array.isArray(body)) {
    throw new DeploymentError(
      "malformed_response",
      "Coolify active deployments response was not an array"
    );
  }
  if (body.length > 0) {
    throw new DeploymentError(
      "deployment_in_progress",
      "Coolify already has an active deployment"
    );
  }
};

const waitForDeployment = async (
  api: CoolifyApi,
  deploymentUuid: string,
  candidateSha: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleepImpl: (milliseconds: number) => Promise<void>,
  role: Role,
  absoluteDeadlineAt?: number,
  nowImpl: () => number = Date.now
): Promise<string> => {
  const deadline = Math.min(
    nowImpl() + timeoutMs,
    absoluteDeadlineAt ?? Number.POSITIVE_INFINITY
  );
  let lastStatus = "unknown";
  while (nowImpl() <= deadline) {
    const detail = await api.get(
      `/deployments/${encodeURIComponent(deploymentUuid)}`,
      `${role} deployment detail`
    );
    lastStatus = extractDeploymentStatus(detail);
    if (TERMINAL_FAILURE.has(lastStatus)) {
      throw new DeploymentError(
        "deployment_failed",
        `${role} deployment ended in ${lastStatus}`,
        role
      );
    }
    if (TERMINAL_SUCCESS.has(lastStatus)) {
      const deployedSha = extractDeploymentSha(detail);
      if (deployedSha !== candidateSha) {
        throw new DeploymentError(
          "deployment_sha_mismatch",
          `${role} deployment identity did not match candidate`,
          role
        );
      }
      return lastStatus;
    }
    if (!ACTIVE_STATES.has(lastStatus)) {
      throw new DeploymentError(
        "deployment_status_unknown",
        `${role} returned an unsupported deployment status`,
        role
      );
    }
    await sleepImpl(
      Math.min(pollIntervalMs, Math.max(0, deadline - nowImpl()))
    );
  }
  throw new DeploymentError(
    "deployment_timeout",
    `${role} deployment remained ${lastStatus} past the bounded timeout`,
    role
  );
};

const settleCancelledDeployment = async (
  api: CoolifyApi,
  deploymentUuid: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleepImpl: (milliseconds: number) => Promise<void>,
  role: Role,
  absoluteDeadlineAt?: number,
  nowImpl: () => number = Date.now
): Promise<void> => {
  const readTerminalStatus = async (): Promise<string> => {
    const detail = await api.get(
      `/deployments/${encodeURIComponent(deploymentUuid)}`,
      `${role} cancellation race detail`
    );
    return extractDeploymentStatus(detail);
  };
  try {
    await api.post(
      `/deployments/${encodeURIComponent(deploymentUuid)}/cancel`,
      undefined,
      `${role} cancel`
    );
  } catch {
    const status = await readTerminalStatus();
    if (TERMINAL_FAILURE.has(status) || TERMINAL_SUCCESS.has(status)) {
      return;
    }
    throw new DeploymentError(
      "rollback_deployment_active",
      `${role} deployment could not be cancelled while still ${status}`,
      role
    );
  }
  const deadline = Math.min(
    nowImpl() + timeoutMs,
    absoluteDeadlineAt ?? Number.POSITIVE_INFINITY
  );
  while (nowImpl() <= deadline) {
    const detail = await api.get(
      `/deployments/${encodeURIComponent(deploymentUuid)}`,
      `${role} cancelled deployment detail`
    );
    const status = extractDeploymentStatus(detail);
    if (TERMINAL_FAILURE.has(status) || TERMINAL_SUCCESS.has(status)) {
      return;
    }
    if (!ACTIVE_STATES.has(status)) {
      throw new DeploymentError(
        "deployment_status_unknown",
        `${role} returned an unsupported cancellation status`,
        role
      );
    }
    await sleepImpl(
      Math.min(pollIntervalMs, Math.max(0, deadline - nowImpl()))
    );
  }
  throw new DeploymentError(
    "rollback_deployment_active",
    `${role} deployment remained active past cancellation timeout`,
    role
  );
};

const assertMain = async (config: CoolifyConfig): Promise<void> => {
  const fetchImpl = config.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${config.repository}/git/ref/heads/main`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config.githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch {
    throw new DeploymentError(
      "main_readback_failed",
      "GitHub main readback could not be reached"
    );
  }
  if (!response.ok) {
    throw new DeploymentError(
      "main_readback_failed",
      `GitHub main readback returned HTTP ${response.status}`
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DeploymentError(
      "malformed_response",
      "GitHub main readback returned invalid JSON"
    );
  }
  const root = asObject(body, "GitHub main ref");
  const object = asObject(root.object, "GitHub main ref object");
  if (object.sha !== config.candidateSha) {
    throw new DeploymentError(
      "main_moved",
      "main no longer points at the candidate SHA"
    );
  }
};

const fetchPublic = async (
  config: CoolifyConfig,
  url: string,
  init?: RequestInit
): Promise<Response> => {
  try {
    return await (config.fetchImpl ?? fetch)(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    throw new DeploymentError(
      "public_readback_failed",
      "public endpoint could not be reached"
    );
  }
};

const readJsonPublic = async (
  response: Response,
  context: string
): Promise<Record<string, unknown>> => {
  if (!response.ok) {
    throw new DeploymentError(
      "public_readback_failed",
      `${context} returned HTTP ${response.status}`
    );
  }
  try {
    return asObject(await response.json(), context);
  } catch (error) {
    if (error instanceof DeploymentError) {
      throw error;
    }
    throw new DeploymentError(
      "public_readback_failed",
      `${context} returned invalid JSON`
    );
  }
};

const containsReason = (value: unknown, reason: string): boolean => {
  if (typeof value === "string") {
    return value === reason;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsReason(item, reason));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => containsReason(item, reason));
  }
  return false;
};

const validateServer = async (
  config: CoolifyConfig,
  expectedSha: string
): Promise<void> => {
  const apiBase = trimUrl(config.apiPublicUrl);
  const version = await fetchPublic(config, `${apiBase}/version`);
  const versionBody = await readJsonPublic(version, "public /version");
  if (versionBody.releaseSha !== expectedSha) {
    throw new DeploymentError(
      "version_sha_mismatch",
      "public /version did not match expected release",
      "server"
    );
  }
  const live = await fetchPublic(config, `${apiBase}/livez`);
  if (live.status !== 200) {
    throw new DeploymentError(
      "liveness_failed",
      "public /livez was not HTTP 200",
      "server"
    );
  }
  const ready = await fetchPublic(config, `${apiBase}/readyz`);
  const readiness = (await readJsonPublic(
    ready,
    "public /readyz"
  )) as Readiness;
  if (
    readiness.status !== "ready" ||
    containsReason(readiness, "migration_mismatch") ||
    containsReason(readiness, "schema_hash_mismatch") ||
    containsReason(readiness, "unavailable")
  ) {
    throw new DeploymentError(
      "readiness_failed",
      "public /readyz was not fully ready",
      "server"
    );
  }
};

const validateWeb = async (
  config: CoolifyConfig,
  expectedSha: string
): Promise<void> => {
  const webBase = trimUrl(config.webPublicUrl);
  if (config.webVersionUrl) {
    const version = await fetchPublic(
      config,
      trimUrl(config.webVersionUrl).startsWith("http")
        ? trimUrl(config.webVersionUrl)
        : `${webBase}/${config.webVersionUrl.replace(/^\//u, "")}`
    );
    const versionBody = await readJsonPublic(version, "public web /version");
    if (versionBody.releaseSha !== expectedSha) {
      throw new DeploymentError(
        "version_sha_mismatch",
        "public web /version did not match expected release",
        "web"
      );
    }
  }
  const home = await fetchPublic(config, `${webBase}/`, { redirect: "manual" });
  if (home.status !== 200) {
    throw new DeploymentError(
      "web_readback_failed",
      "public web root was not HTTP 200",
      "web"
    );
  }
  const dashboard = await fetchPublic(config, `${webBase}/dashboard`, {
    redirect: "manual",
  });
  if (dashboard.status !== 307) {
    throw new DeploymentError(
      "web_readback_failed",
      "unauthenticated /dashboard did not redirect with HTTP 307",
      "web"
    );
  }
  const location = dashboard.headers.get("location");
  if (!location) {
    throw new DeploymentError(
      "web_readback_failed",
      "unauthenticated /dashboard did not expose a login location",
      "web"
    );
  }
  let redirect: URL;
  try {
    redirect = new URL(location, `${webBase}/dashboard`);
  } catch {
    throw new DeploymentError(
      "web_readback_failed",
      "unauthenticated /dashboard returned an invalid location",
      "web"
    );
  }
  if (
    redirect.origin !== new URL(webBase).origin ||
    redirect.pathname !== "/login"
  ) {
    throw new DeploymentError(
      "web_readback_failed",
      "unauthenticated /dashboard redirected outside the web origin or to the wrong path",
      "web"
    );
  }
};

/**
 * A rolling projector deploy reports healthy while the replacement container
 * is still waiting for the outgoing one's advisory lock, so for a few seconds
 * the runtime row still carries the previous container and SHA (or no fresh
 * row at all). Those are the transient states worth re-reading; everything
 * else stays a single-shot failure.
 */
const PROJECTOR_RUNTIME_RETRY_WINDOW_MS = 90_000;
const PROJECTOR_RUNTIME_RETRY_INTERVAL_MS = 5000;
const PROJECTOR_RUNTIME_RETRY_ATTEMPTS =
  Math.floor(
    PROJECTOR_RUNTIME_RETRY_WINDOW_MS / PROJECTOR_RUNTIME_RETRY_INTERVAL_MS
  ) + 1;
const PROJECTOR_RUNTIME_RETRYABLE_REASONS = new Set([
  "heartbeat_stale",
  "runtime_missing",
]);

const retryableRuntimeReason = async (response: {
  json: () => Promise<unknown>;
}): Promise<string | undefined> => {
  try {
    const body = await response.json();
    const { reason } = asObject(body, "projector runtime evidence");
    return typeof reason === "string" &&
      PROJECTOR_RUNTIME_RETRYABLE_REASONS.has(reason)
      ? reason
      : undefined;
  } catch {
    return undefined;
  }
};

/** Resolves the readback's failure, or `undefined` when the evidence matches. */
const probeProjectorRuntime = async (
  config: CoolifyConfig,
  runtimeUrl: string,
  expectedSha: string
): Promise<DeploymentError | undefined> => {
  const runtime = await fetchPublic(config, runtimeUrl);
  if (runtime.status === 503) {
    const reason = await retryableRuntimeReason(runtime.clone());
    if (reason !== undefined) {
      return new DeploymentError(
        "public_readback_failed",
        `projector runtime evidence returned HTTP ${runtime.status}`
      );
    }
  }
  const runtimeBody = await readJsonPublic(
    runtime,
    "projector runtime evidence"
  );
  const { active } = runtimeBody;
  const container = runtimeBody.containerId ?? runtimeBody.container_id;
  const cycle = runtimeBody.cycle ?? runtimeBody.cycleCount;
  const { heartbeatFresh } = runtimeBody;
  const cycleNumber = typeof cycle === "number" ? cycle : null;
  if (
    runtimeBody.releaseSha !== expectedSha ||
    active !== true ||
    typeof container !== "string" ||
    container.length === 0 ||
    cycleNumber === null ||
    !Number.isSafeInteger(cycleNumber) ||
    cycleNumber < 1 ||
    heartbeatFresh !== true
  ) {
    return new DeploymentError(
      "projector_runtime_mismatch",
      "projector runtime evidence did not identify an active candidate container with a fresh heartbeat",
      "projector"
    );
  }
  return undefined;
};

const awaitProjectorRuntime = async (
  config: CoolifyConfig,
  runtimeUrl: string,
  expectedSha: string
): Promise<void> => {
  const sleepImpl =
    config.sleepImpl ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (
    let attempt = 0;
    attempt < PROJECTOR_RUNTIME_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    // oxlint-disable-next-line no-await-in-loop -- the readback is a poll; attempts are sequential by design
    const failure = await probeProjectorRuntime(
      config,
      runtimeUrl,
      expectedSha
    );
    if (!failure) {
      return;
    }
    if (attempt === PROJECTOR_RUNTIME_RETRY_ATTEMPTS - 1) {
      throw failure;
    }
    // oxlint-disable-next-line no-await-in-loop -- the poll interval must elapse before the next readback
    await sleepImpl(PROJECTOR_RUNTIME_RETRY_INTERVAL_MS);
  }
};

const validateProjector = async (
  config: CoolifyConfig,
  expectedSha: string
): Promise<void> => {
  const ready = await fetchPublic(
    config,
    `${trimUrl(config.apiPublicUrl)}/readyz`
  );
  const readiness = (await readJsonPublic(
    ready,
    "projector /readyz"
  )) as Readiness;
  const projection = readiness.components?.searchProjection;
  if (
    readiness.status !== "ready" ||
    !projection ||
    typeof projection !== "object"
  ) {
    throw new DeploymentError(
      "projector_readback_failed",
      "projector readiness was not available",
      "projector"
    );
  }
  const component = projection as Record<string, unknown>;
  if (
    component.status !== "ok" ||
    component.schemaHash !== config.projectorSchemaHash
  ) {
    throw new DeploymentError(
      "projector_schema_mismatch",
      "projector readiness did not expose the expected schema hash",
      "projector"
    );
  }
  if (config.projectorRuntimeUrl) {
    await awaitProjectorRuntime(
      config,
      trimUrl(config.projectorRuntimeUrl),
      expectedSha
    );
  }
};

const validatePublic = async (
  config: CoolifyConfig,
  role: Role,
  expectedSha: string
): Promise<void> => {
  if (role === "server") {
    await validateServer(config, expectedSha);
  }
  if (role === "web") {
    await validateWeb(config, expectedSha);
  }
  if (role === "projector") {
    await validateProjector(config, expectedSha);
  }
};

const deployRole = async (
  api: CoolifyApi,
  config: CoolifyConfig,
  role: Role,
  previousSha: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleepImpl: (milliseconds: number) => Promise<void>,
  onMutated: (evidence: DeploymentEvidence) => void,
  deadline: Deadline,
  nowImpl: () => number
): Promise<DeploymentEvidence> => {
  const uuid = config.applicationUuids[role];
  requireBudget(deadline, deadline.rollbackReserveMs + 1000, role);
  await assertMain(config);
  await assertNoActiveDeployments(api);
  const before = await application(api, uuid, role);
  const configuredSha = requireSha(
    before.git_commit_sha,
    `${role} previous configured SHA`
  );
  if (configuredSha !== previousSha) {
    throw new DeploymentError(
      "configured_runtime_mismatch",
      `${role} configured SHA is not the latest finished runtime SHA`,
      role
    );
  }
  await assertMain(config);
  const pending = {
    applicationUuid: uuid,
    candidateSha: config.candidateSha,
    deploymentStatus: "pending",
    deploymentUuid: "pending",
    previousSha,
    role,
  };
  onMutated({ ...pending });
  let deploymentUuid: string | undefined;
  let deploymentFinished = false;
  try {
    // This is deliberately the last read before the first mutating request.
    // A gate read performed earlier in the job is insufficient protection
    // against main moving while the candidate is being deployed.
    await assertMain(config);
    await assertReleaseEvidence(config);
    const patched = await api.patch(
      rolePath(uuid),
      { git_commit_sha: config.candidateSha },
      `${role} pin SHA`
    );
    const patchedValue = asObject(patched, `${role} pin response`);
    if (patchedValue.uuid !== uuid) {
      throw new DeploymentError(
        "pin_readback_failed",
        `${role} pin response did not identify the expected application`,
        role
      );
    }
    const pinned = await application(api, uuid, role);
    if (pinned.git_commit_sha !== config.candidateSha) {
      throw new DeploymentError(
        "pin_readback_failed",
        `${role} did not read back the candidate SHA`,
        role
      );
    }
    await assertMain(config);
    const started = await api.post(
      `/deploy?uuid=${encodeURIComponent(uuid)}&force=true`,
      undefined,
      `${role} deploy`
    );
    deploymentUuid = extractDeploymentUuid(started, uuid);
    pending.deploymentUuid = deploymentUuid;
    const deploymentStatus = await waitForDeployment(
      api,
      deploymentUuid,
      config.candidateSha,
      timeoutMs,
      pollIntervalMs,
      sleepImpl,
      role,
      deadline.at - deadline.rollbackReserveMs,
      nowImpl
    );
    deploymentFinished = true;
    pending.deploymentStatus = deploymentStatus;
    await waitForApplicationHealthy(
      api,
      uuid,
      role,
      config.candidateSha,
      timeoutMs,
      pollIntervalMs,
      sleepImpl,
      deadline.at - deadline.rollbackReserveMs,
      nowImpl
    );
    await validatePublic(config, role, config.candidateSha);
    return pending;
  } catch (error) {
    if (deploymentUuid && !deploymentFinished) {
      await settleCancelledDeployment(
        api,
        deploymentUuid,
        timeoutMs,
        pollIntervalMs,
        sleepImpl,
        role,
        deadline.at,
        nowImpl
      );
    }
    throw error;
  }
};

const rollbackRole = async (
  api: CoolifyApi,
  config: CoolifyConfig,
  evidence: DeploymentEvidence,
  timeoutMs: number,
  pollIntervalMs: number,
  sleepImpl: (milliseconds: number) => Promise<void>,
  deadline: Deadline,
  nowImpl: () => number
): Promise<void> => {
  requireBudget(deadline, 1000, evidence.role);
  await assertNoActiveDeployments(api);
  const patched = await api.patch(
    rolePath(evidence.applicationUuid),
    { git_commit_sha: evidence.previousSha },
    `${evidence.role} rollback pin`
  );
  const patchedValue = asObject(
    patched,
    `${evidence.role} rollback pin response`
  );
  if (patchedValue.uuid !== evidence.applicationUuid) {
    throw new DeploymentError(
      "rollback_pin_readback_failed",
      `${evidence.role} rollback pin response did not identify the expected application`,
      evidence.role
    );
  }
  const pinned = await application(
    api,
    evidence.applicationUuid,
    evidence.role
  );
  if (pinned.git_commit_sha !== evidence.previousSha) {
    throw new DeploymentError(
      "rollback_pin_readback_failed",
      `${evidence.role} rollback pin was not acknowledged`,
      evidence.role
    );
  }
  await assertNoActiveDeployments(api);
  const started = await api.post(
    `/deploy?uuid=${encodeURIComponent(evidence.applicationUuid)}&force=true`,
    undefined,
    `${evidence.role} rollback deploy`
  );
  const deploymentUuid = extractDeploymentUuid(
    started,
    evidence.applicationUuid
  );
  await waitForDeployment(
    api,
    deploymentUuid,
    evidence.previousSha,
    timeoutMs,
    pollIntervalMs,
    sleepImpl,
    evidence.role,
    deadline.at,
    nowImpl
  );
  try {
    await waitForApplicationHealthy(
      api,
      evidence.applicationUuid,
      evidence.role,
      evidence.previousSha,
      timeoutMs,
      pollIntervalMs,
      sleepImpl,
      deadline.at,
      nowImpl
    );
  } catch {
    throw new DeploymentError(
      "rollback_readback_failed",
      `${evidence.role} rollback did not restore the previous SHA`,
      evidence.role
    );
  }
  await validatePublic(config, evidence.role, evidence.previousSha);
};

export const runCoolifyDeploy = async (
  config: CoolifyConfig
): Promise<readonly DeploymentEvidence[]> => {
  requireSha(config.candidateSha, "candidate SHA");
  if (!config.apiToken) {
    throw new DeploymentError(
      "missing_coolify_token",
      "Coolify API token is required"
    );
  }
  if (!config.githubToken) {
    throw new DeploymentError(
      "missing_github_token",
      "GitHub token is required"
    );
  }
  if (!config.enabled) {
    throw new DeploymentError(
      "deployment_disabled",
      "production deploy is disabled until the witnessed rehearsal enables it"
    );
  }
  const timeoutMs = config.timeoutMs ?? 600_000;
  const pollIntervalMs = config.pollIntervalMs ?? 5000;
  const rollbackReserveMs =
    config.rollbackReserveMs ?? Math.max(30_000, Math.min(timeoutMs, 120_000));
  const deadlineMs =
    config.deadlineMs ??
    timeoutMs * DEPLOYMENT_ORDER.length + rollbackReserveMs;
  const nowImpl = config.nowImpl ?? Date.now;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 100 ||
    !Number.isSafeInteger(rollbackReserveMs) ||
    rollbackReserveMs < 1000 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= rollbackReserveMs + 1000
  ) {
    throw new DeploymentError(
      "invalid_timeout",
      "deployment timeout and poll interval must be bounded positive integers"
    );
  }
  const deadline: Deadline = {
    at: nowImpl() + deadlineMs,
    now: nowImpl,
    rollbackReserveMs,
  };
  const api = new CoolifyApi(config);
  const previous = new Map<Role, string>();
  let trustedBaseline: string | undefined;
  const evidence: DeploymentEvidence[] = [];
  const sleepImpl =
    config.sleepImpl ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  try {
    await assertMain(config);
    await assertTrustedReleaseLedger(config);
    await assertNoActiveDeployments(api);
    for (const role of DEPLOYMENT_ORDER) {
      const before = await application(
        api,
        config.applicationUuids[role],
        role
      );
      const configuredSha = requireSha(
        before.git_commit_sha,
        `${role} previous configured SHA`
      );
      const actualSha = await readActualDeployedSha(
        api,
        config.applicationUuids[role],
        role
      );
      if (configuredSha !== actualSha) {
        throw new DeploymentError(
          "configured_runtime_mismatch",
          `${role} configured SHA is not the latest finished runtime SHA`,
          role
        );
      }
      const expectedBaselineSha =
        config.lastDeployedRelease?.componentShas[role];
      if (expectedBaselineSha && actualSha !== expectedBaselineSha) {
        throw new DeploymentError(
          "release_baseline_component_mismatch",
          `${role} active finished runtime did not match the trusted complete-release baseline`,
          role
        );
      }
      trustedBaseline ??= actualSha;
      if (configuredSha !== trustedBaseline || actualSha !== trustedBaseline) {
        throw new DeploymentError(
          "baseline_mismatch",
          "server, web, and projector do not share one trusted deployed SHA",
          role
        );
      }
      previous.set(role, actualSha);
    }
    for (const role of DEPLOYMENT_ORDER) {
      const previousSha = previous.get(role);
      if (!previousSha) {
        throw new DeploymentError(
          "missing_previous_sha",
          `${role} previous SHA was not captured`,
          role
        );
      }
      const deployed = await deployRole(
        api,
        config,
        role,
        previousSha,
        timeoutMs,
        pollIntervalMs,
        sleepImpl,
        (pending) => {
          evidence.push(pending);
        },
        deadline,
        nowImpl
      );
      const pendingIndex = evidence.findIndex(
        (item) => item.role === role && item.deploymentUuid === "pending"
      );
      if (pendingIndex === -1) {
        throw new DeploymentError(
          "mutation_tracking_failed",
          `${role} mutation was not tracked`,
          role
        );
      }
      evidence[pendingIndex] = deployed;
    }
    return evidence;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const item of rollbackOrder(evidence)) {
      try {
        await rollbackRole(
          api,
          config,
          item,
          timeoutMs,
          pollIntervalMs,
          sleepImpl,
          deadline,
          nowImpl
        );
      } catch (rollbackError) {
        rollbackFailures.push(`${item.role}:${safeReason(rollbackError)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new DeploymentError(
        "rollback_incomplete",
        `original:${safeReason(error)}; rollback:${rollbackFailures.join(", ")}`
      );
    }
    throw error;
  }
};

const readRequired = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new DeploymentError("missing_configuration", `${name} is required`);
  }
  return value;
};

const main = async (): Promise<void> => {
  try {
    const result = await runCoolifyDeploy({
      apiBaseUrl: readRequired("COOLIFY_API_BASE_URL"),
      apiPublicUrl: readRequired("PRODUCTION_API_URL"),
      apiToken:
        process.env.COOLIFY_API_TOKEN ?? process.env.COOLIFY_API_KEY ?? "",
      applicationUuids: {
        projector: readRequired("COOLIFY_PROJECTOR_APPLICATION_UUID"),
        server: readRequired("COOLIFY_SERVER_APPLICATION_UUID"),
        web: readRequired("COOLIFY_WEB_APPLICATION_UUID"),
      },
      candidateSha: readRequired("CANDIDATE_SHA"),
      deadlineMs: Number(process.env.COOLIFY_DEPLOY_DEADLINE_MS ?? "1800000"),
      enabled:
        process.env.PRODUCTION_DEPLOY_ENABLED === "1" ||
        process.env.PRODUCTION_DEPLOY_ENABLED === "true",
      githubToken: readRequired("GITHUB_TOKEN"),
      lastDeployedRelease: JSON.parse(
        readRequired("PRODUCTION_LAST_DEPLOYED_RELEASE_JSON")
      ) as TrustedReleaseBaseline,
      pollIntervalMs: Number(
        process.env.COOLIFY_DEPLOY_POLL_INTERVAL_MS ?? "5000"
      ),
      projectorRuntimeUrl: readRequired("PRODUCTION_PROJECTOR_RUNTIME_URL"),
      projectorSchemaHash: readRequired("PRODUCTION_PROJECTOR_SCHEMA_HASH"),
      releaseEvidenceFile: readRequired("RELEASE_GATE_EVIDENCE_FILE"),
      repository: readRequired("GITHUB_REPOSITORY"),
      rollbackReserveMs: Number(
        process.env.COOLIFY_DEPLOY_ROLLBACK_RESERVE_MS ?? "600000"
      ),
      timeoutMs: Number(process.env.COOLIFY_DEPLOY_TIMEOUT_MS ?? "600000"),
      webPublicUrl: readRequired("PRODUCTION_WEB_URL"),
      webVersionUrl: readRequired("PRODUCTION_WEB_VERSION_URL"),
    });
    console.log(
      JSON.stringify({
        candidateSha: process.env.CANDIDATE_SHA,
        resources: result.map(
          ({
            applicationUuid,
            deploymentStatus,
            deploymentUuid,
            previousSha,
            role,
          }) => ({
            applicationUuid,
            deploymentStatus,
            deploymentUuid,
            previousSha,
            role,
          })
        ),
        result: "pass",
      })
    );
    if (process.env.PRODUCTION_DEPLOY_OUTCOME_FILE) {
      await writeFile(
        process.env.PRODUCTION_DEPLOY_OUTCOME_FILE,
        JSON.stringify({
          candidateSha: process.env.CANDIDATE_SHA,
          nextReleaseBaseline: nextReleaseBaseline(result, {
            candidateSha: readRequired("CANDIDATE_SHA"),
            deploymentId: readRequired("PRODUCTION_DEPLOYMENT_ID"),
            repository: readRequired("GITHUB_REPOSITORY"),
            verifiedAt: new Date().toISOString(),
          }),
          result: "pass",
          state: "success",
        })
      );
    }
  } catch (error) {
    const code =
      error instanceof DeploymentError ? error.code : "unexpected_failure";
    if (process.env.PRODUCTION_DEPLOY_OUTCOME_FILE) {
      const state =
        code === "deployment_timeout" ||
        code === "deployment_deadline_exhausted" ||
        code === "rollback_incomplete" ||
        code === "rollback_deployment_active"
          ? "error"
          : "failure";
      await writeFile(
        process.env.PRODUCTION_DEPLOY_OUTCOME_FILE,
        JSON.stringify({
          candidateSha: process.env.CANDIDATE_SHA,
          code,
          result: "block",
          state,
        })
      );
    }
    console.error(
      JSON.stringify({
        reason:
          error instanceof DeploymentError
            ? error.message
            : "deployment_failed: unexpected error",
        result: "block",
      })
    );
    exit(1);
  }
};

if (import.meta.main) {
  await main();
}
