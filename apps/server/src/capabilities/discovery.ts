import type {
  InvocationPrincipal,
  SliceACapabilityCatalog,
} from "@ji/application/registry";
import type { Context } from "hono";

import { createRequestId } from "./auth";
import type { PrincipalResolver } from "./auth";
import {
  capabilityAvailability,
  isCapabilityExecutable,
} from "./capability-availability";
import type { CapabilityAvailabilityPolicy } from "./capability-availability";
import type { SliceARegistry } from "./registry-types";

const bindingOperations = (
  wiredTransports: readonly string[],
  prefix: "mcp:" | "rest:" | "ui:"
): readonly string[] =>
  wiredTransports
    .filter((binding) => binding.startsWith(prefix))
    .map((binding) => binding.slice(prefix.length));

const effectEvidence = (
  implemented: boolean,
  grounded: boolean
): "grounded-handler-output" | "none" | "validated-handler-output" => {
  if (!implemented) {
    return "none";
  }
  return grounded ? "grounded-handler-output" : "validated-handler-output";
};

export const createCapabilityDiscoveryDocument = (
  registry: SliceARegistry,
  entries: SliceACapabilityCatalog,
  principal: InvocationPrincipal,
  unavailableCapabilities?: CapabilityAvailabilityPolicy
) => {
  const metadataById = new Map<
    string,
    SliceACapabilityCatalog[number]["metadata"]
  >(entries.map((entry) => [entry.capability.id, entry.metadata]));
  const capabilities = registry.catalog.map((descriptor) => {
    const metadata = metadataById.get(descriptor.id);
    if (!metadata) {
      throw new Error(`Missing discovery metadata for ${descriptor.id}`);
    }
    const availability = capabilityAvailability(
      unavailableCapabilities,
      descriptor.id
    );
    const allowed = principal.permissions.has(
      descriptor.authorization.permission
    );
    const executable = allowed && isCapabilityExecutable(availability);
    const actorAvailability = allowed
      ? availability
      : {
          ...availability,
          reason: `Niet toegestaan zonder ${descriptor.authorization.permission}.`,
          safeNextStep: `Vraag toegang tot ${descriptor.authorization.permission} aan.`,
        };
    return {
      allowed,
      availability: {
        ...actorAvailability,
        executable,
      },
      effect: {
        auditClass: metadata.auditClass,
        class: metadata.sideEffectClass,
        evidence: effectEvidence(executable, descriptor.grounding),
        readback:
          executable && descriptor.effect === "read"
            ? "capability-output"
            : "not-proven",
        reversible: metadata.reversible,
        target: metadata.target,
      },
      id: descriptor.id,
      inputSchema: descriptor.inputJsonSchema,
      outcome: descriptor.outcome,
      outputSchema: descriptor.outputJsonSchema,
      requiredPermission: descriptor.authorization.permission,
      statusMap: {
        handler: "registered",
        mcpTools: bindingOperations(metadata.wiredTransports, "mcp:"),
        restOperations: bindingOperations(metadata.wiredTransports, "rest:"),
        uiActions: bindingOperations(metadata.wiredTransports, "ui:"),
      },
    };
  });

  return {
    capabilities,
    generatedFrom: "slice-a-registry",
    statusCounts: {
      denied: capabilities.filter((item) => !item.allowed).length,
      disabled: capabilities.filter(
        (item) => item.allowed && item.availability.status === "disabled"
      ).length,
      executable: capabilities.filter((item) => item.availability.executable)
        .length,
      fixtureStub: capabilities.filter(
        (item) => item.allowed && item.availability.status === "fixture-stub"
      ).length,
      planned: capabilities.filter(
        (item) => item.allowed && item.availability.status === "planned"
      ).length,
    },
  } as const;
};

export const createCapabilityDiscoveryHandler =
  (
    registry: SliceARegistry,
    entries: SliceACapabilityCatalog,
    resolvePrincipal: PrincipalResolver,
    unavailableCapabilities?: CapabilityAvailabilityPolicy
  ) =>
  async (context: Context): Promise<Response> => {
    const requestId = createRequestId();
    const resolution = await resolvePrincipal(
      context.req.raw.headers,
      requestId
    );
    if (!resolution.ok) {
      return Response.json({ error: resolution.error }, { status: 503 });
    }
    if (!resolution.principal) {
      return Response.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
            requestId,
          },
          ok: false,
        },
        { status: 401 }
      );
    }
    return Response.json(
      createCapabilityDiscoveryDocument(
        registry,
        entries,
        resolution.principal,
        unavailableCapabilities
      )
    );
  };
