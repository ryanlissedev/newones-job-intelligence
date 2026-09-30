import { describe, expect, it } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  capabilityDisplayStatus,
  CapabilityMetadata,
  CapabilityDiscovery,
} from "./capability-discovery";
import { loadFixtureCapabilityDiscovery } from "./capability-discovery-fixture";

describe("capability discovery entry point", () => {
  it("renders a protocol-free Dutch entry point from the jobs UI", () => {
    const markup = renderToStaticMarkup(
      createElement(CapabilityDiscovery, {
        load: () =>
          Promise.resolve({
            capabilities: [],
            generatedFrom: "slice-a-registry",
            statusCounts: {
              denied: 0,
              disabled: 0,
              executable: 0,
              fixtureStub: 0,
              planned: 0,
            },
          }),
      })
    );

    expect(markup).toContain("Wat kan de assistent?");
    expect(markup).toContain("Mogelijkheden sluiten");
    expect(markup).toContain("dezelfde catalogus als REST en MCP");
  });

  it("shows a permission-denied capability distinctly from availability", () => {
    const capability = {
      allowed: false,
      availability: {
        executable: false,
        reason: "Niet toegestaan",
        safeNextStep: "Vraag toegang aan",
        status: "implemented" as const,
      },
      effect: {
        auditClass: "access" as const,
        class: "read" as const,
        evidence: "grounded-handler-output" as const,
        readback: "capability-output" as const,
        reversible: true,
        target: "internal" as const,
      },
      id: "list_alerts",
      inputSchema: { type: "object" },
      outcome: "Lijst alerts",
      outputSchema: { type: "array" },
      requiredPermission: "operator",
      statusMap: {
        handler: "registered" as const,
        mcpTools: ["list_alerts"],
        restOperations: ["GET /v1/alerts"],
        uiActions: ["AlertsPanel.List"],
      },
    };
    expect(capabilityDisplayStatus(capability)).toBe("denied");

    const metadata = renderToStaticMarkup(
      createElement(CapabilityMetadata, { capability })
    );
    expect(metadata).toContain("Effect en bewijs");
    expect(metadata).toContain("Lezen · internal · omkeerbaar");
    expect(metadata).toContain("Invoer: object · uitvoer: array");
    expect(metadata).toContain("Handler geregistreerd");
    expect(metadata).toContain("MCP (list_alerts)");
  });

  it("provides a synthetic discovery document for fixture mode", async () => {
    const document = await loadFixtureCapabilityDiscovery();
    const startRun = document.capabilities.find(
      (capability) => capability.id === "start_run"
    );
    const commitExport = document.capabilities.find(
      (capability) => capability.id === "commit_export"
    );

    expect(document.capabilities).toHaveLength(21);
    expect(document.statusCounts).toEqual({
      denied: 0,
      disabled: 1,
      executable: 17,
      fixtureStub: 3,
      planned: 0,
    });
    expect(startRun).toMatchObject({
      allowed: true,
      availability: { executable: false, status: "fixture-stub" },
    });
    expect(commitExport).toMatchObject({
      availability: { executable: false, status: "disabled" },
      effect: { target: "external" },
    });
  });
});
