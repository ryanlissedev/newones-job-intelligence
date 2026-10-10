#!/usr/bin/env bun

import { createSliceACapabilityCatalog } from "../packages/application/src/registry/capabilities.ts";
import { sliceAUiActions } from "../packages/application/src/registry/slice-a-ui-actions.ts";
import { createTestSliceADeps } from "../packages/application/src/registry/test-fixtures.ts";

const entries = createSliceACapabilityCatalog(createTestSliceADeps());
const byId = new Map(entries.map((entry) => [entry.capability.id, entry]));

const failures: string[] = [];

for (const uiAction of sliceAUiActions) {
  const entry = byId.get(uiAction.capabilityId);
  if (!entry) {
    failures.push(
      `UI action ${uiAction.action} references missing capability ${uiAction.capabilityId}`
    );
    continue;
  }
  const wired = entry.metadata.wiredTransports;
  const hasMcp = wired.some((transport) =>
    transport.startsWith(`mcp:${uiAction.capabilityId}`)
  );
  const hasRest = wired.some((transport) => transport.startsWith("rest:"));
  const hasUi = wired.some(
    (transport) => transport === `ui:${uiAction.action}`
  );
  if (!hasMcp || !hasRest || !hasUi) {
    failures.push(
      `${uiAction.action} -> ${uiAction.capabilityId} missing transports (mcp=${hasMcp}, rest=${hasRest}, ui=${hasUi})`
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("check-capability-coverage: ok\n");
