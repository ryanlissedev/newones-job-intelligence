import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";

import { createTestSliceARegistry } from "@ji/application/registry";
import type { SliceARole } from "@ji/application/registry";
import {
  Client,
  InMemoryResponseCacheStore,
  INVALID_PARAMS,
  isJSONRPCRequest,
  parseJSONRPCMessage,
  ProtocolError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  FetchLike,
  ListToolsResult,
  ResponseCacheStore,
} from "@modelcontextprotocol/client";
import { Hono } from "hono";

import { createSessionPrincipalResolver } from "./auth";
import type { CapabilityAvailability } from "./capability-availability";
import { createMcpHandler } from "./mcp";
import {
  MCP_CATALOG_CACHE_HINTS,
  MCP_CATALOG_CACHE_TTL_MS,
  sortMcpCatalogTools,
} from "./mcp-catalog-cache";

const serverUrl = new URL("http://server.test/mcp");
const allowedOrigin = "https://app.catapulze.test";
const fixtureEpoch = new Date("2026-09-05T00:00:00.000Z");
const mcpProtocolVersion = "2026-07-28";

interface FixtureSession {
  readonly subject: string;
  role: SliceARole;
}

interface FixtureCounters {
  authResolutions: number;
  instrumentationOverheadMs: number;
  responseBytes: number;
  searchExecutions: number;
  serverLatencyMs: number;
  snapshotReads: number;
  toolCallRequests: number;
  toolsListRequests: number;
}

interface FixtureEnvironment {
  readonly counters: FixtureCounters;
  readonly disableCapabilities: Map<string, CapabilityAvailability>;
  readonly fetch: FetchLike;
  readonly sessions: Map<string, FixtureSession>;
}

const resetFixtureCounters = (counters: FixtureCounters): void => {
  counters.authResolutions = 0;
  counters.instrumentationOverheadMs = 0;
  counters.responseBytes = 0;
  counters.searchExecutions = 0;
  counters.serverLatencyMs = 0;
  counters.snapshotReads = 0;
  counters.toolCallRequests = 0;
  counters.toolsListRequests = 0;
};

const tokenPartition = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const catalogDigest = (result: ListToolsResult): string =>
  createHash("sha256").update(JSON.stringify(result.tools)).digest("hex");

const requestMethod = async (request: Request): Promise<string | undefined> => {
  try {
    const message = parseJSONRPCMessage(await request.clone().json());
    return isJSONRPCRequest(message) ? message.method : undefined;
  } catch {
    return undefined;
  }
};

const bearerToken = (headers: Headers): string => {
  const authorization = headers.get("Authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
};

const createFixtureEnvironment = (): FixtureEnvironment => {
  const counters: FixtureCounters = {
    authResolutions: 0,
    instrumentationOverheadMs: 0,
    responseBytes: 0,
    searchExecutions: 0,
    serverLatencyMs: 0,
    snapshotReads: 0,
    toolCallRequests: 0,
    toolsListRequests: 0,
  };
  const sessions = new Map<string, FixtureSession>([
    ["admin-a", { role: "admin", subject: "user-a" }],
    ["admin-a-rotated", { role: "admin", subject: "user-a" }],
    ["recruiter-b", { role: "recruiter", subject: "user-b" }],
  ]);
  const disableCapabilities = new Map([
    [
      "commit_export",
      {
        reason: "Export unavailable in cache fixture",
        safeNextStep: "Use fixture readback",
        status: "disabled" as const,
      },
    ],
    [
      "complete_task",
      {
        reason: "Completion unavailable in cache fixture",
        safeNextStep: "Use fixture readback",
        status: "fixture-stub" as const,
      },
    ],
  ]);
  const bundle = createTestSliceARegistry();
  const originalSnapshotRead = bundle.deps.stores.snapshots.getById.bind(
    bundle.deps.stores.snapshots
  );
  Object.defineProperty(bundle.deps.stores.snapshots, "getById", {
    value: (id: string, scopeId: string) => {
      counters.snapshotReads += 1;
      return originalSnapshotRead(id, scopeId);
    },
  });
  const originalSearch = bundle.deps.engine.search.bind(bundle.deps.engine);
  Object.defineProperty(bundle.deps.engine, "search", {
    value: (...args: Parameters<typeof originalSearch>) => {
      counters.searchExecutions += 1;
      return originalSearch(...args);
    },
  });
  const resolvePrincipal = createSessionPrincipalResolver(
    (headers) => {
      counters.authResolutions += 1;
      const session = sessions.get(bearerToken(headers));
      return Promise.resolve(
        session
          ? {
              session: { expiresAt: "2026-12-31T00:00:00.000Z" },
              user: { id: session.subject, role: session.role },
            }
          : null
      );
    },
    () => new Date(Date.now())
  );
  const handler = createMcpHandler(bundle.registry, resolvePrincipal, {
    allowedCookieOrigin: allowedOrigin,
    allowedHost: serverUrl.hostname,
    entries: bundle.entries,
    unavailableCapabilities: disableCapabilities,
  });
  const app = new Hono();
  app.post("/mcp", (context) => handler(context));

  const fixtureFetch: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Host", serverUrl.host);
    const request = new Request(input.toString(), { ...init, headers });
    const requestInspectionStarted = performance.now();
    const method = await requestMethod(request);
    counters.instrumentationOverheadMs +=
      performance.now() - requestInspectionStarted;

    const serverStarted = performance.now();
    const response = await app.fetch(request);
    counters.serverLatencyMs += performance.now() - serverStarted;

    if (method === "tools/list") {
      const responseInspectionStarted = performance.now();
      counters.toolsListRequests += 1;
      counters.responseBytes += new TextEncoder().encode(
        await response.clone().text()
      ).byteLength;
      counters.instrumentationOverheadMs +=
        performance.now() - responseInspectionStarted;
    }
    if (method === "tools/call") {
      counters.toolCallRequests += 1;
    }
    return response;
  };

  return { counters, disableCapabilities, fetch: fixtureFetch, sessions };
};

