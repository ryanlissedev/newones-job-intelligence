import { describe, expect, it } from "bun:test";

import {
  createSliceARegistry,
  createTestSliceADeps,
} from "@ji/application/registry";
import type { SliceARole } from "@ji/application/registry";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Hono } from "hono";

import { createSessionPrincipalResolver } from "./auth";
import { createMcpHandler } from "./mcp";
import type { McpRequestMetric } from "./mcp-metrics";
import { MCP_PROTOCOL_VERSION, modernParams } from "./mcp-protocol-fixture";
import { createRestCapabilityHandler, restRoutesFromRegistry } from "./rest";

const now = new Date("2026-09-05T12:00:00.000Z");
const actorOne = "operator-one";
const actorTwo = "operator-two";
const credentialOne = "Bearer bootstrap-fixture-one";
const credentialTwo = "Bearer bootstrap-fixture-two";

const createFixture = (scopeId = "bootstrap-scope-one") => {
  const deps = createTestSliceADeps(scopeId);
  const unavailable = new Set<string>(["start_run"]);
  const metrics: McpRequestMetric[] = [];
  const sessions = new Map<string, { id: string; role: SliceARole }>([
    [credentialOne, { id: actorOne, role: "operator" }],
    [credentialTwo, { id: actorTwo, role: "operator" }],
  ]);
  const { entries, registry } = createSliceARegistry({
    ...deps,
    capabilityAvailability: { unavailableCapabilityIds: () => unavailable },
    now: () => now,
  });
  const resolvePrincipal = createSessionPrincipalResolver(
    (headers) => {
      const user = sessions.get(headers.get("Authorization") ?? "");
      return Promise.resolve(
        user
          ? {
              session: { expiresAt: new Date("2026-09-06T12:00:00.000Z") },
              user,
            }
          : null
      );
    },
    () => now
  );
  const policy = new Map([
    [
      "start_run",
      {
        reason: "Fixture dispatch unavailable",
        safeNextStep: "Use fixture readback",
        status: "disabled" as const,
      },
    ],
  ]);
  const options = {
    allowedCookieOrigin: "https://app.catapulze.test",
    unavailableCapabilities: policy,
  };
  const mcp = createMcpHandler(registry, resolvePrincipal, {
    ...options,
    allowedHost: "server.test",
    entries,
    recordMetric: (metric) => {
      metrics.push(metric);
    },
  });
  const rest = createRestCapabilityHandler(
    registry,
    restRoutesFromRegistry(registry),
    resolvePrincipal,
    options
  );
  const app = new Hono();
  app.post("/mcp", (context) => mcp(context));
  app.post("/v1/agent/context", (context) => rest(context));
  const fetch = (
    input: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("Host", "server.test");
    return Promise.resolve(
      app.fetch(new Request(input.toString(), { ...init, headers }))
    );
  };
  const readRest = (body = {}, credential = credentialOne) =>
    fetch("http://server.test/v1/agent/context", {
      body: JSON.stringify(body),
      headers: {
        Authorization: credential,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  const readMcp = (args = {}, credential = credentialOne) =>
    fetch("http://server.test/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: modernParams({ arguments: args, name: "get_operator_context" }),
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: credential,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_operator_context",
      },
      method: "POST",
    });
  const connect = async (credential = credentialOne) => {
    const client = new Client(
      { name: "operator-bootstrap-fixture", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://server.test/mcp"), {
        fetch,
        requestInit: { headers: { Authorization: credential } },
      })
    );
    return client;
  };
  return { connect, deps, metrics, readMcp, readRest, sessions, unavailable };
};

