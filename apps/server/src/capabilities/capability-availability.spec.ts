import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import type { SliceARole } from "@ji/application/registry";
import { Hono } from "hono";
import { z } from "zod";

import type { PrincipalResolver } from "./auth";
import {
  PRODUCTION_UNAVAILABLE_CAPABILITIES,
  unavailableCapabilityReason,
  capabilityAvailability,
} from "./capability-availability";
import type { CapabilityAvailabilityPolicy } from "./capability-availability";
import {
  createMcpProtocolFixture,
  MCP_ALLOWED_ORIGIN,
  modernParams,
} from "./mcp-protocol-fixture";
import type { SliceARegistry } from "./registry-types";
import { createRestCapabilityHandler, restRoutesFromRegistry } from "./rest";
import type { RestJsonBody } from "./transport-boundary";

const bronId = "00000000-0000-4000-8000-000000000001";
const snapshotId = "00000000-0000-4000-8000-000000000002";

interface UnavailableCase {
  readonly arguments: RestJsonBody;
  readonly capabilityId: string;
  readonly path: string;
}

const unavailableCases: readonly UnavailableCase[] = [
  {
    arguments: { snapshotId },
    capabilityId: "commit_export",
    path: "/v1/exports",
  },
  {
    arguments: { evidence: [], status: "success", summary: "Complete" },
    capabilityId: "complete_task",
    path: "/v1/agent/complete-task",
  },
  {
    arguments: { bronId },
    capabilityId: "start_run",
    path: `/v1/bronnen/${bronId}/runs`,
  },
  {
    arguments: { bronId },
    capabilityId: "start_test_import",
    path: `/v1/bronnen/${bronId}/test-import`,
  },
];

const rpcRequest = (
  method: string,
  params: ReturnType<typeof modernParams>
) => ({
  id: 1,
  jsonrpc: "2.0",
  method,
  params,
});

const resolverForRole =
  (role: SliceARole): PrincipalResolver =>
  () =>
    Promise.resolve({
      ok: true,
      principal: {
        kind: "user",
        permissions: permissionsForRole(role),
        subjectId: `availability-${role}`,
      },
    });

const adminResolver = resolverForRole("admin");

const createTrackedRegistry = () => {
  const bundle = createTestSliceARegistry();
  let invocationCount = 0;
  let operatorEffectCount = 0;
  Object.defineProperties(bundle.deps.stores.operatorRuns, {
    startRun: {
      value: () => {
        operatorEffectCount += 1;
        return Promise.resolve({ runId: "unexpected-run" });
      },
    },
    startTestImport: {
      value: () => {
        operatorEffectCount += 1;
        return Promise.resolve({ runId: "unexpected-test-import" });
      },
    },
  });
  const createInvoker = (
    binding: Parameters<SliceARegistry["createInvoker"]>[0]
  ) => {
    const invoke = bundle.registry.createInvoker(binding);
    return (
      input: Parameters<typeof invoke>[0],
      trustedInvocation: Parameters<typeof invoke>[1]
    ) => {
      invocationCount += 1;
      return invoke(input, trustedInvocation);
    };
  };
  const registry: SliceARegistry = {
    catalog: bundle.registry.catalog,
    // SAFETY: The wrapper preserves the registry overload and forwards both arguments unchanged.
    createInvoker: createInvoker as SliceARegistry["createInvoker"],
    health: bundle.registry.health,
  };
  return {
    entries: bundle.entries,
    invocationCount: () => invocationCount,
    operatorEffectCount: () => operatorEffectCount,
    registry,
  };
};

const createRestFixture = (
  registry: ReturnType<typeof createTrackedRegistry>["registry"],
  unavailableCapabilities: CapabilityAvailabilityPolicy,
  resolvePrincipal: PrincipalResolver = adminResolver
) => {
  const handler = createRestCapabilityHandler(
    registry,
    restRoutesFromRegistry(registry),
    resolvePrincipal,
    {
      allowedCookieOrigin: MCP_ALLOWED_ORIGIN,
      unavailableCapabilities,
    }
  );
  const app = new Hono();
  app.all("/v1/*", (context) => handler(context));
  return app;
};

