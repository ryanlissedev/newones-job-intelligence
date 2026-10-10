import { describe, expect, it } from "bun:test";
/* oxlint-disable eslint/complexity, eslint/require-await, eslint/prefer-destructuring, eslint/no-plusplus, eslint/no-nested-ternary, unicorn/prefer-response-static-json, promise/avoid-new, eslint/no-promise-executor-return, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- The stateful HTTP harness intentionally centralizes many protocol branches and uses an explicit clock delay for timeout coverage. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  DEPLOYMENT_ORDER,
  extractLatestFinishedDeploymentSha,
  extractDeploymentUuid,
  nextReleaseBaseline,
  rollbackOrder,
  runCoolifyDeploy,
} from "./coolify-deploy";
import type { FetchInput, FetchLike } from "./coolify-deploy";

const must = <T>(value: T | undefined, reason: string): T => {
  if (value === undefined) {
    throw new Error(reason);
  }
  return value;
};

const candidateSha = "c".repeat(40);
const previousSha = "d".repeat(40);
const schemaHash = "schema-v1";
const coolifyBaseUrl = "https://coolify.test/api/v1";
const coolifyPathPrefix = new URL(coolifyBaseUrl).pathname;
const apiPublicUrl = "https://api.test";
const webPublicUrl = "https://web.test";
const applicationUuids = {
  projector: "projector-uuid",
  server: "server-uuid",
  web: "web-uuid",
} as const;

type Role = keyof typeof applicationUuids;
type FailureMode = "public" | "projector-schema" | "timeout" | "wrong-sha";

interface HarnessOptions {
  readonly failRole?: Role;
  readonly ledgerPayload?: unknown;
  readonly withReleaseBaseline?: boolean;
  readonly failureMode?: FailureMode;
  readonly mainMovesAfter?: number;
  readonly patchFailsAfterMutation?: boolean;
  readonly rollbackPatchFails?: boolean;
  readonly mainTransportFails?: boolean;
  readonly cancelRaceFinished?: boolean;
  readonly baselineMismatch?: boolean;
  readonly dashboardLocation?: string;
  /** Number of `/projector/runtime` reads that still report the previous SHA. */
  readonly projectorRuntimeLagPolls?: number;
  readonly applicationStatusStages?: Partial<
    Record<
      Role,
      { before: string; after: readonly string[]; rollback: readonly string[] }
    >
  >;
  readonly onApplicationRead?: (role: Role, stage: ApplicationStage) => void;
  readonly applicationShaAfter?: Partial<Record<Role, string>>;
}

type ApplicationStage = "after" | "before" | "rollback";

interface HarnessState {
  readonly calls: { method: string; url: string }[];
  readonly sha: Record<Role, string>;
  mainReads: number;
  cancelledDeployment: string | undefined;
  finishedRaceDeployment: string | undefined;
  candidateDeployments: number;
  projectorRuntimeReads: number;
  readonly rollbackRoles: Set<Role>;
  readonly finishedRoles: Set<Role>;
  readonly rollbackFinishedRoles: Set<Role>;
  readonly stageReads: Record<ApplicationStage, Record<Role, number>>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const roleForUuid = (uuid: string): Role => {
  const entry = Object.entries(applicationUuids).find(
    ([, value]) => value === uuid
  );
  if (!entry) {
    throw new Error(`unknown uuid ${uuid}`);
  }
  return entry[0] as Role;
};

const passingEvidence = {
  candidateSha,
  changedFileCount: 1,
  previousDeployedSha: previousSha,
  pullRequests: [1],
  result: "pass",
  reviewMode: "trusted-approver",
  workflows: [".github/workflows/ci.yml"],
} as const;

const writeEvidenceFile = async (body: unknown): Promise<string> => {
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "ji-release-evidence-")
  );
  const file = nodePath.join(directory, "release-gate.json");
  await writeFile(file, JSON.stringify(body), { encoding: "utf-8" });
  return file;
};

const releaseBaseline = {
  componentShas: {
    projector: previousSha,
    server: previousSha,
    web: previousSha,
  },
  releaseId: "ledger-1",
  releaseSha: previousSha,
  repository: "test/repo",
  source: "trusted-complete-release",
  verifiedAt: "2026-09-11T10:00:00Z",
} as const;

