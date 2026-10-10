import { permissionsForRole } from "@ji/application/registry";
import type {
  SliceARole,
  TestSliceARegistryBundle,
} from "@ji/application/registry";
import { Hono } from "hono";
import { z } from "zod";

import type { PrincipalResolver } from "./auth";
import { PRODUCTION_UNAVAILABLE_CAPABILITIES } from "./capability-availability";
import type { CapabilityAvailabilityPolicy } from "./capability-availability";
import { createMcpHandler } from "./mcp";
import type { JsonValue, RestJsonBody } from "./transport-boundary";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_ALLOWED_ORIGIN = "https://app.catapulze.test";
export const MCP_TEST_BEARER = "Bearer fixture-session";
const rawBodySchema = z.string();

export const createMcpProtocolFixture = (
  bundle: Pick<TestSliceARegistryBundle, "entries" | "registry">,
  role: SliceARole = "recruiter",
  unavailableCapabilities: CapabilityAvailabilityPolicy = PRODUCTION_UNAVAILABLE_CAPABILITIES
) => {
  const resolvePrincipal: PrincipalResolver = (headers) =>
    Promise.resolve({
      ok: true,
      principal:
        headers.get("Authorization") === MCP_TEST_BEARER
          ? {
              kind: "agent",
              permissions: permissionsForRole(role),
              subjectId: "fixture-agent",
            }
          : null,
    });
  const handler = createMcpHandler(bundle.registry, resolvePrincipal, {
    allowedCookieOrigin: MCP_ALLOWED_ORIGIN,
    allowedHost: "server.test",
    entries: bundle.entries,
    unavailableCapabilities,
  });
  const app = new Hono();
  app.post("/mcp", (context) => handler(context));

  return {
    fetch: (input: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Host", "server.test");
      return Promise.resolve(
        app.fetch(new Request(input.toString(), { ...init, headers }))
      );
    },
    request: (
      method: string,
      body: JsonValue | string,
      headers: RequestInit["headers"] = {}
    ): Promise<Response> => {
      const rawBody = rawBodySchema.safeParse(body);
      return Promise.resolve(
        app.request("/mcp", {
          body: rawBody.success ? rawBody.data : JSON.stringify(body),
          headers: {
            Accept: "application/json, text/event-stream",
            Authorization: MCP_TEST_BEARER,
            "Content-Type": "application/json",
            Host: "server.test",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
            "Mcp-Method": method,
            ...headers,
          },
          method: "POST",
        })
      );
    },
  };
};

export const modernParams = (params: RestJsonBody = {}) => ({
  ...params,
  _meta: {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  },
});
