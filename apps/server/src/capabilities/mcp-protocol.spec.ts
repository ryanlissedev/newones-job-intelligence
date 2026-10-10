import { describe, expect, it } from "bun:test";

import { createTestSliceARegistry } from "@ji/application/registry";
import type { TestSliceARegistryBundle } from "@ji/application/registry";
import { SEARCH_DOCUMENT_PARITY_DEFAULTS } from "@ji/search";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import {
  createMcpProtocolFixture,
  MCP_PROTOCOL_VERSION,
  MCP_TEST_BEARER,
  modernParams,
} from "./mcp-protocol-fixture";
import type { RestJsonBody } from "./transport-boundary";

const aanvraagId = "00000000-0000-4000-8000-000000000010";

const seedAanvraag = (bundle: TestSliceARegistryBundle): void => {
  bundle.deps.stores.aanvragen.seed({
    beschrijving: "Azure platform engineer",
    bronId: "00000000-0000-4000-8000-000000000001",
    bronReferentie: "TN-MCP-1",
    id: aanvraagId,
    rawPayloadRef: "raw/mcp-1.json",
    scrapeRunId: "00000000-0000-4000-8000-000000000020",
    status: "active",
    titel: "Azure engineer",
    versies: [],
  });
};

const rpcRequest = (method: string, params: RestJsonBody = modernParams()) => ({
  id: 1,
  jsonrpc: "2.0",
  method,
  params,
});

const errorBodySchema = z.object({
  error: z.object({ code: z.number() }).optional(),
  result: z.json().optional(),
});
const listedToolsBodySchema = z.object({
  result: z.object({
    tools: z.array(
      z.object({
        _meta: z.object({
          "catapulze/availability": z
            .object({ status: z.string() })
            .passthrough(),
          "catapulze/effect": z.object({
            class: z.enum(["commit", "proposal", "read"]),
            grounded: z.boolean(),
          }),
          "catapulze/outputSchema": z
            .object({ type: z.string() })
            .passthrough(),
          "catapulze/outputSchemaPolicy": z.string(),
        }),
        annotations: z.object({
          destructiveHint: z.boolean().optional(),
          idempotentHint: z.boolean().optional(),
          readOnlyHint: z.boolean(),
        }),
        inputSchema: z.object({ type: z.literal("object") }).passthrough(),
        name: z.string(),
        outputSchema: z
          .object({ type: z.enum(["array", "object"]) })
          .passthrough(),
      })
    ),
  }),
});
const readError = async (response: Response) => {
  const rawBody = await response.json();
  const body = errorBodySchema.parse(rawBody);
  return { body, code: body.error?.code };
};

