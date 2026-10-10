import type { ObjectStore } from "@ji/connectors";
import { z } from "zod";

import type { CurateStore } from "../identity/curate";
import type { JsonValue } from "../normalise";
import type { StarappleLiveIndex } from "./motian-bron-url";

export const NEON_V1_BACKFILL_CONTRACT_VERSION = "neon-v1-backfill/v1" as const;

export const NEON_V1_PARSER_VERSION = "neon-v1/2026-09-20-starapple-live-index";

export const NEON_V1_DEFAULT_CONCURRENCY = 16;

export const NEON_V1_MAX_CONCURRENCY = 64;

export const BACKFILL_SCOPE_MANIFEST_VERSION =
  "motian-v1-scope-manifest/v1" as const;

export const BACKFILL_TARGET_RECONCILIATION_VERSION =
  "motian-v1-target-reconciliation/v1" as const;

export const NEON_V1_FORBIDDEN_TABLES = [
  "applications",
  "candidates",
  "chat_conversations",
  "chat_messages",
  "interviews",
  "job_matches",
  "messages",
  "screening_calls",
] as const;

export type NeonV1ForbiddenTable = (typeof NEON_V1_FORBIDDEN_TABLES)[number];

/** Typed Motian `jobs` projection. Its timestamp field names match the live
 * column readback from 2026-09-03; that table has no creation/update columns. */
export interface NeonV1JobRow {
  readonly application_deadline?: string | null;
  readonly archived_at?: string | null;
  /** Exact source field names are retained for the parity/detail projection. */
  readonly allows_subcontracting?: boolean | null;
  readonly company?: string | null;
  readonly competences?: JsonValue | null;
  readonly contract_type?: string | null;
  readonly deleted_at?: string | null;
  readonly description?: string | null;
  readonly education_level?: string | null;
  readonly end_client?: string | null;
  readonly end_date?: string | null;
  readonly external_id: string;
  readonly external_url?: string | null;
  readonly extension_possible?: boolean | null;
  readonly hours_per_week?: number | null;
  readonly id: string;
  readonly location?: string | null;
  readonly min_hours_per_week?: number | null;
  readonly platform: string;
  readonly positions_available?: number | null;
  readonly province?: string | null;
  readonly rate_max?: number | null;
  readonly rate_min?: number | null;
  readonly posted_at?: string | null;
  readonly requirements?: JsonValue | null;
  readonly scraped_at?: string | null;
  readonly start_date?: string | null;
  /** Complete `jobs` row as returned by Motian-Neon, including `raw_payload`.
   * It is written unchanged in shape to object storage; the typed fields above
   * are only the curated mapping surface. */
  readonly sourceRow?: Readonly<Record<string, JsonValue>>;
  readonly status?: string | null;
  readonly title: string;
  readonly work_arrangement?: string | null;
  readonly wishes?: JsonValue | null;
  readonly work_experience_years?: number | null;
}

/**
 * Source facts copied into bronSpecifiek with the original Motian/UI field
 * names. Every member is optional so a missing source column remains missing;
 * an explicit null, false, zero, or array remains distinguishable.
 */
export interface NeonV1SourceFacts {
  readonly allows_subcontracting?: boolean | null;
  readonly application_deadline?: string | null;
  readonly company?: string | null;
  readonly competences?: JsonValue | null;
  readonly end_client?: string | null;
  readonly end_date?: string | null;
  readonly external_url?: string | null;
  readonly extension_possible?: boolean | null;
  readonly hours_per_week?: number | null;
  readonly min_hours_per_week?: number | null;
  readonly positions_available?: number | null;
  readonly posted_at?: string | null;
  readonly province?: string | null;
  readonly requirements?: JsonValue | null;
  readonly start_date?: string | null;
  readonly wishes?: JsonValue | null;
  readonly work_arrangement?: string | null;
  readonly work_experience_years?: number | null;
}

export interface NeonV1Fixture {
  readonly capturedAt: string;
  readonly contractVersion: typeof NEON_V1_BACKFILL_CONTRACT_VERSION;
  readonly jobs: readonly NeonV1JobRow[];
}

export type BackfillExecutionMode = "fixture" | "production";

