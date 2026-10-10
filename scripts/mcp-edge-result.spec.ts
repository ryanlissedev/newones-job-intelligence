import { describe, expect, it } from "bun:test";

import { readMcpToolPayload } from "./mcp-edge-result";

describe("MCP edge result decoding", () => {
  it("prefers structured content", () => {
    expect(
      readMcpToolPayload({
        content: [{ text: "not-json", type: "text" }],
        structuredContent: { ids: ["fixture"] },
      })
    ).toEqual({ ids: ["fixture"] });
  });

  it("decodes one JSON text block when structured content is absent", () => {
    expect(
      readMcpToolPayload({
        content: [{ text: '{"ids":["fixture"]}', type: "text" }],
      })
    ).toEqual({ ids: ["fixture"] });
  });

  it("rejects in-band tool errors", () => {
    expect(() =>
      readMcpToolPayload({
        content: [{ text: "{}", type: "text" }],
        isError: true,
      })
    ).toThrow("MCP tool returned an in-band error");
  });

  it("rejects invalid JSON text", () => {
    expect(() =>
      readMcpToolPayload({ content: [{ text: "not-json", type: "text" }] })
    ).toThrow("MCP text fallback did not contain valid JSON");
  });

  it("rejects ambiguous fallback content", () => {
    expect(() =>
      readMcpToolPayload({
        content: [
          { text: "{}", type: "text" },
          { text: "{}", type: "text" },
        ],
      })
    ).toThrow("MCP text fallback requires exactly one content block");
  });
});