describe("MCP 2026-07-28 protocol boundary", () => {
  it("discovers and lists a stable permission-filtered schema catalog", async () => {
    const bundle = createTestSliceARegistry();
    const fixture = createMcpProtocolFixture(bundle, "admin");
    const discovery = await fixture.request(
      "server/discover",
      rpcRequest("server/discover")
    );
    expect(discovery.status).toBe(200);
    const discoveryBody = await discovery.json();
    expect(discoveryBody).toHaveProperty("result.resultType", "complete");
    expect(discoveryBody).toHaveProperty(
      "result.supportedVersions.0",
      MCP_PROTOCOL_VERSION
    );

    const listed = await fixture.request(
      "tools/list",
      rpcRequest("tools/list")
    );
    const rawListedBody = await listed.json();
    const listedBody = listedToolsBodySchema.parse(rawListedBody);
    const names = listedBody.result.tools.map((tool) => tool.name);
    expect(names).toEqual(names.toSorted());
    expect(names).toContain("evaluate_sourcing_assessment");
    expect(names).toContain("search_aanvragen");
    expect(names).toContain("start_run");
    expect(names).toContain("complete_task");
    const searchTool = listedBody.result.tools.find(
      (tool) => tool.name === "search_aanvragen"
    );
    expect(searchTool?.inputSchema).toMatchObject({
      type: "object",
    });
    expect(searchTool?.outputSchema).toMatchObject({ type: "object" });
    expect(searchTool?.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      readOnlyHint: true,
    });
    expect(searchTool?._meta).toMatchObject({
      "catapulze/availability": { status: "implemented" },
      "catapulze/effect": { class: "read", grounded: true },
      "catapulze/outputSchema": { type: "object" },
      "catapulze/outputSchemaPolicy": "standard-json-schema",
    });

    for (const toolName of ["start_run", "complete_task"]) {
      const unavailableTool = listedBody.result.tools.find(
        (tool) => tool.name === toolName
      );
      expect(unavailableTool?._meta).toMatchObject({
        "catapulze/availability": {
          executable: false,
          status: "fixture-stub",
        },
      });
    }

    for (const toolName of ["list_alerts", "list_bronnen", "list_versies"]) {
      const listTool = listedBody.result.tools.find(
        (tool) => tool.name === toolName
      );
      expect(listTool?.outputSchema).toMatchObject({ type: "array" });
      expect(listTool?._meta).toMatchObject({
        "catapulze/effect": { class: "read" },
        "catapulze/outputSchema": { type: "array" },
        "catapulze/outputSchemaPolicy": "standard-json-schema",
      });
    }
  });

  it("uses the official pinned client for search, mark, read, and a direct call", async () => {
    const bundle = createTestSliceARegistry();
    seedAanvraag(bundle);
    await bundle.deps.engine.upsertDocument({
      ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
      beschrijving: "Azure platform engineer",
      bronId: "00000000-0000-4000-8000-000000000001",
      contracttype: "detachering",
      id: aanvraagId,
      laatstGezienOp: new Date("2026-09-04T12:00:00.000Z"),
      locatieLand: "NL",
      status: "active",
      tariefMax: 120,
      tariefMin: 100,
      titel: "Azure engineer",
    });
    const fixture = createMcpProtocolFixture(bundle, "admin");
    const client = new Client(
      { name: "catapulze-protocol-fixture", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL("http://server.test/mcp"),
      {
        fetch: fixture.fetch,
        requestInit: { headers: { Authorization: MCP_TEST_BEARER } },
      }
    );
    await client.connect(transport);
    const discovery = await client.request({
      method: "server/discover",
      params: {},
    });
    expect(discovery.supportedVersions).toContain(MCP_PROTOCOL_VERSION);
    const listedTools = await client.listTools();
    expect(listedTools.tools.length).toBeGreaterThan(0);
    const search = await client.callTool({
      arguments: { query: "Azure" },
      name: "search_aanvragen",
    });
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent).toMatchObject({
      ids: [aanvraagId],
      total: 1,
    });
    const marked = await client.callTool({
      arguments: { aanvraagId, status: "relevant" },
      name: "markeer_aanvraag",
    });
    expect(marked.isError).not.toBe(true);
    const read = await client.callTool({
      arguments: { id: aanvraagId },
      name: "get_aanvraag",
    });
    expect(read.structuredContent).toMatchObject({
      markering: { status: "relevant" },
    });
    const [bronnen, versies, alerts] = await Promise.all([
      client.callTool({ arguments: {}, name: "list_bronnen" }),
      client.callTool({
        arguments: { aanvraagId },
        name: "list_versies",
      }),
      client.callTool({ arguments: {}, name: "list_alerts" }),
    ]);
    expect(Array.isArray(bronnen.structuredContent)).toBe(true);
    expect(versies.structuredContent).toEqual([]);
    expect(alerts.structuredContent).toEqual([]);
    await client.close();

    const direct = await fixture.request(
      "tools/call",
      rpcRequest(
        "tools/call",
        modernParams({ arguments: {}, name: "list_bronnen" })
      ),
      { "Mcp-Name": "list_bronnen" }
    );
    expect(direct.status).toBe(200);
    const directBody = await direct.json();
    expect(directBody).toHaveProperty("result.resultType", "complete");
  });

  it("maps malformed JSON and invalid JSON-RPC shapes to protocol errors", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const malformed = await fixture.request("tools/list", "{");
    expect(malformed.status).toBe(400);
    const malformedError = await readError(malformed);
    expect(malformedError.code).toBe(-32_700);
    const invalid = await fixture.request("tools/list", { jsonrpc: "2.0" });
    expect(invalid.status).toBe(400);
    const invalidError = await readError(invalid);
    expect(invalidError.code).toBe(-32_600);
  });

  it("rejects missing metadata, header mismatches, and unsupported versions", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const missingMeta = await fixture.request(
      "tools/list",
      rpcRequest("tools/list", {})
    );
    expect(missingMeta.status).toBe(400);
    const missingMetaError = await readError(missingMeta);
    expect(missingMetaError.code).toBe(-32_602);

    const mismatch = await fixture.request(
      "tools/list",
      rpcRequest("tools/list"),
      { "Mcp-Method": "tools/call" }
    );
    expect(mismatch.status).toBe(400);
    const mismatchError = await readError(mismatch);
    expect(mismatchError.code).toBe(-32_020);

    const unsupported = await fixture.request(
      "tools/list",
      rpcRequest("tools/list", {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
        },
      }),
      { "MCP-Protocol-Version": "2099-01-01" }
    );
    expect(unsupported.status).toBe(400);
    const unsupportedError = await readError(unsupported);
    expect(unsupportedError.code).toBe(-32_022);
  });

  it("rejects invalid media negotiation, batches, responses, and unknown methods", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const wrongType = await fixture.request(
      "tools/list",
      rpcRequest("tools/list"),
      { "Content-Type": "text/plain" }
    );
    expect(wrongType.status).toBe(415);
    const wrongAccept = await fixture.request(
      "tools/list",
      rpcRequest("tools/list"),
      { Accept: "text/plain" }
    );
    expect(wrongAccept.status).toBe(200);
    const batch = await fixture.request("tools/list", [
      rpcRequest("tools/list"),
    ]);
    expect(batch.status).toBe(400);
    const batchError = await readError(batch);
    expect(batchError.code).toBe(-32_600);
    const responseBody = await fixture.request("tools/list", {
      id: 1,
      jsonrpc: "2.0",
      result: {},
    });
    expect(responseBody.status).toBe(400);
    const responseBodyError = await readError(responseBody);
    expect(responseBodyError.code).toBe(-32_600);
    const unknown = await fixture.request(
      "unknown/method",
      rpcRequest("unknown/method")
    );
    expect(unknown.status).toBe(404);
    const unknownError = await readError(unknown);
    expect(unknownError.code).toBe(-32_601);
  });

  it("rejects malformed and unauthorized tool calls as invalid params", async () => {
    const fixture = createMcpProtocolFixture(createTestSliceARegistry());
    const invalidInput = await fixture.request(
      "tools/call",
      rpcRequest(
        "tools/call",
        modernParams({
          arguments: { query: 42 },
          name: "search_aanvragen",
        })
      ),
      { "Mcp-Name": "search_aanvragen" }
    );
    expect(invalidInput.status).toBe(200);
    const invalidInputError = await readError(invalidInput);
    expect(invalidInputError.code).toBe(-32_602);
    const unavailable = await fixture.request(
      "tools/call",
      rpcRequest(
        "tools/call",
        modernParams({ arguments: {}, name: "start_run" })
      ),
      { "Mcp-Name": "start_run" }
    );
    expect(unavailable.status).toBe(200);
    const unavailableError = await readError(unavailable);
    expect(unavailableError.code).toBe(-32_602);
  });
});