/** `active` retains the historical fixture/dev query behaviour; `full` is the
 * production migration contract and includes closed, deleted and archived rows. */
export type BackfillScope = "active" | "full";

export interface BackfillExecution {
  readonly mode: BackfillExecutionMode;
  readonly scope: BackfillScope;
}

export interface BackfillPlatformMetrics {
  readonly duplicates: number;
  readonly errors: number;
  readonly extra: number;
  readonly found: number;
  readonly imported: number;
  readonly matched: number;
  readonly missing: number;
  readonly rejected: number;
  readonly selected: number;
  readonly skipped: number;
}

export interface BackfillRunMetrics extends BackfillPlatformMetrics {
  /** Canonical Motian platform slug to its complete outcome counters.
   * `__source__` is reserved for failures that happen before a row can be
   * attributed to a platform (for example, a source connection failure). */
  readonly platforms: Readonly<Record<string, BackfillPlatformMetrics>>;
}

export interface BackfillSnapshotWindow {
  readonly completedAt: string;
  readonly startedAt: string;
}

export interface BackfillScopeManifest {
  readonly contractVersion: typeof BACKFILL_SCOPE_MANIFEST_VERSION;
  readonly digestAlgorithm: "sha256";
  readonly itemEncoding: "json-array-line/v1";
  readonly order: "source-id-ascending";
  readonly orderedDigest: string;
  readonly platformCounts: Readonly<Record<string, number>>;
  readonly selected: number;
  readonly snapshot: BackfillSnapshotWindow;
}

export interface BackfillTargetReconciliation {
  readonly contractVersion: typeof BACKFILL_TARGET_RECONCILIATION_VERSION;
  readonly digestAlgorithm: "sha256";
  readonly distinctV1Ids: number;
  readonly itemEncoding: "json-array-line/v1";
  readonly matchesScope: boolean;
  readonly order: "source-id-ascending";
  readonly orderedDigest: string;
  readonly platformCounts: Readonly<Record<string, number>>;
  readonly records: number;
  readonly snapshot: BackfillSnapshotWindow;
}

export const BACKFILL_FAILURE_PHASES = [
  "source-read",
  "raw-write",
  "curate",
  "provenance",
  "reconcile",
] as const;

export const BACKFILL_FAILURE_CODES = [
  "SOURCE_READ_FAILED",
  "RAW_WRITE_FAILED",
  "RAW_READBACK_FAILED",
  "CURATE_FAILED",
  "CURATE_REJECTED",
  "PROVENANCE_READ_FAILED",
  "PROVENANCE_WRITE_FAILED",
  "PROVENANCE_MISMATCH",
  "RECONCILIATION_READ_FAILED",
  "RECONCILIATION_DRIFT",
] as const;

export const backfillFailureEvidenceSchema = z.discriminatedUnion("phase", [
  z.object({
    code: z.literal("SOURCE_READ_FAILED"),
    phase: z.literal("source-read"),
  }),
  z.object({
    code: z.enum(["RAW_WRITE_FAILED", "RAW_READBACK_FAILED"]),
    phase: z.literal("raw-write"),
  }),
  z.object({
    code: z.enum(["CURATE_FAILED", "CURATE_REJECTED"]),
    phase: z.literal("curate"),
  }),
  z.object({
    code: z.enum([
      "PROVENANCE_READ_FAILED",
      "PROVENANCE_WRITE_FAILED",
      "PROVENANCE_MISMATCH",
    ]),
    phase: z.literal("provenance"),
  }),
  z.object({
    code: z.enum(["RECONCILIATION_READ_FAILED", "RECONCILIATION_DRIFT"]),
    phase: z.literal("reconcile"),
  }),
]);

export type BackfillFailureEvidence = z.infer<
  typeof backfillFailureEvidenceSchema
>;

export interface BackfillRunEvidence {
  readonly execution: BackfillExecution;
  /** Safe, schema-validated terminal failure. It never contains a source URL,
   * raw payload, or exception text. */
  readonly failure?: BackfillFailureEvidence;
  readonly metrics: BackfillRunMetrics;
  /** Complete source scope selected inside one snapshot. The rolling digest is
   * computed over ordered canonical
   * `[v1Id, bronId, bronReferentie, contentHash, rawPayloadRef]` JSONL mappings
   * and therefore does not retain the source mapping set in memory. */
  readonly scopeManifest?: BackfillScopeManifest;
  /** Target inventory read from one repeatable-read snapshot after import.
   * Equality with `scopeManifest.orderedDigest` proves exact provenance
   * mappings, not merely equal IDs or row counts. */
  readonly targetReconciliation?: BackfillTargetReconciliation;
}