const createFixtureClient = async (input: {
  readonly cache: ResponseCacheStore;
  readonly environment: FixtureEnvironment;
  readonly token: string;
}): Promise<Client> => {
  const client = new Client(
    { name: "catapulze-cache-test-client", version: "2.0.0" },
    {
      cachePartition: tokenPartition(input.token),
      responseCacheStore: input.cache,
      versionNegotiation: { mode: { pin: mcpProtocolVersion } },
    }
  );
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    fetch: input.environment.fetch,
    requestInit: {
      headers: { Authorization: `Bearer ${input.token}` },
    },
  });
  await client.connect(transport);
  return client;
};

const snapshotCounters = (counters: FixtureCounters): FixtureCounters => ({
  ...counters,
});

const rejectedReason = async (
  operation: Promise<unknown>
): Promise<ProtocolError | SdkHttpError> => {
  const [settled] = await Promise.allSettled([operation]);
  if (!settled || settled.status === "fulfilled") {
    throw new Error("Expected operation to reject");
  }
  if (
    ProtocolError.isInstance(settled.reason) ||
    SdkHttpError.isInstance(settled.reason)
  ) {
    return settled.reason;
  }
  throw new Error("Expected an MCP protocol or HTTP error");
};

afterEach(() => {
  setSystemTime();
});

