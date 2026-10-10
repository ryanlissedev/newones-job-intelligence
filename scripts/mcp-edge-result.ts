import { z } from "zod";

import type {
  CallToolResult,
  JSONValue,
} from "../apps/server/node_modules/@modelcontextprotocol/client";

const textBlockSchema = z.object({
  text: z.string(),
  type: z.literal("text"),
});

const toolResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});

export const readMcpToolPayload = (rawResult: CallToolResult): JSONValue => {
  const result = toolResultSchema.parse(rawResult);
  if (result.isError === true) {
    throw new TypeError("MCP tool returned an in-band error");
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (result.content?.length !== 1) {
    throw new Error("MCP text fallback requires exactly one content block");
  }
  const block = textBlockSchema.parse(result.content[0]);
  try {
    // SAFETY: JSON.parse returns only values in the JSONValue domain.
    return JSON.parse(block.text) as JSONValue;
  } catch (error) {
    throw new Error("MCP text fallback did not contain valid JSON", {
      cause: error,
    });
  }
};