describe("operator context transport contract", () => {
  it("returns the same safe context through REST and the pinned modern MCP client", async () => {
    const fixture = createFixture();
    const client = await fixture.connect();
    try {
      const rest = await fixture.readRest();
      expect(rest.status).toBe(200);
      const restBody = await rest.json();
      const result = await client.callTool({
        arguments: {},
        name: "get_operator_context",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(restBody);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain(
        "get_operator_context"
      );
      const serialized = JSON.stringify(result.structuredContent);
      expect(serialized).toContain(actorOne);
      expect(serialized).not.toContain(actorTwo);
      expect(serialized).not.toContain(credentialOne);
      expect(serialized).not.toContain("rawPayload");
      expect(serialized).not.toContain("requestId");
    } finally {
      await client.close();
    }
  });

  it("rejects revoked sessions on the next REST and existing-client call", async () => {
    const fixture = createFixture();
    const client = await fixture.connect();
    try {
      const allowed = await client.callTool({
        arguments: {},
        name: "get_operator_context",
      });
      expect(allowed.isError).not.toBe(true);
      fixture.sessions.delete(credentialOne);
      const revoked = await fixture.readRest();
      expect(revoked.status).toBe(401);
      await expect(
        client.callTool({ arguments: {}, name: "get_operator_context" })
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("refreshes an owned selection without returning sensitive resource fields", async () => {
    const fixture = createFixture();
    const client = await fixture.connect();
    const { savedSearch: saved } =
      await fixture.deps.stores.savedSearches.createWithAudit(
        {
          deletedAt: null,
          filters: {},
          naam: "private-bootstrap-name",
          parserVersion: "1.0.0",
          queryText: "private-bootstrap-query",
          schemaVersion: "1.0.0",
          scopeId: fixture.deps.scopeId,
          userId: actorOne,
        },
        "user"
      );
    try {
      const before = await client.callTool({
        arguments: {},
        name: "get_operator_context",
      });
      const args = { savedSearchId: saved.id };
      const rest = await fixture.readRest(args);
      expect(rest.status).toBe(200);
      const body = await rest.json();
      const selected = await client.callTool({
        arguments: args,
        name: "get_operator_context",
      });
      expect(selected.structuredContent).toEqual(body);
      expect(selected.structuredContent).toHaveProperty(
        "selected.savedSearch.id",
        saved.id
      );
      expect(selected.structuredContent).not.toEqual(before.structuredContent);
      const foreign = await fixture.readRest(args, credentialTwo);
      const missing = await fixture.readRest(
        { savedSearchId: "00000000-0000-4000-8000-000000000999" },
        credentialTwo
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      const serialized = JSON.stringify({ body, metrics: fixture.metrics });
      for (const excluded of [
        "private-bootstrap-name",
        "private-bootstrap-query",
        "rawPayload",
        credentialOne,
      ]) {
        expect(serialized).not.toContain(excluded);
      }
      // CTP-655: slice-a reads are visible to the operator's capability
      // catalog, so their schema field names (queryText, filters) legitimately
      // appear in the serialized context. The invariant is that the selected
      // saved search itself only exposes its id.
      // SAFETY: the response was just asserted to carry
      // selected.savedSearch.id; narrowing to inspect that object only.
      const selectedSavedSearch = JSON.stringify(
        (body as { selected?: { savedSearch?: object } }).selected?.savedSearch
      );
      for (const sensitiveField of [
        '"filters"',
        '"naam"',
        '"queryText"',
        '"rawPayload"',
      ]) {
        expect(selectedSavedSearch).not.toContain(sensitiveField);
      }
      expect(JSON.stringify(fixture.metrics)).not.toContain(saved.id);
    } finally {
      await client.close();
    }
  });

  it("rejects anonymous and insufficiently authorized callers without fallback", async () => {
    const fixture = createFixture();
    const anonymousRest = await fixture.readRest({}, "");
    const anonymousMcp = await fixture.readMcp({}, "");
    expect(anonymousRest.status).toBe(401);
    expect(anonymousMcp.status).toBe(401);
    fixture.sessions.set(credentialOne, { id: actorOne, role: "recruiter" });
    const forbidden = await fixture.readRest();
    expect(forbidden.status).toBe(403);
    const mcp = await fixture.readMcp();
    expect(await mcp.json()).toHaveProperty("error.code", -32_602);
  });

  it("keeps actor and scope context separate and rejects forged domain context", async () => {
    const fixture = createFixture();
    const otherScope = createFixture("bootstrap-scope-two");
    const oneResponse = await fixture.readRest();
    const twoResponse = await fixture.readRest({}, credentialTwo);
    const scopeResponse = await otherScope.readRest();
    const one = await oneResponse.json();
    const two = await twoResponse.json();
    const scoped = await scopeResponse.json();
    expect(one).not.toEqual(two);
    expect(one).not.toEqual(scoped);
    expect(JSON.stringify(two)).not.toContain(actorOne);
    const forged = await fixture.readRest({
      actorId: actorTwo,
      scopeId: "bootstrap-scope-two",
    });
    expect(forged.status).toBe(400);
    const response = await fixture.readMcp({
      _meta: { token: "sensitive-meta" },
      requestId: "sensitive-request",
    });
    expect(await response.json()).toHaveProperty("error.code", -32_602);
    const metrics = JSON.stringify(fixture.metrics);
    for (const excluded of [
      actorOne,
      actorTwo,
      credentialOne,
      "sensitive-request",
      "sensitive-meta",
      "bootstrap-scope-one",
    ]) {
      expect(metrics).not.toContain(excluded);
    }
    expect(
      fixture.metrics.some((metric) => metric.tool === "get_operator_context")
    ).toBe(true);
  });
});