describe("MCP catalog cache policy", () => {
  it("uses official private cache hints and deterministic catalog ordering", () => {
    expect(MCP_CATALOG_CACHE_HINTS).toEqual({
      "server/discover": { cacheScope: "private", ttlMs: 30_000 },
      "tools/list": { cacheScope: "private", ttlMs: 30_000 },
    });
    expect(
      sortMcpCatalogTools([
        { name: "zeta" },
        { name: "alpha" },
        { name: "middle" },
      ]).map((tool) => tool.name)
    ).toEqual(["alpha", "middle", "zeta"]);
  });

  it("emits private catalog hints and advertises no change stream", async () => {
    setSystemTime(fixtureEpoch);
    const environment = createFixtureEnvironment();
    const client = await createFixtureClient({
      cache: new InMemoryResponseCacheStore(),
      environment,
      token: "admin-a",
    });

    const rawDiscoveryResponse = await environment.fetch(serverUrl, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/protocolVersion": mcpProtocolVersion,
          },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer admin-a",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": mcpProtocolVersion,
        "Mcp-Method": "server/discover",
      },
      method: "POST",
    });
    expect(rawDiscoveryResponse.status).toBe(200);
    const rawDiscovery = await rawDiscoveryResponse.json();
    expect(rawDiscovery).toMatchObject({
      result: {
        cacheScope: "private",
        capabilities: { tools: {} },
        resultType: "complete",
        ttlMs: MCP_CATALOG_CACHE_TTL_MS,
      },
    });
    expect(rawDiscovery).toHaveProperty("result.capabilities", { tools: {} });
    expect(rawDiscovery).not.toHaveProperty(
      "result.capabilities.tools.listChanged"
    );
    expect(rawDiscovery).not.toHaveProperty(
      "result.capabilities.resources.subscribe"
    );
    expect(rawDiscovery).not.toHaveProperty(
      "result.capabilities.resources.listChanged"
    );

    const listed = await client.request({
      method: "tools/list",
      params: {},
    });
    expect(listed).toMatchObject({
      cacheScope: "private",
      ttlMs: MCP_CATALOG_CACHE_TTL_MS,
    });

    const called = await client.callTool({
      arguments: {},
      name: "list_bronnen",
    });
    expect(called).not.toHaveProperty("cacheScope");
    expect(called).not.toHaveProperty("ttlMs");
    await client.close();
  });

  it("reuses the real Catapulze catalog within TTL and refetches after expiry", async () => {
    setSystemTime(fixtureEpoch);
    const baselineEnvironment = createFixtureEnvironment();
    const baselineClient = await createFixtureClient({
      cache: new InMemoryResponseCacheStore(),
      environment: baselineEnvironment,
      token: "admin-a",
    });
    resetFixtureCounters(baselineEnvironment.counters);
    const baselineStarted = performance.now();
    const baselineFirst = await baselineClient.listTools(undefined, {
      cacheMode: "bypass",
    });
    const baselineSecond = await baselineClient.listTools(undefined, {
      cacheMode: "bypass",
    });
    const baselineElapsedMs = performance.now() - baselineStarted;
    await baselineClient.close();

    const cachedEnvironment = createFixtureEnvironment();
    const cachedClient = await createFixtureClient({
      cache: new InMemoryResponseCacheStore(),
      environment: cachedEnvironment,
      token: "admin-a",
    });
    resetFixtureCounters(cachedEnvironment.counters);
    const cachedStarted = performance.now();
    const cachedFirst = await cachedClient.listTools();
    const cachedSecond = await cachedClient.listTools();
    const cachedElapsedMs = performance.now() - cachedStarted;
    const cachedWithinTtl = snapshotCounters(cachedEnvironment.counters);

    expect(cachedWithinTtl.toolsListRequests).toBe(1);
    expect(cachedSecond.tools).toEqual(cachedFirst.tools);
    setSystemTime(
      new Date(fixtureEpoch.getTime() + MCP_CATALOG_CACHE_TTL_MS + 1)
    );
    const refreshed = await cachedClient.listTools();
    await cachedClient.close();

    expect(cachedEnvironment.counters.toolsListRequests).toBe(2);
    expect(refreshed.tools).toEqual(cachedFirst.tools);
    const digest = catalogDigest(cachedFirst);
    expect(catalogDigest(baselineFirst)).toBe(digest);
    expect(catalogDigest(baselineSecond)).toBe(digest);

    const evidence = {
      after: {
        catalogDigest: digest,
        elapsedMs: cachedElapsedMs,
        instrumentationOverheadMs: cachedWithinTtl.instrumentationOverheadMs,
        requests: cachedWithinTtl.toolsListRequests,
        responseBytes: cachedWithinTtl.responseBytes,
        serverLatencyMs: cachedWithinTtl.serverLatencyMs,
      },
      before: {
        catalogDigest: digest,
        elapsedMs: baselineElapsedMs,
        instrumentationOverheadMs:
          baselineEnvironment.counters.instrumentationOverheadMs,
        requests: baselineEnvironment.counters.toolsListRequests,
        responseBytes: baselineEnvironment.counters.responseBytes,
        serverLatencyMs: baselineEnvironment.counters.serverLatencyMs,
      },
      client: "@modelcontextprotocol/client@2.0.0",
      fixture: "createTestSliceARegistry with synthetic in-memory stores",
      server: "@modelcontextprotocol/server@2.0.0",
    };
    expect(evidence.before.requests).toBe(2);
    expect(evidence.after.requests).toBe(1);
    expect(evidence.after.responseBytes).toBeLessThan(
      evidence.before.responseBytes
    );
    process.stdout.write(`MCP_CACHE_FIXTURE ${JSON.stringify(evidence)}\n`);
  });

  it("isolates private entries for two users and two tokens of one user", async () => {
    setSystemTime(fixtureEpoch);
    const environment = createFixtureEnvironment();
    const sharedCache = new InMemoryResponseCacheStore();
    await Promise.all(
      ["admin-a", "admin-a-rotated", "recruiter-b"].map(async (token) => {
        const client = await createFixtureClient({
          cache: sharedCache,
          environment,
          token,
        });
        await client.listTools();
        await client.close();
      })
    );

    expect(environment.counters.toolsListRequests).toBe(3);
  });

  it("rechecks authentication and policy for every cached-catalog tool call", async () => {
    setSystemTime(fixtureEpoch);
    const environment = createFixtureEnvironment();
    const client = await createFixtureClient({
      cache: new InMemoryResponseCacheStore(),
      environment,
      token: "admin-a",
    });
    const initial = await client.listTools();
    const initialNames = initial.tools.map((tool) => tool.name);
    expect(initialNames).toContain("approve_snapshot");
    expect(initialNames).toContain("list_bronnen");
    expect(initialNames).toContain("search_aanvragen");
    expect(initialNames).toContain("commit_export");
    const afterCachedCatalog = snapshotCounters(environment.counters);

    const adminSession = environment.sessions.get("admin-a");
    if (adminSession === undefined) {
      throw new Error("Missing admin fixture session");
    }
    adminSession.role = "recruiter";
    const roleLossError = await rejectedReason(
      client.callTool({
        arguments: {
          expiresAt: "2026-12-31T00:00:00.000Z",
          id: "00000000-0000-4000-8000-000000000030",
          motivatie: "Synthetic cache authorization fixture",
        },
        name: "approve_snapshot",
      })
    );
    expect(ProtocolError.isInstance(roleLossError)).toBe(true);
    expect(roleLossError).toMatchObject({
      code: INVALID_PARAMS,
      message: "Unknown or unavailable tool: approve_snapshot",
    });
    expect(environment.counters.snapshotReads).toBe(0);

    environment.disableCapabilities.set("search_aanvragen", {
      reason: "Search unavailable after policy change",
      safeNextStep: "Retry the read-only search after recovery",
      status: "disabled",
    });
    const disabledResult = await client.callTool({
      arguments: { query: "Azure" },
      name: "search_aanvragen",
    });
    expect(disabledResult.isError).toBe(true);
    const [disabledContent] = disabledResult.content;
    if (disabledContent?.type !== "text") {
      throw new Error("Expected disabled capability error content");
    }
    expect(JSON.parse(disabledContent.text)).toEqual({
      error: {
        code: "CAPABILITY_DISABLED",
        message: "Search unavailable after policy change",
        requestId: expect.any(String),
      },
      ok: false,
    });
    expect(environment.counters.searchExecutions).toBe(0);

    environment.sessions.delete("admin-a");
    const revokedCredentialError = await rejectedReason(
      client.callTool({ arguments: {}, name: "list_bronnen" })
    );
    expect(SdkHttpError.isInstance(revokedCredentialError)).toBe(true);
    expect(revokedCredentialError).toMatchObject({
      code: SdkErrorCode.ClientHttpNotImplemented,
      data: {
        status: 401,
        text: expect.stringContaining("Authentication required"),
      },
    });
    environment.sessions.set("admin-a", adminSession);

    expect(environment.counters.toolCallRequests).toBe(
      afterCachedCatalog.toolCallRequests + 3
    );
    expect(environment.counters.authResolutions).toBe(
      afterCachedCatalog.authResolutions + 3
    );
    expect(environment.counters.toolsListRequests).toBe(
      afterCachedCatalog.toolsListRequests
    );

    setSystemTime(
      new Date(fixtureEpoch.getTime() + MCP_CATALOG_CACHE_TTL_MS + 1)
    );
    const afterPolicyChange = await client.listTools();
    await client.close();
    const afterNames = afterPolicyChange.tools.map((tool) => tool.name);
    expect(afterNames).not.toContain("approve_snapshot");
    expect(afterNames).toContain("search_aanvragen");
    expect(
      afterPolicyChange.tools.find((tool) => tool.name === "search_aanvragen")
    ).toMatchObject({
      _meta: {
        "catapulze/availability": {
          executable: false,
          status: "disabled",
        },
      },
    });
  });
});
