import { describe, expect, it } from "bun:test";

import {
  createSliceARegistry,
  createTestSliceADeps,
  createTestSliceARegistry,
  digestSourcingSelection,
} from "@ji/application/registry";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { createSessionPrincipalResolver } from "./auth";
import { createMcpHandler } from "./mcp";
import { createRestCapabilityHandler, restRoutesFromRegistry } from "./rest";

const currentTime = new Date("2026-09-02T12:00:00.000Z");
const allowedOrigin = "https://app.catapulze.test";
const validBearer = "Bearer valid.signed-session";
const expiredBearer = "Bearer expired.signed-session";
const mcpProtocolVersion = "2026-07-28";
const sourcingQueryDigest = `sha256:${"1".repeat(64)}`;
const sourcingInput = {
  claims: [],
  queryDigest: sourcingQueryDigest,
  selectedIds: [],
  selectionDigest: digestSourcingSelection({
    queryDigest: sourcingQueryDigest,
    selectedIds: [],
  }),
};
const sourcingVacancyId = "00000000-0000-4000-8000-000000000101";
const trustedSourcingClaims = [
  {
    field: "deadline" as const,
    sourceReferenceIds: ["detail-1"],
    status: "known" as const,
    vacancyId: sourcingVacancyId,
    value: "2026-09-12",
  },
  {
    field: "rate" as const,
    sourceReferenceIds: [],
    status: "unknown" as const,
    vacancyId: sourcingVacancyId,
    value: "unknown" as const,
  },
  {
    field: "location" as const,
    sourceReferenceIds: ["detail-1"],
    status: "known" as const,
    vacancyId: sourcingVacancyId,
    value: "Amsterdam",
  },
  {
    field: "contract_type" as const,
    sourceReferenceIds: [],
    status: "uncertain" as const,
    vacancyId: sourcingVacancyId,
    value: "temporary",
  },
];
const trustedSourcingInput = {
  claims: trustedSourcingClaims,
  queryDigest: sourcingQueryDigest,
  selectedIds: [sourcingVacancyId],
  selectionDigest: digestSourcingSelection({
    queryDigest: sourcingQueryDigest,
    selectedIds: [sourcingVacancyId],
  }),
};
const trustedSourcingAttestation = {
  claims: trustedSourcingClaims,
  queryDigest: sourcingQueryDigest,
  searchStatus: "complete" as const,
  selectedIds: [sourcingVacancyId],
  sourceReferences: [
    {
      capabilityId: "search_aanvragen",
      id: "search-1",
      maxAgeSeconds: 3600,
      observedAt: "2026-09-02T11:30:00.000Z",
      reference: "query-snapshot:transport-fixture",
    },
    {
      capabilityId: "get_aanvraag",
      id: "detail-1",
      maxAgeSeconds: 3600,
      observedAt: "2026-09-02T11:30:00.000Z",
      reference: `aanvraag:${sourcingVacancyId}`,
    },
  ],
  usedCapabilities: ["search_aanvragen", "get_aanvraag"],
};

const resolvePrincipal = createSessionPrincipalResolver(
  (headers) => {
    const authorization = headers.get("Authorization");
    const hasValidCookie = headers
      .get("Cookie")
      ?.includes("better-auth.session_token=valid-session");
    if (authorization === validBearer || hasValidCookie) {
      return Promise.resolve({
        session: { expiresAt: new Date("2026-09-02T13:00:00.000Z") },
        user: { id: "recruiter-1", role: "recruiter" },
      });
    }
    if (authorization === expiredBearer) {
      return Promise.resolve({
        session: { expiresAt: new Date("2026-09-02T11:00:00.000Z") },
        user: { id: "recruiter-1", role: "recruiter" },
      });
    }
    return Promise.resolve(null);
  },
  () => currentTime
);

const createRestContext = (
  headers: Headers,
  options: {
    readonly body?: object;
    readonly method?: string;
    readonly onBodyRead?: () => void;
    readonly path?: string;
  } = {}
): Context => {
  const method = options.method ?? "POST";
  const path = options.path ?? "/v1/aanvragen/search";
  const context = {
    req: {
      json: () => {
        options.onBodyRead?.();
        return Promise.resolve(options.body ?? { query: "Azure" });
      },
      method,
      path,
      raw: { headers },
      url: `http://server.test${path}`,
    },
  };
  // SAFETY: The REST handler reads only the request members represented by this focused test double.
  return context as Context;
};

