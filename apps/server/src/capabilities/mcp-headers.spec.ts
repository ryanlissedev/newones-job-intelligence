import { describe, expect, it } from "bun:test";

import { createTestSliceARegistry } from "@ji/application/registry";
import { z } from "zod";

import {
  createMcpProtocolFixture,
  MCP_PROTOCOL_VERSION,
  MCP_TEST_BEARER,
} from "./mcp-protocol-fixture";
import type { SliceARegistry } from "./registry-types";
import type { JsonValue, RestJsonBody } from "./transport-boundary";

type ProtocolFixture = ReturnType<typeof createMcpProtocolFixture>;

interface RequestParams {
  readonly _meta?: JsonValue;
  readonly arguments?: RestJsonBody;
  readonly name?: JsonValue;
}

const modernParams = (
  params: Omit<RequestParams, "_meta"> = {},
  metadata?: JsonValue
): RequestParams => ({
  ...params,
  _meta: metadata ?? {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  },
});

const rpcRequest = (method: string, params: RequestParams) => ({
  id: 1,
  jsonrpc: "2.0",
  method,
  params,
});

const sendRequest = (
  fixture: ProtocolFixture,
  method: string,
  params: RequestParams,
  configureHeaders: (headers: Headers) => void = () => {}
): Promise<Response> => {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: MCP_TEST_BEARER,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
  });
  const parsedName = z.string().safeParse(params.name);
  if (parsedName.success) {
    headers.set("Mcp-Name", parsedName.data);
  }
  configureHeaders(headers);
  return fixture.fetch("http://server.test/mcp", {
    body: JSON.stringify(rpcRequest(method, params)),
    headers,
    method: "POST",
  });
};

const errorResponseSchema = z.object({
  error: z.object({ code: z.number() }),
  id: z.union([z.string(), z.number(), z.null()]),
});

const readErrorCode = async (response: Response): Promise<number> =>
  errorResponseSchema.parse(await response.json()).error.code;

const createInvocationCounter = () => {
  const bundle = createTestSliceARegistry();
  let invocationCount = 0;
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
  return { count: () => invocationCount, entries: bundle.entries, registry };
};

