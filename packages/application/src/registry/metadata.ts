export const sideEffectClasses = ["read", "proposal", "commit"] as const;

export type SideEffectClass = (typeof sideEffectClasses)[number];

export const auditClasses = ["access", "effect", "none"] as const;

export type AuditClass = (typeof auditClasses)[number];

export type WiredTransport =
  | `mcp:${string}`
  | `rest:${string}`
  | `ui:${string}`;

export interface CapabilityMetadata {
  readonly auditClass: AuditClass;
  readonly idempotency?: readonly string[];
  readonly reversible: boolean;
  readonly sideEffectClass: SideEffectClass;
  readonly target: "external" | "internal";
  readonly wiredTransports: readonly WiredTransport[];
}

export interface SliceACapabilityEntry<
  Capability extends { readonly id: string },
> {
  readonly capability: Capability;
  readonly metadata: CapabilityMetadata;
}

export const defineSliceACapabilityEntry = <
  Capability extends { readonly id: string },
>(
  capability: Capability,
  metadata: CapabilityMetadata
): SliceACapabilityEntry<Capability> => ({
  capability,
  metadata,
});
