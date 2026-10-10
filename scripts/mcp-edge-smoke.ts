import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

import { z } from "zod";

import {
  Client,
  StreamableHTTPClientTransport,
} from "../apps/server/node_modules/@modelcontextprotocol/client";
import type { JSONObject } from "../apps/server/node_modules/@modelcontextprotocol/client";
import { readMcpToolPayload } from "./mcp-edge-result";

const PROTOCOL_VERSION = "2026-07-28";
const FIXTURE_ID = "00000000-0000-4000-8000-000000004481";
const edgeUrl = process.env.MCP_EDGE_URL ?? "http://edge:8080";
const sourceSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/u)
  .parse(process.env.MCP_EDGE_SOURCE_SHA);

const rpcEnvelopeSchema = z.object({
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
});
const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});
const searchContentSchema = z
  .object({ ids: z.array(z.string()) })
  .passthrough();
const readContentSchema = z.object({
  aanvraag: z.object({ id: z.string() }).passthrough(),
  markering: z.object({ status: z.literal("relevant") }),
});
const listedToolsSchema = z.object({
  result: z.object({
    tools: z.array(
      z
        .object({
          inputSchema: z.unknown(),
          name: z.string(),
        })
        .passthrough()
    ),
  }),
});
const discoverySchema = z.object({
  supportedVersions: z.array(z.string()),
});
const directResultSchema = z
  .object({
    isError: z.boolean().optional(),
    resultType: z.literal("complete"),
  })
  .passthrough();
const signInSchema = z.object({ user: z.object({ id: z.string() }) });

interface WireTrace {
  readonly contentType: string | null;
  readonly durationMs: number;
  readonly requestId: string;
  readonly status: number;
  readonly upstream: string;
}

interface CaseEvidence extends WireTrace {
  readonly errorCode?: number;
  readonly name: string;
  readonly resultClass: string;
}

type ExpectedResponseId = "request" | "null";

const traceFromResponse = (
  response: Response,
  startedAt: number
): WireTrace => ({
  contentType: response.headers.get("content-type"),
  durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  requestId: z.string().min(1).parse(response.headers.get("x-request-id")),
  status: response.status,
  upstream: z
    .string()
    .regex(/^\d{1,3}(?:\.\d{1,3}){3}:3000$/u)
    .parse(response.headers.get("x-catapulze-upstream")),
});

const requireAlternation = (traces: readonly WireTrace[]): void => {
  const upstreams = new Set(traces.map((trace) => trace.upstream));
  if (upstreams.size !== 2) {
    throw new Error(
      `Expected two upstream instances, received ${upstreams.size}`
    );
  }
  for (let index = 1; index < traces.length; index += 1) {
    if (traces[index]?.upstream === traces[index - 1]?.upstream) {
      throw new Error(`Round-robin alternation failed at request ${index + 1}`);
    }
  }
};

const controlledPost = (
  url: URL,
  headers: Headers,
  body: Uint8Array
): Promise<Response> => {
  const { promise, reject, resolve } = Promise.withResolvers<Response>();
  const request = httpRequest(
    url,
    {
      headers: Object.fromEntries(headers.entries()),
      method: "POST",
    },
    (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            responseHeaders.append(name, value);
          }
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            headers: responseHeaders,
            status: incoming.statusCode ?? 500,
          })
        );
      });
    }
  );
  request.on("error", reject);
  request.setTimeout(5000, () => {
    request.destroy(new Error("Raw MCP request timed out"));
  });
  request.end(body);
  return promise;
};

const modernParams = (
  params: JSONObject = {},
  protocolVersion = PROTOCOL_VERSION
) => ({
  ...params,
  _meta: {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
  },
});

const signIn = await fetch(`${edgeUrl}/api/auth/sign-in/email`, {
  body: JSON.stringify({
    email: "edge-smoke-user@example.invalid",
    password: "synthetic-edge-smoke-password",
  }),
  headers: { "Content-Type": "application/json", Origin: edgeUrl },
  method: "POST",
});
if (!signIn.ok) {
  throw new Error(`Synthetic sign-in failed with HTTP ${signIn.status}`);
}
signInSchema.parse(await signIn.clone().json());
const sessionCookie = signIn.headers
  .getSetCookie()
  .map((cookie) => cookie.split(";", 1)[0])
  .find((cookie) => cookie?.includes("session_token="));
if (!sessionCookie) {
  throw new Error("Synthetic sign-in returned no session cookie");
}

