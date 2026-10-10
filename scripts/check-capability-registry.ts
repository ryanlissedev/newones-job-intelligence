#!/usr/bin/env bun

import {
  createSliceACapabilityCatalog,
  sliceACapabilityIds,
} from "../packages/application/src/registry/capabilities.ts";
import { createTestSliceADeps } from "../packages/application/src/registry/test-fixtures.ts";

const entries = createSliceACapabilityCatalog(createTestSliceADeps());
const failures: string[] = [];

for (const expectedId of sliceACapabilityIds) {
  const entry = entries.find((item) => item.capability.id === expectedId);
  if (!entry) {
    failures.push(`Missing capability ${expectedId}`);
    continue;
  }
  const restBindings = entry.capability.bindings.filter(
    (binding) => binding.transport === "rest"
  );
  const mcpBindings = entry.capability.bindings.filter(
    (binding) => binding.transport === "mcp"
  );
  if (restBindings.length !== 1 || mcpBindings.length !== 1) {
    failures.push(
      `${expectedId} must expose exactly one REST and one MCP binding (rest=${restBindings.length}, mcp=${mcpBindings.length})`
    );
  }
  for (const wired of entry.metadata.wiredTransports) {
    const [kind, target] = wired.split(":", 2);
    if (kind === "rest") {
      const exists = restBindings.some(
        (binding) => binding.operation === target
      );
      if (!exists) {
        failures.push(`${expectedId} declares missing REST transport ${wired}`);
      }
    }
    if (kind === "mcp") {
      const exists = mcpBindings.some(
        (binding) => binding.operation === target
      );
      if (!exists) {
        failures.push(`${expectedId} declares missing MCP transport ${wired}`);
      }
    }
  }
  for (const binding of [...restBindings, ...mcpBindings]) {
    const expected = `${binding.transport}:${binding.operation}`;
    if (!entry.metadata.wiredTransports.includes(expected)) {
      failures.push(
        `${expectedId} registry binding is missing from wiredTransports: ${expected}`
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("check-capability-registry: ok\n");
