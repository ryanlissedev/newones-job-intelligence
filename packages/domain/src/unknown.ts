import { Schema } from "./schema-helpers";

export const UNKNOWN = "unknown" as const;

/** Explicit clear tombstone: overwrite last-known curated value with null. */
export const CLEARED = "cleared" as const;

/**
 * Reserved bron_specifiek key for durable CLEARED markers after #213 strip.
 * Value shape: Record<commercialKey, true>. Never stores the CLEARED string
 * itself — only which commercial keys were intentionally cleared.
 */
export const CLEARED_BRON_MARKER_KEY = "_cleared" as const;

/** Effect Schema SoT for the sentinel unknown value (ADR-0014 / CTP-470). */
export const UnknownValueSchema = Schema.Literal(UNKNOWN);

/** Effect Schema SoT for the clear tombstone (sparse coalesce companion). */
export const ClearedValueSchema = Schema.Literal(CLEARED);

export type UnknownValue = typeof UnknownValueSchema.Type;
export type ClearedValue = typeof ClearedValueSchema.Type;

export const isUnknown = (value: string): value is UnknownValue =>
  value === UNKNOWN;

export const isCleared = (value: string): value is ClearedValue =>
  value === CLEARED;