const clientTraces: WireTrace[] = [];
const tracedFetch = async (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const requestHeaders = new Headers(
    input instanceof Request ? input.headers : init?.headers
  );
  if (requestHeaders.has("mcp-session-id")) {
    throw new Error("Official client attempted sticky MCP session routing");
  }
  const startedAt = performance.now();
  const response = await fetch(input, init);
  if (response.headers.has("mcp-session-id")) {
    throw new Error("Server emitted an MCP session identifier");
  }
  clientTraces.push(traceFromResponse(response, startedAt));
  return response;
};

const sendDirectThroughOfficialTransport = async (id: number) => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${edgeUrl}/mcp`),
    {
      fetch: tracedFetch,
      requestInit: {
        headers: {
          Authorization: `Bearer ${z.string().min(1).parse(signIn.headers.get("set-auth-token"))}`,
        },
      },
    }
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let response: z.output<typeof rpcEnvelopeSchema>;
  try {
    await transport.start();
    transport.setProtocolVersion(PROTOCOL_VERSION);
    const responsePromise = Promise.withResolvers<unknown>();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The SDK transport exposes callback properties, not EventTarget methods.
    transport.onmessage = responsePromise.resolve;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The SDK transport exposes callback properties, not EventTarget methods.
    transport.onerror = responsePromise.reject;
    const timeoutPromise = Promise.withResolvers<never>();
    timeout = setTimeout(
      () => timeoutPromise.reject(new Error("Official direct call timed out")),
      5000
    );
    response = rpcEnvelopeSchema.parse(
      await Promise.race([
        (async () => {
          await transport.send({
            id,
            jsonrpc: "2.0",
            method: "tools/call",
            params: modernParams({ arguments: {}, name: "list_bronnen" }),
          });
          return responsePromise.promise;
        })(),
        timeoutPromise.promise,
      ])
    );
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await transport.close();
  }
  const result = directResultSchema.parse(response.result);
  if (response.id !== id || result.isError === true) {
    throw new Error("Official direct call returned an invalid response");
  }
  return result;
};

const firstDirectResult = await sendDirectThroughOfficialTransport(4478);
const secondDirectResult = await sendDirectThroughOfficialTransport(4479);
const directTraces = [...clientTraces];
if (directTraces.length !== 2) {
  throw new Error("Official direct calls made an unexpected wire request");
}
requireAlternation(directTraces);
const directResultDigests = [firstDirectResult, secondDirectResult].map(
  (result) => createHash("sha256").update(JSON.stringify(result)).digest("hex")
);
if (directResultDigests[0] !== directResultDigests[1]) {
  throw new Error("Direct result differs between upstream instances");
}
clientTraces.length = 0;

const client = new Client(
  { name: "catapulze-rjc448-edge-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
);
const transport = new StreamableHTTPClientTransport(new URL(`${edgeUrl}/mcp`), {
  fetch: tracedFetch,
  requestInit: {
    headers: {
      Authorization: `Bearer ${z.string().min(1).parse(signIn.headers.get("set-auth-token"))}`,
    },
  },
});
await client.connect(transport);
clientTraces.length = 0;

const discovery = discoverySchema.parse(
  await client.request({ method: "server/discover", params: {} })
);
if (!discovery.supportedVersions.includes(PROTOCOL_VERSION)) {
  throw new Error("Pinned protocol version missing from discovery");
}
const listed = await client.listTools(undefined, { cacheMode: "bypass" });
if (
  !listed.tools.some(
    (tool: { readonly name: string }) => tool.name === "search_aanvragen"
  )
) {
  throw new Error("Expected search_aanvragen in official client catalog");
}
const searchContent = searchContentSchema.parse(
  readMcpToolPayload(
    await client.callTool({
      arguments: { query: "RJC448" },
      name: "search_aanvragen",
    })
  )
);
if (!searchContent.ids.includes(FIXTURE_ID)) {
  throw new Error("Official client search failed");
}
const marked = toolResultSchema.parse(
  await client.callTool({
    arguments: { aanvraagId: FIXTURE_ID, status: "relevant" },
    name: "markeer_aanvraag",
  })
);
if (marked.isError === true) {
  throw new TypeError("Official client mark failed");
}
const readContent = readContentSchema.parse(
  readMcpToolPayload(
    await client.callTool({
      arguments: { id: FIXTURE_ID },
      name: "get_aanvraag",
    })
  )
);
if (readContent.aanvraag.id !== FIXTURE_ID) {
  throw new Error(
    "Official client read did not observe the cross-instance mark"
  );
}
requireAlternation(clientTraces);
await client.close();

interface RawRequestInput {
  readonly accept?: string | null;
  readonly auth?: "bearer" | "cookie" | "invalid-with-cookie" | "omit";
  readonly bodyMethod?: string;
  readonly contentType?: string | null;
  readonly headerMethod?: string | null;
  readonly headerName?: string | null;
  readonly headerVersion?: string | null;
  readonly name: string;
  readonly origin?: string;
  readonly params?: JSONObject;
  readonly protocolVersion?: string;
}

const buildRawHeaders = (
  input: RawRequestInput,
  bodyMethod: string,
  edgeRequestId: string
): Headers => {
  const headers = new Headers();
  if (input.accept !== null) {
    headers.set(
      "Accept",
      input.accept ?? "application/json, text/event-stream"
    );
  }
  if (input.auth === "cookie") {
    headers.set("Cookie", sessionCookie);
  } else if (input.auth === "invalid-with-cookie") {
    headers.set("Authorization", "Bearer invalid.synthetic.signature");
    headers.set("Cookie", sessionCookie);
  } else if (input.auth !== "omit") {
    headers.set(
      "Authorization",
      `Bearer ${z.string().min(1).parse(signIn.headers.get("set-auth-token"))}`
    );
  }
  if (input.contentType !== null) {
    headers.set("Content-Type", input.contentType ?? "application/json");
  }
  if (input.origin !== "") {
    headers.set("Origin", input.origin ?? edgeUrl);
  }
  if (input.headerVersion !== null) {
    headers.set(
      "MCP-Protocol-Version",
      input.headerVersion ?? PROTOCOL_VERSION
    );
  }
  if (input.headerMethod !== null) {
    headers.set("Mcp-Method", input.headerMethod ?? bodyMethod);
  }
  headers.set("X-Request-Id", edgeRequestId);
  const toolName = z.string().safeParse(input.params?.name);
  if (input.headerName !== null && toolName.success) {
    headers.set("Mcp-Name", input.headerName ?? toolName.data);
  }
  return headers;
};

let rpcId = 4480;
const rawRequest = async (input: RawRequestInput) => {
  rpcId += 1;
  const bodyMethod = input.bodyMethod ?? "tools/list";
  const edgeRequestId = `rjc448-${rpcId}`;
  const headers = buildRawHeaders(input, bodyMethod, edgeRequestId);
  const startedAt = performance.now();
  const response = await controlledPost(
    new URL(`${edgeUrl}/mcp`),
    headers,
    new TextEncoder().encode(
      JSON.stringify({
        id: rpcId,
        jsonrpc: "2.0",
        method: bodyMethod,
        params: modernParams(input.params, input.protocolVersion),
      })
    )
  );
  if (response.headers.has("mcp-session-id")) {
    throw new Error(`${input.name} emitted an MCP session identifier`);
  }
  const trace = traceFromResponse(response, startedAt);
  const envelope = rpcEnvelopeSchema.parse(await response.json());
  if (trace.requestId !== edgeRequestId) {
    throw new Error(`${input.name} did not preserve edge request correlation`);
  }
  return { envelope, requestRpcId: rpcId, response, trace };
};

const catalogResponses = [
  await rawRequest({ name: "catalog-a" }),
  await rawRequest({ name: "catalog-b" }),
];
requireAlternation(catalogResponses.map(({ trace }) => trace));
const catalogEvidence = catalogResponses.map(
  ({ envelope, requestRpcId, trace }) => {
    if (envelope.id !== requestRpcId) {
      throw new Error("Catalog response did not preserve its JSON-RPC ID");
    }
    const { tools } = listedToolsSchema.parse(envelope).result;
    const digest = createHash("sha256")
      .update(JSON.stringify(tools))
      .digest("hex");
    return { digest, resultClass: "success", ...trace };
  }
);
if (catalogEvidence[0]?.digest !== catalogEvidence[1]?.digest) {
  throw new Error("Catalog digest differs between upstream instances");
}

const caseInputs = [
  { headerVersion: null, name: "missing-protocol-version" },
  { headerMethod: null, name: "missing-method" },
  { headerMethod: "tools/call", name: "conflicting-method" },
  {
    bodyMethod: "tools/call",
    headerName: null,
    name: "missing-name",
    params: { arguments: {}, name: "list_bronnen" },
  },
  {
    bodyMethod: "tools/call",
    headerName: "search_aanvragen",
    name: "conflicting-name",
    params: { arguments: {}, name: "list_bronnen" },
  },
  { headerVersion: "2026-07-28-preview", name: "conflicting-version" },
  {
    headerVersion: "2099-01-01",
    name: "unsupported-version",
    protocolVersion: "2099-01-01",
  },
  { auth: "omit", name: "missing-auth", origin: "" },
  { auth: "invalid-with-cookie", name: "invalid-auth-with-cookie" },
  { auth: "cookie", name: "missing-cookie-origin", origin: "" },
  { name: "wrong-origin", origin: "https://wrong.example" },
  { contentType: null, name: "missing-content-type" },
  { contentType: "text/plain", name: "wrong-content-type" },
] as const;
const expected = new Map<string, readonly [number, number, ExpectedResponseId]>(
  [
    ["missing-protocol-version", [400, -32_020, "request"]],
    ["missing-method", [400, -32_020, "request"]],
    ["conflicting-method", [400, -32_020, "request"]],
    ["missing-name", [400, -32_020, "request"]],
    ["conflicting-name", [400, -32_020, "request"]],
    ["conflicting-version", [400, -32_020, "request"]],
    ["unsupported-version", [400, -32_022, "request"]],
    ["missing-auth", [401, -32_003, "null"]],
    ["invalid-auth-with-cookie", [401, -32_003, "null"]],
    ["missing-cookie-origin", [403, -32_003, "null"]],
    ["wrong-origin", [403, -32_003, "null"]],
    ["missing-content-type", [415, -32_000, "null"]],
    ["wrong-content-type", [415, -32_000, "null"]],
  ]
);
const cases: CaseEvidence[] = [];
for (const input of caseInputs) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential requests are the round-robin assertion under test.
  const { envelope, requestRpcId, response, trace } = await rawRequest(input);
  const expectation = expected.get(input.name);
  const expectedId = expectation?.[2] === "request" ? requestRpcId : null;
  if (
    !expectation ||
    response.status !== expectation[0] ||
    envelope.error?.code !== expectation[1] ||
    envelope.id !== expectedId
  ) {
    throw new Error(`${input.name} returned an unexpected protocol error`);
  }
  cases.push({
    errorCode: envelope.error.code,
    name: input.name,
    resultClass: "client-error",
    ...trace,
  });
}

for (const input of [
  { auth: "cookie", name: "cookie-auth-positive" },
  { accept: null, name: "accept-omitted" },
  { accept: "text/plain", name: "accept-text-plain" },
  { accept: "application/xml", name: "accept-application-xml" },
  { accept: "text/event-stream", name: "accept-sse-only" },
] as const) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential requests are the round-robin assertion under test.
  const { envelope, requestRpcId, response, trace } = await rawRequest(input);
  if (
    response.status !== 200 ||
    envelope.id !== requestRpcId ||
    envelope.result === undefined ||
    !trace.contentType?.includes("application/json")
  ) {
    throw new Error(`${input.name} did not preserve request-scoped JSON mode`);
  }
  cases.push({ name: input.name, resultClass: "success-json", ...trace });
}

const versions = await Promise.all([
  fetch(`${edgeUrl}/version`),
  fetch(`${edgeUrl}/version`),
]);
const runtimeSources = await Promise.all(
  versions.map(async (response) => ({
    releaseSha: z
      .object({ releaseSha: z.literal(sourceSha) })
      .parse(await response.json()).releaseSha,
    upstream: z
      .string()
      .min(1)
      .parse(response.headers.get("x-catapulze-upstream")),
  }))
);
if (new Set(runtimeSources.map(({ upstream }) => upstream)).size !== 2) {
  throw new Error("Version probes did not reach both upstream instances");
}

process.stdout.write(
  `${JSON.stringify(
    {
      cases,
      catalog: catalogEvidence,
      client: {
        operations: ["server/discover", "tools/list", "search", "mark", "read"],
        protocolVersion: PROTOCOL_VERSION,
        sdk: "@modelcontextprotocol/client@2.0.0",
        traces: clientTraces,
      },
      directCall: {
        resultClass: "success",
        resultDigest: directResultDigests[0],
        traces: directTraces,
      },
      runtimeSources,
      sourceSha,
      summary: {
        clientWireRequests: clientTraces.length,
        negativeCases: cases.filter(
          ({ resultClass }) => resultClass === "client-error"
        ).length,
        responseMode: "json-request-scoped",
        upstreamCount: 2,
      },
      testVersion: 1,
    },
    null,
    2
  )}\n`
);