describe("MCP 2026-07-28 request headers and envelope", () => {
  it("rejects each missing routing or version header before invocation", async () => {
    const counter = createInvocationCounter();
    const fixture = createMcpProtocolFixture(counter);
    const params = modernParams({ arguments: {}, name: "list_bronnen" });
    const results = await Promise.all(
      ["MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"].map(
        async (missingHeader) => {
          const response = await sendRequest(
            fixture,
            "tools/call",
            params,
            (headers) => headers.delete(missingHeader)
          );
          const error = errorResponseSchema.parse(await response.json());
          return {
            code: error.error.code,
            id: error.id,
            missingHeader,
            status: response.status,
          };
        }
      )
    );

    for (const result of results) {
      expect(result.status).toBe(400);
      expect(result.code).toBe(-32_020);
    }
    expect(
      results.find((result) => result.missingHeader === "MCP-Protocol-Version")
        ?.id
    ).toBe(1);
    expect(counter.count()).toBe(0);
  });

  it("echoes a readable string id when the protocol version header is missing", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const response = await fixture.fetch("http://server.test/mcp", {
      body: JSON.stringify({
        ...rpcRequest("tools/list", modernParams()),
        id: "request-correlation",
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: MCP_TEST_BEARER,
        "Content-Type": "application/json",
        "Mcp-Method": "tools/list",
      },
      method: "POST",
    });
    const error = errorResponseSchema.parse(await response.json());

    expect(response.status).toBe(400);
    expect(error.error.code).toBe(-32_020);
    expect(error.id).toBe("request-correlation");
  });

  it("rejects either missing modern envelope field before invocation", async () => {
    const counter = createInvocationCounter();
    const fixture = createMcpProtocolFixture(counter);
    const incompleteMetadata: JsonValue[] = [
      { "io.modelcontextprotocol/clientCapabilities": {} },
      { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION },
    ];
    const results = await Promise.all(
      incompleteMetadata.map(async (metadata) => {
        const response = await sendRequest(
          fixture,
          "tools/list",
          modernParams({}, metadata)
        );
        return { code: await readErrorCode(response), status: response.status };
      })
    );

    for (const result of results) {
      expect(result.status).toBe(400);
      expect(result.code).toBe(-32_602);
    }
    expect(counter.count()).toBe(0);
  });

  it("rejects mismatched names and versions before invocation", async () => {
    const counter = createInvocationCounter();
    const fixture = createMcpProtocolFixture(counter);
    const params = modernParams({ arguments: {}, name: "list_bronnen" });
    const wrongName = await sendRequest(
      fixture,
      "tools/call",
      params,
      (headers) => headers.set("Mcp-Name", "search_aanvragen")
    );
    const wrongVersion = await sendRequest(
      fixture,
      "tools/call",
      params,
      (headers) => headers.set("MCP-Protocol-Version", "2026-07-28-preview")
    );
    const [wrongNameCode, wrongVersionCode] = await Promise.all([
      readErrorCode(wrongName),
      readErrorCode(wrongVersion),
    ]);

    expect(wrongName.status).toBe(400);
    expect(wrongNameCode).toBe(-32_020);
    expect(wrongVersion.status).toBe(400);
    expect(wrongVersionCode).toBe(-32_020);
    expect(counter.count()).toBe(0);
  });

  it("treats header names as case-insensitive and values as case-sensitive", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const params = modernParams({ arguments: {}, name: "list_bronnen" });
    const lowercaseNames = await sendRequest(
      fixture,
      "tools/call",
      params,
      (headers) => {
        headers.delete("MCP-Protocol-Version");
        headers.delete("Mcp-Method");
        headers.delete("Mcp-Name");
        headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
        headers.set("mcp-method", "tools/call");
        headers.set("mcp-name", "list_bronnen");
      }
    );
    const wrongCaseValue = await sendRequest(
      fixture,
      "tools/call",
      params,
      (headers) => headers.set("Mcp-Method", "TOOLS/CALL")
    );

    expect(lowercaseNames.status).toBe(200);
    expect(await lowercaseNames.json()).toHaveProperty(
      "result.resultType",
      "complete"
    );
    expect(wrongCaseValue.status).toBe(400);
    expect(await readErrorCode(wrongCaseValue)).toBe(-32_020);
  });

  it("accepts the official Base64 sentinel form for Mcp-Name", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const response = await sendRequest(
      fixture,
      "tools/call",
      modernParams({ arguments: {}, name: "list_bronnen" }),
      (headers) => headers.set("Mcp-Name", "=?base64?bGlzdF9icm9ubmVu?=")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty(
      "result.resultType",
      "complete"
    );
  });

  it("returns JSON without an Accept header in explicit JSON response mode", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const response = await sendRequest(
      fixture,
      "tools/list",
      modernParams(),
      (headers) => headers.delete("Accept")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toHaveProperty(
      "result.resultType",
      "complete"
    );
  });

  it("rejects an unknown tool and malformed tool params as invalid params", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const unknownTool = await sendRequest(
      fixture,
      "tools/call",
      modernParams({ arguments: {}, name: "does_not_exist" })
    );
    const malformedParams = await sendRequest(
      fixture,
      "tools/call",
      modernParams({ arguments: {}, name: 42 }),
      (headers) => headers.set("Mcp-Name", "does_not_exist")
    );
    const [unknownCode, malformedCode] = await Promise.all([
      readErrorCode(unknownTool),
      readErrorCode(malformedParams),
    ]);

    expect(unknownTool.status).toBe(200);
    expect(unknownCode).toBe(-32_602);
    expect(malformedParams.status).toBe(200);
    expect(malformedCode).toBe(-32_602);
  });

  it("returns domain failure as a complete tool error without catalog cache hints", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const response = await sendRequest(
      fixture,
      "tools/call",
      modernParams({
        arguments: { id: "00000000-0000-4000-8000-000000000099" },
        name: "get_aanvraag",
      })
    );
    const body = z
      .object({
        result: z.object({
          cacheScope: z.unknown().optional(),
          isError: z.boolean().optional(),
          resultType: z.string(),
          ttlMs: z.unknown().optional(),
        }),
      })
      .parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.result.resultType).toBe("complete");
    expect(body.result.isError).toBe(true);
    expect(body.result).not.toHaveProperty("ttlMs");
    expect(body.result).not.toHaveProperty("cacheScope");
  });
});