const sendMcpRequest = (
  handler: ReturnType<typeof createMcpHandler>,
  headers: Headers,
  name = "search_aanvragen",
  options: {
    readonly arguments?: object;
    readonly onBodyRead?: () => void;
  } = {}
): Promise<Response> => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json, text/event-stream");
  requestHeaders.set("Content-Type", "application/json");
  requestHeaders.set("Host", "server.test");
  requestHeaders.set("MCP-Protocol-Version", mcpProtocolVersion);
  requestHeaders.set("Mcp-Method", "tools/call");
  requestHeaders.set("Mcp-Name", name);
  const request = new Request("http://server.test/mcp", {
    body: JSON.stringify({
      id: "request-1",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/protocolVersion": mcpProtocolVersion,
        },
        arguments: options.arguments ?? { query: "Azure" },
        name,
      },
    }),
    headers: requestHeaders,
    method: "POST",
  });
  if (options.onBodyRead) {
    const { onBodyRead } = options;
    const cloneRequest = request.clone.bind(request);
    const readJson = request.json.bind(request);
    const readText = request.text.bind(request);
    Object.defineProperties(request, {
      clone: {
        value: () => {
          onBodyRead();
          return cloneRequest();
        },
      },
      json: {
        value: () => {
          onBodyRead();
          return readJson();
        },
      },
      text: {
        value: () => {
          onBodyRead();
          return readText();
        },
      },
    });
  }
  const app = new Hono();
  app.post("/mcp", (context) => handler(context));
  return Promise.resolve(app.request(request));
};

