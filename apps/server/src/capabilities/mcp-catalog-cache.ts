import type { ServerOptions } from "@modelcontextprotocol/server";

/**
 * Capability changes (role loss, token replacement, or registry configuration)
 * become visible on the next catalog fetch, at most thirty seconds later.
 * Tool calls still authenticate and authorize independently on every request.
 */
export const MCP_CATALOG_CACHE_TTL_MS = 30_000;

export const MCP_CATALOG_CACHE_HINTS = {
  "server/discover": {
    cacheScope: "private",
    ttlMs: MCP_CATALOG_CACHE_TTL_MS,
  },
  "tools/list": {
    cacheScope: "private",
    ttlMs: MCP_CATALOG_CACHE_TTL_MS,
  },
} satisfies NonNullable<ServerOptions["cacheHints"]>;

interface NamedMcpTool {
  readonly name: string;
}

const compareToolNames = (left: NamedMcpTool, right: NamedMcpTool): number => {
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return 0;
};

/** Sort before pagination so every page has a stable catalog order. */
export const sortMcpCatalogTools = <Tool extends NamedMcpTool>(
  tools: readonly Tool[]
): Tool[] => tools.toSorted(compareToolNames);
