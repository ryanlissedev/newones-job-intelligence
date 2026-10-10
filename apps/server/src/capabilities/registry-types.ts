import type {
  CapabilityError,
  InvocationResult,
  SliceARegistryBundle,
} from "@ji/application/registry";

export type SliceARegistry = SliceARegistryBundle["registry"];

export type RegistryInvocationResult = InvocationResult<
  unknown,
  CapabilityError
>;