const makeHarness = (options: HarnessOptions = {}) => {
  const state: HarnessState = {
    calls: [],
    cancelledDeployment: undefined,
    candidateDeployments: 0,
    finishedRaceDeployment: undefined,
    finishedRoles: new Set(),
    mainReads: 0,
    projectorRuntimeReads: 0,
    rollbackFinishedRoles: new Set(),
    rollbackRoles: new Set(),
    sha: {
      projector: options.baselineMismatch ? candidateSha : previousSha,
      server: previousSha,
      web: options.baselineMismatch ? candidateSha : previousSha,
    },
    stageReads: {
      after: { projector: 0, server: 0, web: 0 },
      before: { projector: 0, server: 0, web: 0 },
      rollback: { projector: 0, server: 0, web: 0 },
    },
  };

  const fetchImpl = async (
    input: FetchInput,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    state.calls.push({ method, url });

    if (url.includes("api.github.com/repos/test/repo/deployments/ledger-1")) {
      if (url.endsWith("/statuses?per_page=100")) {
        return json([{ id: 1, state: "success" }]);
      }
      return json({
        description: `Automatic production release ${previousSha}`,
        environment: "production",
        id: 800,
        payload:
          options.ledgerPayload === undefined
            ? {
                candidate_sha: previousSha,
                job: "deploy",
                run_attempt: "1",
                workflow: "Deploy production",
                workflow_run_id: "77",
              }
            : options.ledgerPayload,
        sha: previousSha,
      });
    }

    if (url.includes("api.github.com/repos/test/repo/git/ref/heads/main")) {
      state.mainReads += 1;
      if (options.mainTransportFails) {
        throw new Error("simulated GitHub timeout");
      }
      const moved =
        options.mainMovesAfter !== undefined &&
        state.mainReads > options.mainMovesAfter;
      return json({ object: { sha: moved ? "m".repeat(40) : candidateSha } });
    }

    if (url.startsWith(coolifyBaseUrl)) {
      const parsed = new URL(url);
      const path = parsed.pathname.slice(coolifyPathPrefix.length);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (path === "/deployments" && method === "GET") {
        return json([]);
      }
      if (path.startsWith("/deployments/applications/") && method === "GET") {
        const uuid = must(
          path.split("/")[3],
          `harness could not read an application UUID from ${path}`
        );
        const role = roleForUuid(uuid);
        return json({
          count: 1,
          deployments: [
            {
              application_id: "1",
              commit: state.sha[role],
              created_at: "2026-09-11T12:00:00.000Z",
              deployment_uuid: `${role}-history`,
              status: "finished",
            },
          ],
        });
      }
      if (path.startsWith("/deployments/") && method === "GET") {
        const deploymentUuid = must(
          path.split("/")[2],
          `harness could not read a deployment UUID from ${path}`
        );
        if (state.cancelledDeployment === deploymentUuid) {
          return json({
            commit: previousSha,
            deployment_uuid: deploymentUuid,
            status: "failed",
          });
        }
        if (state.finishedRaceDeployment === deploymentUuid) {
          return json({
            commit: candidateSha,
            deployment_uuid: deploymentUuid,
            status: "finished",
          });
        }
        if (
          options.failureMode === "timeout" &&
          deploymentUuid.includes("server-deployment")
        ) {
          return json({
            commit: candidateSha,
            deployment_uuid: deploymentUuid,
            status: "queued",
          });
        }
        const wrongSha =
          options.failureMode === "wrong-sha" &&
          deploymentUuid.includes("server-deployment");
        const rollback = deploymentUuid.includes("rollback");
        const detail = {
          commit: rollback || wrongSha ? previousSha : candidateSha,
          deployment_uuid: deploymentUuid,
          status: "finished",
        };
        const deploymentRole = deploymentUuid.split("-")[0];
        if (
          deploymentRole === "projector" ||
          deploymentRole === "server" ||
          deploymentRole === "web"
        ) {
          if (rollback) {
            state.rollbackFinishedRoles.add(deploymentRole);
          } else {
            state.finishedRoles.add(deploymentRole);
          }
        }
        return json(detail);
      }
      if (path.startsWith("/applications/") && method === "GET") {
        const uuid = must(
          path.split("/")[2],
          `harness could not read an application UUID from ${path}`
        );
        const role = roleForUuid(uuid);
        const stages = options.applicationStatusStages?.[role];
        const stage: ApplicationStage = state.rollbackRoles.has(role)
          ? state.rollbackFinishedRoles.has(role)
            ? "rollback"
            : "before"
          : state.finishedRoles.has(role)
            ? "after"
            : "before";
        const readIndex = state.stageReads[stage][role];
        state.stageReads[stage][role] += 1;
        options.onApplicationRead?.(role, stage);
        return json({
          git_commit_sha:
            stage === "after"
              ? (options.applicationShaAfter?.[role] ?? state.sha[role])
              : state.sha[role],
          status:
            stage === "before"
              ? (stages?.before ?? "healthy")
              : (stages?.[stage][readIndex] ??
                stages?.[stage].at(-1) ??
                "healthy"),
          uuid,
        });
      }
      if (path.startsWith("/applications/") && method === "PATCH") {
        const uuid = must(
          path.split("/")[2],
          `harness could not read an application UUID from ${path}`
        );
        const role = roleForUuid(uuid);
        const requestedSha = body?.git_commit_sha;
        if (requestedSha === previousSha && options.rollbackPatchFails) {
          return json({ uuid: "wrong-rollback-uuid" });
        }
        state.sha[role] = requestedSha;
        if (requestedSha === previousSha) {
          state.rollbackRoles.add(role);
        }
        if (options.patchFailsAfterMutation && requestedSha === candidateSha) {
          throw new Error("simulated uncertain PATCH");
        }
        return json({ uuid });
      }
      if (path === "/deploy" && method === "POST") {
        const uuid = parsed.searchParams.get("uuid");
        if (!uuid) {
          throw new Error("missing deploy uuid");
        }
        const role = roleForUuid(uuid);
        const rollback = state.sha[role] === previousSha;
        const deploymentUuid = rollback
          ? `${role}-rollback`
          : `${role}-deployment-${++state.candidateDeployments}`;
        return json({
          deployments: [
            { deployment_uuid: deploymentUuid, resource_uuid: uuid },
          ],
        });
      }
      if (path.startsWith("/deployments/") && path.endsWith("/cancel")) {
        const deploymentUuid = path.split("/")[2];
        if (options.cancelRaceFinished) {
          state.finishedRaceDeployment = deploymentUuid;
          return json({ error: "deployment already finished" }, 400);
        }
        state.cancelledDeployment = deploymentUuid;
        return json({ deployment_uuid: deploymentUuid, status: "cancelled" });
      }
      throw new Error(`unhandled Coolify route ${method} ${path}`);
    }

    if (url.startsWith(apiPublicUrl)) {
      const path = new URL(url).pathname;
      if (path === "/version") {
        return json({
          releaseSha:
            options.failRole === "server" && state.sha.server === candidateSha
              ? previousSha
              : state.sha.server,
        });
      }
      if (path === "/livez") {
        return new Response("ok", {
          status:
            options.failRole === "server" && state.sha.server === candidateSha
              ? 503
              : 200,
        });
      }
      if (path === "/projector/runtime") {
        state.projectorRuntimeReads += 1;
        const lagging =
          options.projectorRuntimeLagPolls !== undefined &&
          state.projectorRuntimeReads <= options.projectorRuntimeLagPolls;
        return json({
          active: true,
          containerId: "0123456789ab",
          cycle: 3,
          heartbeatFresh: true,
          releaseSha: lagging ? previousSha : state.sha.projector,
        });
      }
      if (path === "/readyz") {
        return json({
          components: {
            searchProjection: {
              schemaHash:
                options.failRole === "projector" &&
                state.sha.projector === candidateSha &&
                options.failureMode === "projector-schema"
                  ? "wrong-schema"
                  : schemaHash,
              status: "ok",
            },
          },
          status: "ready",
        });
      }
    }

    if (url.startsWith(webPublicUrl)) {
      const path = new URL(url).pathname;
      if (path === "/version") {
        return json({ releaseSha: state.sha.web });
      }
      if (path === "/") {
        return new Response("ok", {
          status:
            options.failRole === "web" && state.sha.web === candidateSha
              ? 503
              : 200,
        });
      }
      if (path === "/dashboard") {
        return new Response(null, {
          headers: { location: options.dashboardLocation ?? "/login" },
          status: 307,
        });
      }
    }

    throw new Error(`unhandled route ${method} ${url}`);
  };

  return {
    config: {
      apiBaseUrl: coolifyBaseUrl,
      apiPublicUrl,
      apiToken: "coolify-token",
      applicationUuids,
      candidateSha,
      enabled: true,
      fetchImpl,
      githubToken: "github-token",
      lastDeployedRelease: options.withReleaseBaseline
        ? releaseBaseline
        : undefined,
      pollIntervalMs: 100,
      projectorRuntimeUrl: `${apiPublicUrl}/projector/runtime`,
      projectorSchemaHash: schemaHash,
      repository: "test/repo",
      sleepImpl: async (milliseconds: number) => {
        if (milliseconds > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, milliseconds)
          );
        }
      },
      timeoutMs: 1000,
      webPublicUrl,
      webVersionUrl: "/version",
    } as const,
    fetchImpl,
    state,
  };
};