const sendRestRequest = (
  app: Hono,
  path: string,
  body: RestJsonBody,
  onBodyRead: () => void = () => {}
): Promise<Response> => {
  const request = new Request(`http://server.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: "Bearer fixture-session",
      "Content-Type": "application/json",
      Host: "server.test",
      Origin: MCP_ALLOWED_ORIGIN,
    },
    method: "POST",
  });
  const readJson = request.json.bind(request);
  Object.defineProperty(request, "json", {
    value: () => {
      onBodyRead();
      return readJson();
    },
  });
  return Promise.resolve(app.request(request));
};

const availabilityOutcomeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().min(1),
  }),
  ok: z.literal(false),
});

const mcpDisabledResponseSchema = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string(), type: z.string() })).min(1),
    isError: z.literal(true),
    resultType: z.literal("complete"),
  }),
});

const mcpCatalogResponseSchema = z.object({
  result: z.object({
    tools: z.array(z.object({ name: z.string() }).passthrough()),
  }),
});

const mcpSuccessResponseSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.object({ accepted: z.literal(true) }),
  }),
});

const forbiddenMcpResponseSchema = z.object({
  error: z.object({
    code: z.literal(-32_602),
    message: z.string(),
  }),
});

describe("production capability availability policy", () => {
  it("keeps an explicitly implemented capability executable when it has an explanatory reason", async () => {
    const tracked = createTrackedRegistry();
    const policy = new Map([
      [
        "complete_task",
        {
          reason: "The handler is enabled for this fixture",
          safeNextStep: "Voer de capability uit met de getoonde invoer.",
          status: "implemented" as const,
        },
      ],
    ]);
    const rest = createRestFixture(tracked.registry, policy);
    const mcp = createMcpProtocolFixture(tracked, "admin", policy);
    const input = {
      evidence: ["synthetic-fixture"],
      status: "success" as const,
      summary: "Explicitly enabled",
    };

    expect(
      unavailableCapabilityReason(policy, "complete_task")
    ).toBeUndefined();
    expect(capabilityAvailability(policy, "complete_task")).toMatchObject({
      reason: "The handler is enabled for this fixture",
      status: "implemented",
    });

    const [restResponse, mcpCatalogResponse, mcpCallResponse] =
      await Promise.all([
        sendRestRequest(rest, "/v1/agent/complete-task", input),
        mcp.request("tools/list", rpcRequest("tools/list", modernParams())),
        mcp.request(
          "tools/call",
          rpcRequest(
            "tools/call",
            modernParams({ arguments: input, name: "complete_task" })
          ),
          { "Mcp-Name": "complete_task" }
        ),
      ]);
    const mcpCatalog = mcpCatalogResponseSchema.parse(
      await mcpCatalogResponse.json()
    );
    const listed = mcpCatalog.result.tools.find(
      (tool) => tool.name === "complete_task"
    );

    expect(restResponse.status).toBe(200);
    expect(await restResponse.json()).toMatchObject({ accepted: true });
    expect(mcpCallResponse.status).toBe(200);
    expect(listed).toMatchObject({
      _meta: {
        "catapulze/availability": {
          executable: true,
          reason: "The handler is enabled for this fixture",
          status: "implemented",
        },
      },
    });
    expect(tracked.invocationCount()).toBe(2);
  });

  it("advertises every authorized unavailable capability with a non-executable status", async () => {
    const tracked = createTrackedRegistry();
    const fixture = createMcpProtocolFixture(
      tracked,
      "admin",
      PRODUCTION_UNAVAILABLE_CAPABILITIES
    );
    const response = await fixture.request(
      "tools/list",
      rpcRequest("tools/list", modernParams())
    );
    const body = mcpCatalogResponseSchema.parse(await response.json());
    const names = body.result.tools.map((tool) => tool.name);
    const unavailableNames = unavailableCases
      .map((unavailable) => unavailable.capabilityId)
      .toSorted();

    expect(response.status).toBe(200);
    expect([...PRODUCTION_UNAVAILABLE_CAPABILITIES.keys()].toSorted()).toEqual(
      unavailableNames
    );
    for (const unavailable of unavailableCases) {
      expect(names).toContain(unavailable.capabilityId);
      const listed = body.result.tools.find(
        (tool) => tool.name === unavailable.capabilityId
      );
      expect(listed).toMatchObject({
        _meta: {
          "catapulze/availability": {
            executable: false,
            status: expect.not.stringMatching(/^implemented$/u),
          },
        },
      });
    }
    expect(tracked.invocationCount()).toBe(0);
  });

  it("returns matching disabled outcomes without REST body parsing or handler effects", async () => {
    const tracked = createTrackedRegistry();
    const rest = createRestFixture(
      tracked.registry,
      PRODUCTION_UNAVAILABLE_CAPABILITIES
    );
    const mcp = createMcpProtocolFixture(
      tracked,
      "admin",
      PRODUCTION_UNAVAILABLE_CAPABILITIES
    );
    let restBodyReads = 0;
    const noteBodyRead = () => {
      restBodyReads += 1;
    };
    const outcomes = await Promise.all(
      unavailableCases.map(async (unavailable) => {
        const expectedMessage = unavailableCapabilityReason(
          PRODUCTION_UNAVAILABLE_CAPABILITIES,
          unavailable.capabilityId
        );
        if (expectedMessage === undefined) {
          throw new Error(
            `Missing production policy for ${unavailable.capabilityId}`
          );
        }
        const [restResponse, mcpResponse] = await Promise.all([
          sendRestRequest(
            rest,
            unavailable.path,
            unavailable.arguments,
            noteBodyRead
          ),
          mcp.request(
            "tools/call",
            rpcRequest(
              "tools/call",
              modernParams({
                arguments: unavailable.arguments,
                name: unavailable.capabilityId,
              })
            ),
            { "Mcp-Name": unavailable.capabilityId }
          ),
        ]);
        const [restJson, mcpJson] = await Promise.all([
          restResponse.json(),
          mcpResponse.json(),
        ]);
        const restOutcome = availabilityOutcomeSchema.parse(restJson);
        const mcpBody = mcpDisabledResponseSchema.parse(mcpJson);
        const mcpText = z.string().parse(mcpBody.result.content.at(0)?.text);
        const mcpOutcome = availabilityOutcomeSchema.parse(JSON.parse(mcpText));
        return {
          expectedMessage,
          mcpBody,
          mcpOutcome,
          mcpStatus: mcpResponse.status,
          restOutcome,
          restStatus: restResponse.status,
        };
      })
    );

    for (const outcome of outcomes) {
      expect(outcome.restStatus).toBe(503);
      expect(outcome.restOutcome.error.code).toBe("CAPABILITY_DISABLED");
      expect(outcome.restOutcome.error.message).toBe(outcome.expectedMessage);
      expect(outcome.mcpStatus).toBe(200);
      expect(outcome.mcpBody.result.resultType).toBe("complete");
      expect(outcome.mcpBody.result.isError).toBe(true);
      expect(outcome.mcpOutcome.error.code).toBe(
        outcome.restOutcome.error.code
      );
      expect(outcome.mcpOutcome.error.message).toBe(
        outcome.restOutcome.error.message
      );
    }
    expect(restBodyReads).toBe(0);
    expect(tracked.invocationCount()).toBe(0);
    expect(tracked.operatorEffectCount()).toBe(0);
  });

  it("denies insufficient roles before REST bodies and hides availability details", async () => {
    const tracked = createTrackedRegistry();
    let restBodyReads = 0;
    const noteBodyRead = () => {
      restBodyReads += 1;
    };
    const deniedCases = unavailableCases.map((unavailable) => {
      const role: SliceARole =
        unavailable.capabilityId === "complete_task" ? "operator" : "recruiter";
      return { ...unavailable, role };
    });
    const outcomes = await Promise.all(
      deniedCases.map(async (denied) => {
        const expectedOperationalReason = unavailableCapabilityReason(
          PRODUCTION_UNAVAILABLE_CAPABILITIES,
          denied.capabilityId
        );
        if (expectedOperationalReason === undefined) {
          throw new Error(
            `Missing production policy for ${denied.capabilityId}`
          );
        }
        const rest = createRestFixture(
          tracked.registry,
          PRODUCTION_UNAVAILABLE_CAPABILITIES,
          resolverForRole(denied.role)
        );
        const mcp = createMcpProtocolFixture(
          tracked,
          denied.role,
          PRODUCTION_UNAVAILABLE_CAPABILITIES
        );
        const [restResponse, mcpResponse] = await Promise.all([
          sendRestRequest(rest, denied.path, denied.arguments, noteBodyRead),
          mcp.request(
            "tools/call",
            rpcRequest(
              "tools/call",
              modernParams({
                arguments: denied.arguments,
                name: denied.capabilityId,
              })
            ),
            { "Mcp-Name": denied.capabilityId }
          ),
        ]);
        const [restJson, mcpJson] = await Promise.all([
          restResponse.json(),
          mcpResponse.json(),
        ]);
        return {
          capabilityId: denied.capabilityId,
          expectedOperationalReason,
          mcpJson,
          mcpOutcome: forbiddenMcpResponseSchema.parse(mcpJson),
          mcpStatus: mcpResponse.status,
          restJson,
          restOutcome: availabilityOutcomeSchema.parse(restJson),
          restStatus: restResponse.status,
        };
      })
    );

    for (const outcome of outcomes) {
      expect(outcome.restStatus).toBe(403);
      expect(outcome.restOutcome.error.code).toBe("FORBIDDEN");
      expect(outcome.restOutcome.error.message).toBe(
        "The principal is not allowed to invoke this capability"
      );
      expect(outcome.mcpStatus).toBe(200);
      expect(outcome.mcpOutcome.error.code).toBe(-32_602);
      expect(outcome.mcpOutcome.error.message).toBe(
        `Unknown or unavailable tool: ${outcome.capabilityId}`
      );
      expect(JSON.stringify(outcome.restJson)).not.toContain(
        outcome.expectedOperationalReason
      );
      expect(JSON.stringify(outcome.mcpJson)).not.toContain(
        outcome.expectedOperationalReason
      );
    }

    expect(restBodyReads).toBe(0);
    expect(tracked.invocationCount()).toBe(0);
    expect(tracked.operatorEffectCount()).toBe(0);
  });

  it("allows an explicitly wired capability when the policy is empty", async () => {
    const tracked = createTrackedRegistry();
    const emptyPolicy = new Map();
    const rest = createRestFixture(tracked.registry, emptyPolicy);
    const mcp = createMcpProtocolFixture(tracked, "admin", emptyPolicy);
    const input = {
      evidence: ["fixture"],
      status: "success",
      summary: "Explicitly wired",
    };
    const restResponse = await sendRestRequest(
      rest,
      "/v1/agent/complete-task",
      input
    );
    const mcpResponse = await mcp.request(
      "tools/call",
      rpcRequest(
        "tools/call",
        modernParams({ arguments: input, name: "complete_task" })
      ),
      { "Mcp-Name": "complete_task" }
    );
    const mcpBody = mcpSuccessResponseSchema.parse(await mcpResponse.json());

    expect(restResponse.status).toBe(200);
    expect(await restResponse.json()).toMatchObject({ accepted: true });
    expect(mcpResponse.status).toBe(200);
    expect(mcpBody.result.isError).not.toBe(true);
    expect(mcpBody.result.structuredContent.accepted).toBe(true);
    expect(tracked.invocationCount()).toBe(2);
  });
});
