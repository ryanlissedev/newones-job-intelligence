import type {
  CapabilityRegistry,
  InvocationPrincipal,
  SliceACapabilityCatalog,
} from "@ji/application/registry";
import { jsonSchema, tool } from "ai";
import type { Tool, ToolSet } from "ai";

/**
 * AI SDK toolset over the Slice A capability registry. Every MCP-bound
 * capability is exposed so the chat agent has the same operator surface as
 * REST/MCP — schema validation and per-call authorization stay identical.
 *
 * A capability failure is returned as structured output, not thrown, so the
 * model can recover (rewrite input, pick another tool, or explain the deny).
 *
 * CTP-628: the principal is re-resolved on every tool call, never cached for
 * the turn. A session revoked mid-turn makes the next tool call fail closed
 * with UNAUTHENTICATED and ends the turn through `onRevoked`.
 */

interface ToolError {
  readonly error: { readonly code: string; readonly message: string };
}

const toToolOutput = <T>(result: {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly message: string };
}): T | ToolError =>
  result.ok && result.value !== undefined
    ? result.value
    : {
        error: result.error ?? {
          code: "INTERNAL_ERROR",
          message: "De capability kon niet worden uitgevoerd",
        },
      };

const UNAUTHENTICATED: ToolError = {
  error: {
    code: "UNAUTHENTICATED",
    message: "De sessie is niet meer geldig; de actie is niet uitgevoerd",
  },
};

const TURN_ENDED: ToolError = {
  error: {
    code: "TURN_ENDED",
    message: "De chatbeurt is beëindigd voordat deze actie kon starten",
  },
};

export type MarktvragenRegistry = CapabilityRegistry<
  SliceACapabilityCatalog[number]["capability"][]
>;

export interface MarktvragenToolContext {
  readonly requestIdPrefix: string;
  /** Re-resolves the caller for this one tool call; null when revoked or anonymous. */
  readonly resolvePrincipal: () => Promise<InvocationPrincipal | null>;
  /** Scope-owned turn signal; an aborted signal refuses new tool actions. */
  readonly signal: AbortSignal;
  /** Called once a tool call finds the session gone, so the turn can end. */
  readonly onRevoked: () => void;
}

type JsonSchemaInput = Parameters<typeof jsonSchema>[0];

/** Narrow registry JSON Schema to the object-root shape AI SDK tools expect. */
const asObjectSchema = (schema: JsonSchemaInput): JsonSchemaInput => {
  const type =
    typeof schema === "object" && schema !== null && "type" in schema
      ? schema.type
      : undefined;
  if (type === "object" || (Array.isArray(type) && type.includes("object"))) {
    return schema;
  }
  // AI SDK tools require an object root; wrap non-object schemas.
  // SAFETY: wrapper is a plain JSON Schema object document.
  return {
    additionalProperties: false,
    properties: { value: schema },
    required: ["value"],
    type: "object",
  } as JsonSchemaInput;
};

export const createMarktvragenTools = (
  registry: MarktvragenRegistry,
  context: MarktvragenToolContext
): ToolSet => {
  const guarded =
    <Input>(
      invoke: (
        input: Input,
        trusted: {
          readonly principal: InvocationPrincipal;
          readonly requestId: string;
        }
      ) => Promise<{
        readonly ok: boolean;
        readonly value?: unknown;
        readonly error?: { readonly code: string; readonly message: string };
      }>
    ) =>
    async (input: Input, { toolCallId }: { toolCallId: string }) => {
      if (context.signal.aborted) {
        return TURN_ENDED;
      }
      const principal = await context.resolvePrincipal();
      if (!principal) {
        context.onRevoked();
        return UNAUTHENTICATED;
      }
      return toToolOutput(
        await invoke(input, {
          principal,
          requestId: `${context.requestIdPrefix}:${toolCallId}`,
        })
      );
    };

  const tools: Record<string, Tool> = {};

  for (const descriptor of registry.catalog) {
    const mcpBinding = descriptor.bindings.find(
      (binding) => binding.transport === "mcp"
    );
    if (!mcpBinding) {
      continue;
    }

    const invoke = registry.createInvoker({
      capabilityId: descriptor.id,
      operation: mcpBinding.operation,
      transport: "mcp",
    });

    tools[mcpBinding.operation] = tool({
      description: descriptor.outcome,
      execute: guarded(invoke),
      inputSchema: jsonSchema(
        asObjectSchema(
          // SAFETY: registry descriptors expose JSON Schema object documents
          // validated at catalog construction for MCP bindings.
          descriptor.inputJsonSchema as JsonSchemaInput
        )
      ),
    });
  }

  return tools;
};

export type MarktvragenTools = ToolSet;