describe("REST and MCP authentication boundary", () => {
  const bundle = createTestSliceARegistry();
  const rest = createRestCapabilityHandler(
    bundle.registry,
    restRoutesFromRegistry(bundle.registry),
    resolvePrincipal,
    { allowedCookieOrigin: allowedOrigin }
  );
  const mcp = createMcpHandler(bundle.registry, resolvePrincipal, {
    allowedCookieOrigin: allowedOrigin,
    allowedHost: "server.test",
    entries: bundle.entries,
  });

  it("rejects anonymous REST and MCP calls", async () => {
    const restResponse = await rest(createRestContext(new Headers()));
    const mcpResponse = await sendMcpRequest(mcp, new Headers());

    expect(restResponse.status).toBe(401);
    expect(mcpResponse.status).toBe(401);
  });

  it("rejects a forged admin header for REST and MCP writes", async () => {
    const headers = new Headers({ Authorization: "Bearer admin:attacker" });
    const restResponse = await rest(
      createRestContext(headers, {
        body: {},
        path: "/v1/bronnen/00000000-0000-4000-8000-000000000001/runs",
      })
    );
    const mcpResponse = await sendMcpRequest(mcp, headers, "start_run");

    expect(restResponse.status).toBe(401);
    expect(mcpResponse.status).toBe(401);
  });

  it("accepts a validated cookie for REST and signed bearer session for MCP", async () => {
    const restResponse = await rest(
      createRestContext(
        new Headers({
          Cookie: "better-auth.session_token=valid-session",
          Origin: allowedOrigin,
        })
      )
    );
    const bearerRestResponse = await rest(
      createRestContext(new Headers({ Authorization: validBearer }))
    );
    const mcpResponse = await sendMcpRequest(
      mcp,
      new Headers({ Authorization: validBearer })
    );

    expect(restResponse.status).toBe(200);
    expect(bearerRestResponse.status).toBe(200);
    expect(mcpResponse.status).toBe(200);
  });

  it("calls sourcing assessment through direct REST and MCP tools/call and fails closed upstream", async () => {
    const restResponse = await rest(
      createRestContext(new Headers({ Authorization: validBearer }), {
        body: sourcingInput,
        path: "/v1/sourcing/assessment",
      })
    );
    const mcpResponse = await sendMcpRequest(
      mcp,
      new Headers({ Authorization: validBearer }),
      "evaluate_sourcing_assessment",
      { arguments: sourcingInput }
    );
    const restBody = await restResponse.json();
    const mcpBody = await mcpResponse.json();

    expect(restResponse.status).toBe(200);
    expect(restBody).toHaveProperty("evaluation.status", "blocked-upstream");
    expect(restBody).toHaveProperty("binding.trust", "unavailable");
    expect(mcpResponse.status).toBe(200);
    expect(mcpBody).toHaveProperty(
      "result.structuredContent.evaluation.status",
      "blocked-upstream"
    );
    expect(mcpBody).toHaveProperty(
      "result.structuredContent.binding.trust",
      "unavailable"
    );
  });

  it("uses injected trusted authority through full REST and MCP transports", async () => {
    const trustedDeps = createTestSliceADeps();
    const trustedBundle = createSliceARegistry({
      ...trustedDeps,
      now: () => currentTime,
      sourcingAssessmentAuthority: {
        attest: () => trustedSourcingAttestation,
      },
    });
    const trustedRest = createRestCapabilityHandler(
      trustedBundle.registry,
      restRoutesFromRegistry(trustedBundle.registry),
      resolvePrincipal,
      { allowedCookieOrigin: allowedOrigin }
    );
    const trustedMcp = createMcpHandler(
      trustedBundle.registry,
      resolvePrincipal,
      {
        allowedCookieOrigin: allowedOrigin,
        allowedHost: "server.test",
        entries: trustedBundle.entries,
      }
    );
    const restResponse = await trustedRest(
      createRestContext(new Headers({ Authorization: validBearer }), {
        body: trustedSourcingInput,
        path: "/v1/sourcing/assessment",
      })
    );
    const mcpResponse = await sendMcpRequest(
      trustedMcp,
      new Headers({ Authorization: validBearer }),
      "evaluate_sourcing_assessment",
      { arguments: trustedSourcingInput }
    );
    const restBody = await restResponse.json();
    const mcpBody = await mcpResponse.json();

    expect(restResponse.status).toBe(200);
    expect(restBody).toHaveProperty("evaluation.status", "passed");
    expect(restBody).toHaveProperty("binding.trust", "attested");
    expect(restBody).toHaveProperty("binding.actor.subjectId", "recruiter-1");
    expect(restBody).toHaveProperty("sourceReferences.0.status", "fresh");
    expect(mcpResponse.status).toBe(200);
    expect(mcpBody).toHaveProperty(
      "result.structuredContent.evaluation.status",
      "passed"
    );
    expect(mcpBody).toHaveProperty(
      "result.structuredContent.binding.trust",
      "attested"
    );
    expect(mcpBody).toHaveProperty(
      "result.structuredContent.binding.actor.subjectId",
      "recruiter-1"
    );
    expect(mcpBody).toHaveProperty(
      "result.structuredContent.sourceReferences.0.status",
      "fresh"
    );
  });

  it("rejects untrusted or missing origins before cookie-authenticated write effects", async () => {
    let bodyReads = 0;
    let resolverCalls = 0;
    const countedResolver = (headers: Headers, requestId: string) => {
      resolverCalls += 1;
      return resolvePrincipal(headers, requestId);
    };
    const csrfProtectedRest = createRestCapabilityHandler(
      bundle.registry,
      restRoutesFromRegistry(bundle.registry),
      countedResolver,
      { allowedCookieOrigin: allowedOrigin }
    );
    const onBodyRead = () => {
      bodyReads += 1;
    };
    const cookie = "better-auth.session_token=valid-session";

    const untrusted = await csrfProtectedRest(
      createRestContext(
        new Headers({ Cookie: cookie, Origin: "https://evil.example" }),
        { onBodyRead }
      )
    );
    const missing = await csrfProtectedRest(
      createRestContext(new Headers({ Cookie: cookie }), { onBodyRead })
    );

    expect(untrusted.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(resolverCalls).toBe(0);
    expect(bodyReads).toBe(0);
  });

  it("applies the canonical Origin check before a direct MCP write probe", async () => {
    let bodyReads = 0;
    let resolverCalls = 0;
    const countedResolver = (headers: Headers, requestId: string) => {
      resolverCalls += 1;
      return resolvePrincipal(headers, requestId);
    };
    const csrfProtectedMcp = createMcpHandler(
      bundle.registry,
      countedResolver,
      {
        allowedCookieOrigin: allowedOrigin,
        allowedHost: "server.test",
        entries: bundle.entries,
      }
    );
    const cookie = "better-auth.session_token=valid-session";
    const options = {
      arguments: { naam: "MCP write probe", query: "Azure" },
      onBodyRead: () => {
        bodyReads += 1;
      },
    };

    const untrusted = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({ Cookie: cookie, Origin: "https://evil.example" }),
      "create_saved_search",
      options
    );
    const missing = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({ Cookie: cookie }),
      "create_saved_search",
      options
    );
    const untrustedBearer = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({
        Authorization: validBearer,
        Origin: "https://evil.example",
      }),
      "create_saved_search",
      options
    );
    const wrongSchemeCookie = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({
        Cookie: cookie,
        Origin: "http://app.catapulze.test",
      }),
      "create_saved_search",
      options
    );
    const wrongSchemeBearer = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({
        Authorization: validBearer,
        Origin: "http://app.catapulze.test",
      }),
      "create_saved_search",
      options
    );
    const wrongPortCookie = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({
        Cookie: cookie,
        Origin: "https://app.catapulze.test:444",
      }),
      "create_saved_search",
      options
    );
    const wrongPortBearer = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({
        Authorization: validBearer,
        Origin: "https://app.catapulze.test:444",
      }),
      "create_saved_search",
      options
    );

    expect(untrusted.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(untrustedBearer.status).toBe(403);
    expect(wrongSchemeCookie.status).toBe(403);
    expect(wrongSchemeBearer.status).toBe(403);
    expect(wrongPortCookie.status).toBe(403);
    expect(wrongPortBearer.status).toBe(403);
    expect(bodyReads).toBe(0);
    expect(resolverCalls).toBe(0);

    const allowed = await sendMcpRequest(
      csrfProtectedMcp,
      new Headers({ Cookie: cookie, Origin: allowedOrigin }),
      "create_saved_search",
      options
    );
    const allowedBody = z
      .object({
        result: z.object({
          structuredContent: z.object({ id: z.string() }),
        }),
      })
      .parse(await allowed.json());

    expect(allowed.status).toBe(200);
    // The boundary validates a cloned body before the SDK Hono adapter parses
    // its own clone. Rejected Origins must bypass both reads above.
    expect(bodyReads).toBe(2);
    expect(resolverCalls).toBe(1);
    expect(
      await bundle.deps.stores.savedSearches.getById(
        allowedBody.result.structuredContent.id,
        "recruiter-1",
        bundle.deps.scopeId
      )
    ).not.toBeNull();
  });

  it("maps session lookup outages to sanitized REST and MCP unavailable responses", async () => {
    const events: object[] = [];
    const unavailableResolver = createSessionPrincipalResolver(
      () => Promise.reject(new Error("DO_NOT_EXPOSE_LOOKUP_DETAIL")),
      () => currentTime,
      (event) => events.push(event)
    );
    const unavailableRest = createRestCapabilityHandler(
      bundle.registry,
      restRoutesFromRegistry(bundle.registry),
      unavailableResolver,
      { allowedCookieOrigin: allowedOrigin }
    );
    const unavailableMcp = createMcpHandler(
      bundle.registry,
      unavailableResolver,
      {
        allowedCookieOrigin: allowedOrigin,
        allowedHost: "server.test",
        entries: bundle.entries,
      }
    );
    let restBodyReads = 0;

    const restResponse = await unavailableRest(
      createRestContext(new Headers({ Authorization: validBearer }), {
        onBodyRead: () => {
          restBodyReads += 1;
        },
      })
    );
    const mcpResponse = await sendMcpRequest(
      unavailableMcp,
      new Headers({ Authorization: validBearer })
    );
    const restText = await restResponse.text();
    const mcpText = await mcpResponse.text();

    expect(restResponse.status).toBe(503);
    expect(mcpResponse.status).toBe(503);
    expect(restBodyReads).toBe(0);
    expect(restText).toContain('"code":"AUTH_SESSION_UNAVAILABLE"');
    expect(mcpText).toContain('"code":-32603');
    expect(`${restText}${mcpText}${JSON.stringify(events)}`).not.toContain(
      "DO_NOT_EXPOSE_LOOKUP_DETAIL"
    );
    expect(events).toHaveLength(2);
  });

  it("rejects expired and invalid sessions on both transports", async () => {
    const expiredHeaders = new Headers({ Authorization: expiredBearer });
    const invalidHeaders = new Headers({
      Authorization: "Bearer invalid.signed-session",
    });

    const [expiredRest, invalidRest, expiredMcp, invalidMcp] =
      await Promise.all([
        rest(createRestContext(expiredHeaders)),
        rest(createRestContext(invalidHeaders)),
        sendMcpRequest(mcp, expiredHeaders),
        sendMcpRequest(mcp, invalidHeaders),
      ]);

    expect(expiredRest.status).toBe(401);
    expect(invalidRest.status).toBe(401);
    expect(expiredMcp.status).toBe(401);
    expect(invalidMcp.status).toBe(401);
  });
});
