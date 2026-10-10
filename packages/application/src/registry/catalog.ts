import type { SliceACapabilityCatalog } from "./capabilities";
import { createSliceACapabilityCatalog } from "./capabilities";
import type { SliceAHandlerDeps } from "./handlers/deps";
import type { SliceACapabilityEntry } from "./metadata";
import type { CapabilityRegistry } from "./registry";
import { createCapabilityRegistry } from "./registry";

const noOpReporter = (): void => undefined;

export interface SliceARegistryBundle {
  readonly entries: SliceACapabilityCatalog;
  readonly registry: CapabilityRegistry<
    SliceACapabilityCatalog[number]["capability"][]
  >;
}

export const createSliceARegistry = (
  deps: SliceAHandlerDeps
): SliceARegistryBundle => {
  const entries = createSliceACapabilityCatalog(deps);
  const catalog = entries.map((entry) => entry.capability);
  const result = createCapabilityRegistry(catalog, {
    reportInternalError: noOpReporter,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return { entries, registry: result.registry };
};

export const getCapabilityEntries = (
  entries: SliceACapabilityCatalog
): readonly SliceACapabilityEntry<{ readonly id: string }>[] => entries;

export const productionCapabilityCatalog = [] as const;

export const productionCapabilityRegistry = createCapabilityRegistry(
  productionCapabilityCatalog
);
