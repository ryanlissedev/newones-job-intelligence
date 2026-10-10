import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import { Hono } from "hono";

import type { PrincipalResolver } from "./auth";
import { PRODUCTION_UNAVAILABLE_CAPABILITIES } from "./capability-availability";
import {
  createCapabilityDiscoveryDocument,
  createCapabilityDiscoveryHandler,
} from "./discovery";
import { mcpToolsFromRegistry } from "./rest";

const discoveryPrincipalResolver: PrincipalResolver = (headers) => {
  const role = headers.get("Authorization")?.replace("Bearer ", "");
  if (role !== "admin" && role !== "recruiter") {
    return Promise.resolve({ ok: true, principal: null });
  }
  return Promise.resolve({
    ok: true,
    principal: {
      kind: "user",
      permissions: permissionsForRole(role),
      subjectId: `discovery-${role}`,
    },
  });
};

describe("capability discovery", () => {
  it("derives role-aware status and transport evidence from the real registry", () => {
    const bundle = createTestSliceARegistry();
    const discovery = createCapabilityDiscoveryDocument(
      bundle.registry,
      bundle.entries,
      {
        kind: "user",
        permissions: permissionsForRole("recruiter"),
        subjectId: "discovery-recruiter",
      },
      PRODUCTION_UNAVAILABLE_CAPABILITIES
    );

    expect(discovery.generatedFrom).toBe("slice-a-registry");
    expect(discovery.capabilities).toHaveLength(bundle.registry.catalog.length);
    expect(discovery.statusCounts.planned).toBe(0);
    expect(discovery.statusCounts.executable).toBe(
      discovery.capabilities.filter(
        (capability) => capability.allowed && capability.availability.executable
      ).length
    );
    expect(discovery.statusCounts.denied).toBeGreaterThan(0);

    const search = discovery.capabilities.find(
      (capability) => capability.id === "search_aanvragen"
    );
    expect(search).toMatchObject({
      allowed: true,
      availability: { executable: true, status: "implemented" },
      statusMap: {
        handler: "registered",
        mcpTools: ["search_aanvragen"],
        restOperations: ["POST /v1/aanvragen/search"],
      },
    });
    expect(search?.statusMap.uiActions).toContain("SearchPanel.Submit");
    expect(search?.inputSchema).toEqual(
      bundle.registry.catalog.find(
        (descriptor) => descriptor.id === "search_aanvragen"
      )?.inputJsonSchema
    );

    const operatorOnly = discovery.capabilities.find(
      (capability) => capability.id === "list_alerts"
    );
    expect(operatorOnly).toMatchObject({
      allowed: false,
      availability: {
        executable: false,
        reason: "Niet toegestaan zonder operator.",
        safeNextStep: "Vraag toegang tot operator aan.",
        status: "implemented",
      },
      effect: {
        evidence: "none",
        readback: "not-proven",
      },
    });
  });

  it("never presents fixture or disabled effects as executable evidence", () => {
    const bundle = createTestSliceARegistry();
    const discovery = createCapabilityDiscoveryDocument(
      bundle.registry,
      bundle.entries,
      {
        kind: "agent",
        permissions: permissionsForRole("admin"),
        subjectId: "discovery-admin",
      },
      PRODUCTION_UNAVAILABLE_CAPABILITIES
    );

    for (const capabilityId of [
      "complete_task",
      "start_run",
      "start_test_import",
    ]) {
      const capability = discovery.capabilities.find(
        (candidate) => candidate.id === capabilityId
      );
      expect(capability).toMatchObject({
        availability: { executable: false, status: "fixture-stub" },
        effect: { evidence: "none", readback: "not-proven" },
      });
    }
    expect(
      discovery.capabilities.find(
        (capability) => capability.id === "commit_export"
      )
    ).toMatchObject({
      availability: { executable: false, status: "disabled" },
      effect: { evidence: "none", readback: "not-proven" },
    });
  });

  it("uses the same declared effect class for discovery and MCP", () => {
    const bundle = createTestSliceARegistry();
    const discovery = createCapabilityDiscoveryDocument(
      bundle.registry,
      bundle.entries,
      {
        kind: "agent",
        permissions: permissionsForRole("admin"),
        subjectId: "discovery-admin",
      }
    );
    const mcpTools = mcpToolsFromRegistry(bundle.registry, bundle.entries);

    for (const tool of mcpTools) {
      expect(
        discovery.capabilities.find((capability) => capability.id === tool.name)
          ?.effect.class
      ).toBe(tool.effect);
    }
  });

  it("keeps declared MCP and REST transports equal to registry bindings", () => {
    const bundle = createTestSliceARegistry();

    for (const entry of bundle.entries) {
      const descriptor = bundle.registry.catalog.find(
        (candidate) => candidate.id === entry.capability.id
      );
      if (!descriptor) {
        throw new Error(
          `Missing registry descriptor for ${entry.capability.id}`
        );
      }
      const registryTransports = descriptor.bindings
        .filter((binding) => binding.transport !== "internal")
        .map((binding) => `${binding.transport}:${binding.operation}`)
        .toSorted();
      const declaredTransports = entry.metadata.wiredTransports
        .filter(
          (binding) => binding.startsWith("mcp:") || binding.startsWith("rest:")
        )
        .map(String)
        .toSorted();

      expect(declaredTransports).toEqual(registryTransports);
    }
  });

  it("protects GET /v1/capabilities and returns actor-scoped role counts", async () => {
    const bundle = createTestSliceARegistry();
    const app = new Hono();
    app.get(
      "/v1/capabilities",
      createCapabilityDiscoveryHandler(
        bundle.registry,
        bundle.entries,
        discoveryPrincipalResolver,
        PRODUCTION_UNAVAILABLE_CAPABILITIES
      )
    );

    const anonymousResponse = await app.request("/v1/capabilities");
    expect(anonymousResponse.status).toBe(401);

    const recruiterResponse = await app.request("/v1/capabilities", {
      headers: { Authorization: "Bearer recruiter" },
    });
    expect(recruiterResponse.status).toBe(200);
    expect(await recruiterResponse.json()).toEqual(
      createCapabilityDiscoveryDocument(
        bundle.registry,
        bundle.entries,
        {
          kind: "user",
          permissions: permissionsForRole("recruiter"),
          subjectId: "discovery-recruiter",
        },
        PRODUCTION_UNAVAILABLE_CAPABILITIES
      )
    );

    const adminResponse = await app.request("/v1/capabilities", {
      headers: { Authorization: "Bearer admin" },
    });
    expect(adminResponse.status).toBe(200);
    const adminDocument = createCapabilityDiscoveryDocument(
      bundle.registry,
      bundle.entries,
      {
        kind: "user",
        permissions: permissionsForRole("admin"),
        subjectId: "discovery-admin",
      },
      PRODUCTION_UNAVAILABLE_CAPABILITIES
    );
    expect(adminDocument.statusCounts.denied).toBe(0);
    expect(await adminResponse.json()).toEqual(adminDocument);
  });
});