describe("production Coolify deployment contract", () => {
  it("deploys all roles from full Coolify envelopes and reads each pin back", async () => {
    const harness = makeHarness();
    const evidence = await runCoolifyDeploy(harness.config);

    expect(evidence.map((item) => item.role)).toEqual([
      "server",
      "web",
      "projector",
    ]);
    expect(evidence.every((item) => item.previousSha === previousSha)).toBe(
      true
    );
    const candidatePatches = harness.state.calls.filter(
      ({ method, url }) => method === "PATCH" && url.includes("/applications/")
    );
    expect(candidatePatches).toHaveLength(3);
  });

  it.each(["running:unknown", "running:unhealthy"])(
    "waits for post-finished transient application state %s with positive fake-clock sleeps",
    async (transientStatus) => {
      const harness = makeHarness({
        applicationStatusStages: {
          server: {
            after: [transientStatus, "healthy"],
            before: "healthy",
            rollback: [],
          },
        },
      });
      let clock = 0;
      const sleeps: number[] = [];

      const evidence = await runCoolifyDeploy({
        ...harness.config,
        deadlineMs: 200_000,
        nowImpl: () => clock,
        rollbackReserveMs: 50_000,
        sleepImpl: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
        timeoutMs: 120_000,
      });

      expect(evidence).toHaveLength(3);
      expect(harness.state.stageReads.before.server).toBeGreaterThan(1);
      expect(harness.state.stageReads.after.server).toBe(2);
      expect(sleeps).toEqual([100]);
      expect(sleeps.every((milliseconds) => milliseconds > 0)).toBe(true);
      expect(
        harness.state.calls.filter(
          ({ method, url }) =>
            method === "PATCH" && url.includes("/applications/")
        )
      ).toHaveLength(3);
    }
  );

  it.each(["starting", "running:unhealthy"])(
    "caps perpetual application status %s at 90 seconds even when the role timeout is longer",
    async (transientStatus) => {
      const harness = makeHarness({
        applicationStatusStages: {
          server: {
            after: [transientStatus],
            before: "healthy",
            rollback: ["healthy"],
          },
        },
      });
      let clock = 0;
      const sleeps: number[] = [];

      await expect(
        runCoolifyDeploy({
          ...harness.config,
          deadlineMs: 200_000,
          nowImpl: () => clock,
          pollIntervalMs: 45_000,
          rollbackReserveMs: 50_000,
          sleepImpl: async (milliseconds) => {
            sleeps.push(milliseconds);
            clock += milliseconds;
          },
          timeoutMs: 120_000,
        })
      ).rejects.toThrow("application_readback_failed");
      expect(sleeps).toEqual([45_000, 45_000]);
      expect(harness.state.stageReads.after.server).toBe(2);
      expect(harness.state.stageReads.rollback.server).toBe(1);
    }
  );

  it("uses the shorter absolute deployment deadline for application health", async () => {
    const harness = makeHarness({
      applicationStatusStages: {
        server: {
          after: ["starting"],
          before: "healthy",
          rollback: ["healthy"],
        },
      },
    });
    let clock = 0;
    const sleeps: number[] = [];

    await expect(
      runCoolifyDeploy({
        ...harness.config,
        deadlineMs: 120_000,
        nowImpl: () => clock,
        pollIntervalMs: 20_000,
        rollbackReserveMs: 80_000,
        sleepImpl: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
        timeoutMs: 120_000,
      })
    ).rejects.toThrow("application_readback_failed");
    expect(sleeps).toEqual([20_000, 20_000]);
    expect(harness.state.stageReads.after.server).toBe(2);
    expect(harness.state.stageReads.rollback.server).toBe(1);
  });

  it("aborts a health read when only a short absolute budget remains", async () => {
    const harness = makeHarness({
      applicationStatusStages: {
        server: {
          after: ["starting", "healthy"],
          before: "healthy",
          rollback: ["healthy"],
        },
      },
    });
    let clock = 0;
    let finishedApplicationReads = 0;
    let abortObserved = false;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (
        url.includes("/applications/server-uuid") &&
        harness.state.finishedRoles.has("server") &&
        !abortObserved
      ) {
        finishedApplicationReads += 1;
        if (finishedApplicationReads === 2) {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("health read did not receive an abort signal");
          }
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                abortObserved = true;
                reject(signal.reason);
              },
              { once: true }
            );
          });
        }
      }
      return harness.fetchImpl(input, init);
    };

    await expect(
      runCoolifyDeploy({
        ...harness.config,
        deadlineMs: 2001,
        fetchImpl,
        nowImpl: () => clock,
        rollbackReserveMs: 1000,
        sleepImpl: async () => {
          clock = 1000;
        },
        timeoutMs: 120_000,
      })
    ).rejects.toThrow("coolify_transport_error");
    expect(abortObserved).toBe(true);
    expect(harness.state.stageReads.after.server).toBe(1);
    expect(harness.state.stageReads.rollback.server).toBe(1);
  });

  it("rejects a healthy response that arrives after the absolute application deadline", async () => {
    let clock = 0;
    const harness = makeHarness({
      applicationStatusStages: {
        server: {
          after: ["healthy"],
          before: "healthy",
          rollback: ["healthy"],
        },
      },
      onApplicationRead: (role, stage) => {
        if (role === "server" && stage === "after") {
          clock = 90_000;
        }
      },
    });

    await expect(
      runCoolifyDeploy({
        ...harness.config,
        deadlineMs: 200_000,
        nowImpl: () => clock,
        rollbackReserveMs: 50_000,
        sleepImpl: async () => {},
        timeoutMs: 120_000,
      })
    ).rejects.toThrow("application_readback_failed");
    expect(harness.state.stageReads.after.server).toBe(1);
    expect(harness.state.stageReads.rollback.server).toBe(1);
  });

  it.each(["crashed", "unsupported-status"])(
    "rejects terminal application status %s without retrying",
    async (status) => {
      const harness = makeHarness({
        applicationStatusStages: {
          server: { after: [status], before: "healthy", rollback: ["healthy"] },
        },
      });
      const sleeps: number[] = [];

      await expect(
        runCoolifyDeploy({
          ...harness.config,
          sleepImpl: async (milliseconds) => {
            sleeps.push(milliseconds);
          },
        })
      ).rejects.toThrow("observed unknown");
      expect(harness.state.stageReads.after.server).toBe(1);
      expect(sleeps).toHaveLength(0);
    }
  );

  it("rejects a wrong application SHA without retrying", async () => {
    const harness = makeHarness({
      applicationShaAfter: { server: previousSha },
      applicationStatusStages: {
        server: {
          after: ["healthy"],
          before: "healthy",
          rollback: ["healthy"],
        },
      },
    });
    const sleeps: number[] = [];

    await expect(
      runCoolifyDeploy({
        ...harness.config,
        sleepImpl: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      })
    ).rejects.toThrow("observed healthy");
    expect(harness.state.stageReads.after.server).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it.each(["running:unknown", "running:unhealthy"])(
    "waits for rollback application convergence from %s before completing rollback",
    async (transientStatus) => {
      const harness = makeHarness({
        applicationStatusStages: {
          server: {
            after: ["healthy"],
            before: "healthy",
            rollback: [transientStatus, "healthy"],
          },
        },
        failRole: "web",
        failureMode: "public",
      });
      let clock = 0;
      const sleeps: number[] = [];

      await expect(
        runCoolifyDeploy({
          ...harness.config,
          nowImpl: () => clock,
          sleepImpl: async (milliseconds) => {
            sleeps.push(milliseconds);
            clock += milliseconds;
          },
        })
      ).rejects.toThrow("web_readback_failed");
      expect(harness.state.stageReads.rollback.server).toBe(2);
      expect(sleeps).toEqual([100]);
    }
  );

  it("uses the shorter absolute deadline after a finished deployment", async () => {
    const harness = makeHarness({
      applicationStatusStages: {
        server: {
          after: ["starting"],
          before: "healthy",
          rollback: ["healthy"],
        },
      },
    });
    let clock = 0;
    const sleeps: number[] = [];

    await expect(
      runCoolifyDeploy({
        ...harness.config,
        deadlineMs: 5000,
        nowImpl: () => clock,
        pollIntervalMs: 1000,
        rollbackReserveMs: 1000,
        sleepImpl: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
        timeoutMs: 120_000,
      })
    ).rejects.toThrow("application_readback_failed");
    expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
    expect(harness.state.stageReads.after.server).toBe(4);
    expect(harness.state.stageReads.rollback.server).toBe(1);
    expect(harness.state.cancelledDeployment).toBeUndefined();
  });

  it("uses the remaining absolute deadline while rolling back", async () => {
    const harness = makeHarness({
      applicationStatusStages: {
        server: {
          after: ["starting", "healthy"],
          before: "healthy",
          rollback: ["starting"],
        },
      },
      failRole: "web",
      failureMode: "public",
    });
    let clock = 0;

    await expect(
      runCoolifyDeploy({
        ...harness.config,
        deadlineMs: 3000,
        nowImpl: () => clock,
        pollIntervalMs: 1000,
        rollbackReserveMs: 1000,
        sleepImpl: async (milliseconds) => {
          clock += milliseconds;
        },
        timeoutMs: 120_000,
      })
    ).rejects.toThrow(
      "rollback_incomplete: original:web_readback_failed; rollback:server:rollback_readback_failed"
    );
    expect(harness.state.stageReads.rollback.server).toBe(2);
  });

  it.each(["server", "web", "projector"] as const)(
    "rolls back a failure in the %s role",
    async (failRole) => {
      const harness = makeHarness({
        failRole,
        failureMode: failRole === "projector" ? "projector-schema" : "public",
      });

      await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
        failRole === "server"
          ? "version_sha_mismatch"
          : failRole === "web"
            ? "web_readback_failed"
            : "projector_schema_mismatch"
      );
      expect(harness.state.sha).toEqual({
        projector: previousSha,
        server: previousSha,
        web: previousSha,
      });
      expect(
        harness.state.calls.some(
          ({ method, url }) =>
            method === "GET" && url.includes("/deployments/server-rollback")
        )
      ).toBe(true);
    }
  );

  it("waits out a projector runtime readback that still reports the previous SHA", async () => {
    const harness = makeHarness({ projectorRuntimeLagPolls: 2 });
    const evidence = await runCoolifyDeploy({
      ...harness.config,
      sleepImpl: async () => {
        // Collapses the readback's 5 s poll so the case runs instantly.
      },
    });

    expect(evidence.map((item) => item.role)).toEqual([
      "server",
      "web",
      "projector",
    ]);
    expect(harness.state.projectorRuntimeReads).toBe(3);
    expect(harness.state.sha.projector).toBe(candidateSha);
  });

  it("fails with projector_runtime_mismatch when the candidate never appears within the window", async () => {
    const harness = makeHarness({
      projectorRuntimeLagPolls: Number.POSITIVE_INFINITY,
    });

    await expect(
      runCoolifyDeploy({
        ...harness.config,
        sleepImpl: async () => {
          // Collapses the readback's 5 s poll so the case runs instantly.
        },
      })
    ).rejects.toThrow("projector_runtime_mismatch");
    expect(harness.state.projectorRuntimeReads).toBeGreaterThan(1);
    expect(harness.state.sha.projector).toBe(previousSha);
  });

  it("rolls back after main moves because rollback does not depend on main", async () => {
    const harness = makeHarness({ mainMovesAfter: 4 });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "main_moved"
    );
    expect(harness.state.sha.server).toBe(previousSha);
    expect(
      harness.state.calls.some(
        ({ method, url }) =>
          method === "GET" && url.includes("/deployments/server-rollback")
      )
    ).toBe(true);
  });

  it("rolls back an uncertain PATCH after Coolify mutates then drops the connection", async () => {
    const harness = makeHarness({ patchFailsAfterMutation: true });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "coolify_transport_error"
    );
    expect(harness.state.sha.server).toBe(previousSha);
    expect(
      harness.state.calls.filter(
        ({ method, url }) => method === "PATCH" && url.includes("server-uuid")
      )
    ).toHaveLength(2);
  });

  it("cancels a pending deployment before rolling back", async () => {
    const harness = makeHarness({ failureMode: "timeout" });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "deployment_timeout"
    );
    expect(harness.state.cancelledDeployment).toBe("server-deployment-1");
    expect(harness.state.sha.server).toBe(previousSha);
  });

  it("accepts a cancellation race when the deployment finished before the cancel request", async () => {
    const harness = makeHarness({
      cancelRaceFinished: true,
      failureMode: "timeout",
    });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "deployment_timeout"
    );
    expect(harness.state.sha.server).toBe(previousSha);
  });

  it("reports incomplete rollback when exact rollback identity cannot be acknowledged", async () => {
    const harness = makeHarness({
      failRole: "web",
      failureMode: "public",
      rollbackPatchFails: true,
    });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "rollback_incomplete: original:web_readback_failed; rollback:web:rollback_pin_readback_failed, server:rollback_pin_readback_failed"
    );
  });

  it("fails closed on an unreachable GitHub main readback", async () => {
    const harness = makeHarness({ mainTransportFails: true });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "main_readback_failed"
    );
  });

  it("fails closed when deployment detail reports the wrong SHA", async () => {
    const harness = makeHarness({ failureMode: "wrong-sha" });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "deployment_sha_mismatch"
    );
    expect(harness.state.cancelledDeployment).toBe("server-deployment-1");
    expect(harness.state.sha.server).toBe(previousSha);
  });

  it("requires one trusted baseline across configured and finished identities", async () => {
    const harness = makeHarness({ baselineMismatch: true });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "baseline_mismatch"
    );
    expect(harness.state.calls.some(({ method }) => method === "PATCH")).toBe(
      false
    );
  });

  it("rejects a cross-origin dashboard login redirect", async () => {
    const harness = makeHarness({
      dashboardLocation: "https://evil.test/login",
    });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "web_readback_failed"
    );
    expect(harness.state.sha.server).toBe(previousSha);
  });

  it("fails closed when the absolute deadline cannot preserve rollback time", async () => {
    const harness = makeHarness();
    let clock = 0;
    const config = {
      ...harness.config,
      deadlineMs: 3000,
      nowImpl: () => {
        clock += 500;
        return clock;
      },
      rollbackReserveMs: 1000,
    } as const;

    await expect(runCoolifyDeploy(config)).rejects.toThrow(
      "deployment_deadline_exhausted"
    );
    expect(harness.state.calls.some(({ method }) => method === "PATCH")).toBe(
      true
    );
    expect(harness.state.sha.server).toBe(candidateSha);
  });
});