export interface BackfillRunResult {
  readonly evidence: BackfillRunEvidence;
  readonly metrics: BackfillRunMetrics;
  readonly status: "failed" | "succeeded";
}

export interface NeonV1Source {
  readonly label: string;
  /** Consume every selected source row from one consistent snapshot. Live
   * adapters use a single REPEATABLE READ, READ ONLY transaction and invoke
   * the consumer one bounded batch at a time. */
  consumeSnapshot?: (
    batchSize: number,
    consume: (batch: readonly NeonV1JobRow[]) => Promise<void>
  ) => Promise<BackfillSnapshotWindow>;
  loadJobs: () => Promise<readonly NeonV1JobRow[]>;
  streamBatches?: (
    batchSize: number
  ) => AsyncGenerator<readonly NeonV1JobRow[], void>;
}

export interface BackfillBronBinding {
  readonly bronId: string;
  readonly platform: string;
}

export interface BackfillRunStore {
  completeRun: (
    scrapeRunId: string,
    evidence: BackfillRunEvidence
  ) => Promise<void>;
  failRun: (
    scrapeRunId: string,
    failure: BackfillFailureEvidence,
    evidence: BackfillRunEvidence
  ) => Promise<void>;
  startRun: (bronId: string) => Promise<{ scrapeRunId: string }>;
}

export interface BackfillProvenanceRecord {
  readonly aanvraagId: string;
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly contentHash: string;
  readonly rawPayloadRef: string;
  readonly v1Id: string;
}

export interface BackfillTargetProvenanceRecord {
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly contentHash: string;
  readonly rawPayloadRef: string;
  readonly v1Id: string;
}

export interface BackfillProvenanceStore {
  /** Consume target provenance in `(v1_id, aanvraag_id)` keyset order from one
   * consistent snapshot. Implementations must reject if that snapshot or its
   * final heartbeat/commit is lost. */
  consumeReconciliationSnapshot: (
    bronIds: readonly string[],
    batchSize: number,
    consume: (batch: readonly BackfillTargetProvenanceRecord[]) => Promise<void>
  ) => Promise<BackfillSnapshotWindow>;
  /** The v1 binding an aanvraag already carries, or null when unbound. Read
   * before curation so a second v1 row that resolves to the same aanvraag is
   * refused before any curated write, version, or outbox event lands. */
  findByAanvraagId: (
    aanvraagId: string
  ) => Promise<BackfillProvenanceRecord | null>;
  findByV1Id: (v1Id: string) => Promise<BackfillProvenanceRecord | null>;
  /** Binds one v1 id to one aanvraag. Implementations must reject when the
   * aanvraag is already bound to a different v1 id. */
  registerV1Id: (
    record: BackfillProvenanceRecord
  ) => Promise<BackfillProvenanceRecord>;
}

export interface RunNeonV1BackfillInput {
  readonly batchSize?: number;
  readonly bindings: readonly BackfillBronBinding[];
  readonly concurrency?: number;
  readonly curateStore: CurateStore;
  /** The execution intent is persisted as durable run evidence. Production
   * callers must provide `scope: "full"`; runner adapters enforce storage. */
  readonly execution?: BackfillExecution;
  readonly objectStore: ObjectStore;
  readonly provenanceStore: BackfillProvenanceStore;
  readonly runStore: BackfillRunStore;
  readonly source: NeonV1Source;
  /** Optional live-sitemap index for Starapple bron-URL verification
   * (CTP-527). Supplying one lets open Starapple rows keep only slugs the
   * live site still advertises — an unambiguous rematch is followed, anything
   * else falls back to the Wayback archive redirect. Fetching the sitemap is
   * the caller's choice; absent, resolution keeps its historical shape. */
  readonly starappleLiveIndex?: StarappleLiveIndex;
  readonly startedAt?: Date;
}
