import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  TEST_DEPLOYMENT_SCOPE_ID,
} from "@ji/application/registry";

import { createMarktvragenTools } from "./tools";

describe("createMarktvragenTools", () => {
  it("exposes every MCP-bound Slice A capability (full operator surface)", () => {
    const { registry } = createTestSliceARegistry(TEST_DEPLOYMENT_SCOPE_ID);
    const tools = createMarktvragenTools(registry, {
      onRevoked: () => {
        /* no-op */
      },
      requestIdPrefix: "test",
      resolvePrincipal: () => Promise.resolve(null),
      signal: new AbortController().signal,
    });

    const mcpOperations = registry.catalog.flatMap((descriptor) =>
      descriptor.bindings
        .filter((binding) => binding.transport === "mcp")
        .map((binding) => binding.operation)
    );

    expect(mcpOperations.length).toBeGreaterThan(4);
    expect(Object.keys(tools).toSorted()).toEqual(mcpOperations.toSorted());
    expect(tools).toHaveProperty("query_marts");
    expect(tools).toHaveProperty("get_operator_context");
    expect(tools).toHaveProperty("search_aanvragen");
  });
});
