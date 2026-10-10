import { Schema } from "./schema-helpers";

/**
 * Opaque domain identifiers and bron/voorwaarden status schemas
 * (ADR-0014 Slice 5 / CTP-470).
 *
 * Ids stay plain strings (not UUID-branded) so existing non-UUID fixtures and
 * operator refs keep compiling. Status enums are Effect Schema SoT.
 */

export type AgentContextId = string;
export type AanvraagId = string;
export type AuditEventId = string;
export type BronId = string;
export type DedupGroepId = string;
export type OutboxEventId = string;
export type ApprovalRecordId = string;
export type QuerySnapshotId = string;
export type SavedSearchId = string;
export type ScrapeRunId = string;
export type SourceRecordId = string;

/** Effect Schema SoT for opaque domain id strings. */
export { DomainIdString as DomainIdSchema } from "./schema-helpers";

export const BRON_STATUSES = ["ready", "blocked", "deferred"] as const;

/** Effect Schema SoT for bron operational status. */
export const BronStatusSchema = Schema.Literals(BRON_STATUSES);

export type BronStatus = typeof BronStatusSchema.Type;

export const VOORWAARDEN_STATUSES = [
  "toegestaan",
  "verboden",
  "te_toetsen",
] as const;

/** Effect Schema SoT for voorwaarden status. */
export const VoorwaardenStatusSchema = Schema.Literals(VOORWAARDEN_STATUSES);

export type VoorwaardenStatus = typeof VoorwaardenStatusSchema.Type;