describe("production Coolify rollback", () => {
  it("uses the newest finished runtime identity while ignoring older deployments", () => {
    expect(
      extractLatestFinishedDeploymentSha(
        [
          {
            commit: previousSha,
            created_at: "2026-09-10T12:00:00.000Z",
            status: "finished",
          },
          {
            commit: candidateSha,
            created_at: "2026-09-11T12:00:00.000Z",
            status: "finished",
          },
        ],
        "server"
      )
    ).toBe(candidateSha);
  });

  it("rolls back every mutated role in reverse sequence", () => {
    expect(DEPLOYMENT_ORDER).toEqual(["server", "web", "projector"]);
    expect(rollbackOrder(DEPLOYMENT_ORDER)).toEqual([
      "projector",
      "web",
      "server",
    ]);
  });

  it("accepts a complete-release baseline backed by a real ledger entry", async () => {
    const harness = makeHarness({ withReleaseBaseline: true });

    const evidence = await runCoolifyDeploy(harness.config);

    expect(evidence.map((item) => item.role)).toEqual([
      "server",
      "web",
      "projector",
    ]);
  });

  it("rejects a baseline pointing at a GitHub environment record", async () => {
    const harness = makeHarness({
      ledgerPayload: {},
      withReleaseBaseline: true,
    });

    await expect(runCoolifyDeploy(harness.config)).rejects.toThrow(
      "release_baseline_mismatch"
    );
  });

  it("parses a ledger payload delivered as a JSON string", async () => {
    const harness = makeHarness({
      ledgerPayload: JSON.stringify({
        candidate_sha: previousSha,
        workflow: "Deploy production",
      }),
      withReleaseBaseline: true,
    });

    await expect(runCoolifyDeploy(harness.config)).resolves.toHaveLength(3);
  });

  it("proceeds when the release-gate evidence file revalidates", async () => {
    const harness = makeHarness({ withReleaseBaseline: true });
    const releaseEvidenceFile = await writeEvidenceFile(passingEvidence);

    const evidence = await runCoolifyDeploy({
      ...harness.config,
      releaseEvidenceFile,
    });

    expect(evidence.map((item) => item.role)).toEqual([
      "server",
      "web",
      "projector",
    ]);
  });

  it("rejects release-gate evidence written for another candidate", async () => {
    const harness = makeHarness({ withReleaseBaseline: true });
    const releaseEvidenceFile = await writeEvidenceFile({
      ...passingEvidence,
      candidateSha: "e".repeat(40),
    });

    await expect(
      runCoolifyDeploy({ ...harness.config, releaseEvidenceFile })
    ).rejects.toThrow("release_evidence_invalid");
  });

  it("rejects release-gate evidence that recorded a block", async () => {
    const harness = makeHarness({ withReleaseBaseline: true });
    const releaseEvidenceFile = await writeEvidenceFile({
      ...passingEvidence,
      result: "block",
    });

    await expect(
      runCoolifyDeploy({ ...harness.config, releaseEvidenceFile })
    ).rejects.toThrow("release_evidence_invalid");
  });

  it("rejects release-gate evidence missing the verified workflow list", async () => {
    const harness = makeHarness({ withReleaseBaseline: true });
    const { workflows, ...withoutWorkflows } = passingEvidence;
    const releaseEvidenceFile = await writeEvidenceFile(withoutWorkflows);

    expect(workflows).toHaveLength(1);
    await expect(
      runCoolifyDeploy({ ...harness.config, releaseEvidenceFile })
    ).rejects.toThrow("release_evidence_invalid");
  });

  it("rejects release-gate evidence without a recorded review mode", async () => {
    const harness = makeHarness({ withReleaseBaseline: true });
    const { reviewMode, ...withoutReviewMode } = passingEvidence;
    const releaseEvidenceFile = await writeEvidenceFile(withoutReviewMode);

    expect(reviewMode).toBe("trusted-approver");
    await expect(
      runCoolifyDeploy({ ...harness.config, releaseEvidenceFile })
    ).rejects.toThrow("release_evidence_stale");
  });

  it("rotates the complete-release baseline from the deployment readbacks", async () => {
    const harness = makeHarness({ withReleaseBaseline: true });
    const releaseEvidenceFile = await writeEvidenceFile(passingEvidence);

    const evidence = await runCoolifyDeploy({
      ...harness.config,
      releaseEvidenceFile,
    });

    expect(
      nextReleaseBaseline(evidence, {
        candidateSha,
        deploymentId: "4242",
        repository: "test/repo",
        verifiedAt: "2026-09-11T12:00:00Z",
      })
    ).toEqual({
      componentShas: {
        projector: candidateSha,
        server: candidateSha,
        web: candidateSha,
      },
      releaseId: "4242",
      releaseSha: candidateSha,
      repository: "test/repo",
      source: "trusted-complete-release",
      verifiedAt: "2026-09-11T12:00:00Z",
    });
  });

  it("refuses to rotate a baseline without a deployment id or full evidence", () => {
    const evidence = DEPLOYMENT_ORDER.map((role) => ({
      applicationUuid: applicationUuids[role],
      candidateSha,
      deploymentStatus: "finished",
      deploymentUuid: `deployment-${role}`,
      previousSha,
      role,
    }));
    const context = {
      candidateSha,
      deploymentId: "4242",
      repository: "test/repo",
      verifiedAt: "2026-09-11T12:00:00Z",
    };

    expect(() =>
      nextReleaseBaseline(evidence, { ...context, deploymentId: "  " })
    ).toThrow("release_baseline_unwritable");
    expect(() => nextReleaseBaseline(evidence.slice(0, 2), context)).toThrow(
      "release_baseline_unwritable"
    );
    expect(() =>
      nextReleaseBaseline(evidence, { ...context, verifiedAt: "not a date" })
    ).toThrow("release_baseline_unwritable");
  });

  it("selects exactly one deployment UUID for the mutated resource", () => {
    expect(
      extractDeploymentUuid(
        {
          deployments: [
            {
              deployment_uuid: "deployment-1234",
              resource_uuid: "server-uuid",
            },
          ],
        },
        "server-uuid"
      )
    ).toBe("deployment-1234");
    expect(() =>
      extractDeploymentUuid(
        {
          deployments: [
            { deployment_uuid: "deployment-1234", resource_uuid: "other-uuid" },
          ],
        },
        "server-uuid"
      )
    ).toThrow("deployment_identity_missing");
    expect(() =>
      extractDeploymentUuid(
        {
          deployments: [
            { deployment_uuid: "deployment-1", resource_uuid: "server-uuid" },
            { deployment_uuid: "deployment-2", resource_uuid: "server-uuid" },
          ],
        },
        "server-uuid"
      )
    ).toThrow("deployment_identity_missing");
  });
});
