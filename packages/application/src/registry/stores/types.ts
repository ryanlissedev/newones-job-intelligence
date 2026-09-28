import type { Contactpersoon } from "@ji/domain";
import type { SearchFilters, SearchScope, SearchVersion } from "@ji/search";

import type { JsonValue } from "../../normalise/types";
import type { TitleFallbackDescriptionParts } from "../../title-fallback-description";
import type {
  BronRunKindFilter,
  BronRunStatsWindow,
  BronRunTimeseriesBucket,
} from "../bron-run-stats";
import type { AuditClass } from "../metadata";

export type AuditActorType = "agent" | "service" | "system" | "user";

export interface SavedSearchRecord {
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  readonly filters: SearchFilters;
  readonly id: string;
  readonly naam: string;
  readonly parserVersion: string;
  readonly queryText: string;
  readonly schemaVersion: string;
  readonly scopeId: string;
  readonly updatedAt: Date;
  readonly userId: string;
}

export interface QuerySnapshotRecord {
  readonly createdAt: Date;
  readonly filters: SearchFilters;
  readonly id: string;
  readonly indexVersion: number;
  readonly parserVersion: string;
  readonly queryText: string;
  readonly resultIds: readonly string[];
  readonly savedSearchId: string | null;
  readonly schemaVersion: string;
  readonly scopeId: string;
  /** Search scope the selection was made under (RJC-383): active stock or archive included. */
  readonly scope: SearchScope;
  /**
   * Durable search index version at snapshot time (RJC-385): the full
   * {generation, appliedSequence} from RJC-384. `indexVersion` above stays
   * populated (Number(appliedSequence)) for legacy readers only.
   */
  readonly searchVersion: SearchVersion;
  readonly userId: string;
}

export interface AanvraagVersieRecord {
  readonly geldigTot: Date | null;
  readonly geldigVan: Date;
  readonly id: string;
  readonly normalisatieversie: string;
  readonly scrapeRunId: string;
}

export interface AanvraagEnrichedField {
  readonly confidence: number;
  readonly field:
    | "contract"
    | "beschrijving"
    | "einddatum"
    | "locatie"
    | "opleiding"
    | "organisatie"
    | "publicatiedatum"
    | "remote"
    | "sluitingsdatum"
    | "startdatum"
    | "tarief"
    | "uren";
  readonly source: "deterministic" | "llm";
}

export interface AanvraagRecord {
  readonly beschrijving: string;
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly bronUrl?: string | null;
  /** CTP-610: contactpersonen the source published, after the bron's
   * contactpersoon_beleid retention mask. Empty/absent for bronnen that
   * publish none. */
  readonly contactpersonen?: readonly Contactpersoon[];
  readonly contracttype?: string | null;
  /** Existing dedup identity: set when this record shares a dedup group with
   * at least one other aanvraag. The UI surfaces it as a duplicate badge;
   * the record itself is never filtered out. */
  readonly dedupGroepId?: string | null;
  /** Duration text the source published when only a duration is given, not an end date (CTP-514, F11). */
  readonly duur?: string | null;
  /** Provenance for fields filled by the enrichment worker (CTP-482). */
  readonly enrichedFields?: readonly AanvraagEnrichedField[];
  readonly eindDatum?: string | null;
  readonly id: string;
  readonly locatie?: string | null;
  /** ISO-2 country the source published; null when it did not (CTP-514, F05). */
  readonly locatieLand?: string | null;
  readonly opdrachtgeverNaam?: string | null;
  readonly opleidingsniveau?: string | null;
  /** Canonical NL province the source published (CTP-514, F04). Never derived. */
  readonly provincie?: string | null;
  readonly publicatiedatum?: string | null;
  readonly rawPayloadRef: string;
  /** Skills the source published as structured data (CTP-514, F15). */
  readonly skills?: readonly string[];
  readonly startDatum?: string | null;
  readonly scrapeRunId: string;
  readonly sluitingsdatum?: Date | null;
  readonly status: string;
  readonly tariefEenheid?: string | null;
  readonly tariefMax?: number | null;
  readonly tariefMin?: number | null;
  readonly tariefValuta?: string | null;
  readonly titel: string;
  /** Motian identity parts used to recognize its exact title fallback. */
  readonly titleFallbackParts?: TitleFallbackDescriptionParts | null;
  readonly urenPerWeek?: string | null;
  readonly versies: readonly AanvraagVersieRecord[];
  readonly werkvorm?: string | null;
}

export interface RawPayloadRecord {
  readonly contentType: string;
  readonly preview: string;
  readonly ref: string;
  readonly full: string;
}

export interface AanvraagMarkering {
  readonly aanvraagId: string;
  readonly createdAt: Date;
  readonly reden: string | null;
  readonly revision: number;
  readonly scopeId: string;
  readonly status: "relevant" | "niet_relevant" | "gevolgd";
  readonly updatedAt: Date;
  readonly userId: string;
}

export interface MarkeerAuditMetadata {
  readonly reden: string | null;
  readonly status: "gevolgd" | "niet_relevant" | "relevant";
}

export interface ClearMarkeringAuditMetadata extends MarkeerAuditMetadata {
  readonly cleared: true;
  readonly revision: number;
}

export interface SavedSearchAuditMetadata {
  readonly deleted: boolean;
  readonly naam: string;
  readonly queryText: string;
}

export interface ApprovalAuditMetadata {
  readonly expiresAt: string;
  readonly motivatie: string;
  readonly snapshotId: string;
}

export interface CommitExportAuditMetadata {
  readonly approvalId: string;
  readonly created: number;
  readonly failed: number;
  readonly skipped: number;
  readonly snapshotId: string;
}

export interface ManualExportReconciliationAuditMetadata {
  readonly actionType: "create";
  readonly approvalId: string;
  readonly authorizationRef: string;
  readonly canonicalVacancyId: string;
  readonly evidenceRef: string;
  readonly externalId: string;
  readonly planHash: string;
  readonly snapshotId: string;
  readonly target: "spott";
}

export type MotianDerivedFieldRepairFieldName =
  | "opdrachtgeverNaam"
  | "contracttype"
  | "publicatiedatum"
  | "startDatum"
  | "sluitingsdatum"
  | "urenPerWeek"
  | "tariefMin"
  | "tariefMax"
  | "tariefEenheid"
  | "opleidingsniveau"
  | "provincie"
  | "skills";

export interface MotianDerivedFieldRepairAuditFieldImage {
  readonly contracttype: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly opleidingsniveau: string | null;
  readonly provincie: string | null;
  readonly publicatiedatum: string | null;
  /** `bron_specifiek.skills` as its canonical JSON array text, or null. */
  readonly skills: string | null;
  readonly sluitingsdatum: string | null;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefMin: string | null;
  readonly urenPerWeek: string | null;
}

/**
 * Strict, bounded metadata for the Motian v1 derived-field repair lane.
 * Values are limited to the nullable derived commercial columns; raw payloads and
 * arbitrary source JSON never belong in an audit event.
 */
export interface MotianDerivedFieldRepairAuditMetadata {
  readonly afterimage: MotianDerivedFieldRepairAuditFieldImage;
  readonly aanvraagId: string;
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly changedFields: readonly MotianDerivedFieldRepairFieldName[];
  readonly contentHash: string;
  readonly manifestSha256: string;
  readonly preimage: MotianDerivedFieldRepairAuditFieldImage;
  readonly rawPayloadRef: string;
  readonly repairVersion: "motian-v1-derived-field-repair/v3";
  readonly sourceAbsentFields: readonly MotianDerivedFieldRepairFieldName[];
  readonly v1Id: string;
}

export interface MotianDerivedFieldRepairRollbackAuditMetadata extends MotianDerivedFieldRepairAuditMetadata {
  readonly rollbackOfAuditId: string;
}

/**
 * Field image as the v2 repair wrote it, before CTP-514 added `provincie` and
 * `skills`. Kept so audits already stored by the v2 lane still decode.
 */
export type MotianDerivedFieldRepairV2AuditFieldImage = Omit<
  MotianDerivedFieldRepairAuditFieldImage,
  "provincie" | "skills"
>;

export interface MotianDerivedFieldRepairV2AuditMetadata extends Omit<
  MotianDerivedFieldRepairAuditMetadata,
  "afterimage" | "preimage" | "repairVersion"
> {
  readonly afterimage: MotianDerivedFieldRepairV2AuditFieldImage;
  readonly preimage: MotianDerivedFieldRepairV2AuditFieldImage;
  readonly repairVersion: "motian-v1-derived-field-repair/v2";
}

export interface MotianDerivedFieldRepairV2RollbackAuditMetadata extends MotianDerivedFieldRepairV2AuditMetadata {
  readonly rollbackOfAuditId: string;
}

/**
 * The `bron_specifiek` alias keys that shadow `contracttype`. Only the ones
 * this lane removed appear, with the value they held, so a rollback can put
 * back exactly what was there.
 */
export interface ZzpNegationLabelBronAliasImage {
  readonly contract_type?: string;
  readonly contracttype?: string;
}

export interface ZzpNegationLabelAuditImage {
  readonly bronSpecifiek: ZzpNegationLabelBronAliasImage;
  readonly contracttype: string | null;
}

/**
 * Strict, bounded metadata for the CTP-491 freelance-label correction lane.
 * The columns it writes, the row identity it was bound to, and the phrase that
 * justified the change. The phrase is capped by the writer, so an audit event
 * can never become a copy of the vacancy text; `matchedPhraseTruncated` says
 * when the cap was reached.
 */
export interface ZzpNegationLabelAuditMetadata {
  readonly aanvraagId: string;
  readonly afterimage: ZzpNegationLabelAuditImage;
  readonly applyVersion: "zzp-negation-label-apply/v1";
  readonly contentHash: string;
  readonly manifestSha256: string;
  readonly matchedPhrase: string;
  /** True when the phrase was longer than the audit cap and was cut to fit. */
  readonly matchedPhraseTruncated: boolean;
  readonly preimage: ZzpNegationLabelAuditImage;
  readonly versie: number;
}

export interface ZzpNegationLabelRollbackAuditMetadata extends ZzpNegationLabelAuditMetadata {
  readonly rollbackOfAuditId: string;
}

export type AuditEventMetadata =
  | ApprovalAuditMetadata
  | ClearMarkeringAuditMetadata
  | CommitExportAuditMetadata
  | ManualExportReconciliationAuditMetadata
  | MarkeerAuditMetadata
  | MotianDerivedFieldRepairAuditMetadata
  | MotianDerivedFieldRepairRollbackAuditMetadata
  | MotianDerivedFieldRepairV2AuditMetadata
  | MotianDerivedFieldRepairV2RollbackAuditMetadata
  | SavedSearchAuditMetadata
  | ZzpNegationLabelAuditMetadata
  | ZzpNegationLabelRollbackAuditMetadata;

export type AlertEvidenceValue = boolean | null | number | string;

export type AlertEvidence = Readonly<Record<string, AlertEvidenceValue>>;

export interface AuditEventRecord {
  readonly action: string;
  readonly actorId: string;
  readonly actorType: AuditActorType;
  readonly auditClass: AuditClass;
  readonly createdAt: Date;
  readonly entityId: string;
  readonly entityType: string;
  readonly id: string;
  readonly metadata: AuditEventMetadata;
  readonly scopeId: string;
}

export interface AlertRecord {
  readonly ackedAt: Date | null;
  readonly ackedBy: string | null;
  readonly bronId: string;
  readonly createdAt: Date;
  readonly dedupeKey: string;
  readonly evidence: AlertEvidence;
  readonly id: string;
  readonly kind: string;
  readonly message: string;
}

export interface BronHealthRecord {
  readonly bronId: string;
  readonly circuitStatus: string;
  readonly lastRunAt: Date | null;
  readonly lastRunStatus: string | null;
  readonly silenceAlertOpen: boolean;
}

export interface BronHealthRunFence {
  readonly bronId: string;
  readonly fenceToken: number;
  readonly runId: string;
}

export interface BronHealthRunWrite extends BronHealthRunFence {
  readonly record: BronHealthRecord;
}

export interface SavedSearchStore {
  createWithAudit: (
    record: Omit<SavedSearchRecord, "createdAt" | "id" | "updatedAt">,
    actorType: AuditActorType
  ) => Promise<{
    readonly auditEvent: AuditEventRecord;
    readonly savedSearch: SavedSearchRecord;
  }>;
  /**
   * Owner-scoped lookup. Returning null for another user's record prevents a
   * caller from discovering or binding another tenant's saved search by id.
   */
  getById: (
    id: string,
    userId: string,
    scopeId: string
  ) => Promise<SavedSearchRecord | null>;
  list: (
    userId: string,
    scopeId: string
  ) => Promise<readonly SavedSearchRecord[]>;
  removeWithAudit: (
    id: string,
    userId: string,
    scopeId: string,
    actorType: AuditActorType
  ) => Promise<{
    readonly auditEvent: AuditEventRecord;
    readonly savedSearch: SavedSearchRecord;
  } | null>;
  updateWithAudit: (
    id: string,
    userId: string,
    scopeId: string,
    patch: Pick<
      SavedSearchRecord,
      "filters" | "naam" | "parserVersion" | "queryText" | "schemaVersion"
    >,
    actorType: AuditActorType
  ) => Promise<{
    readonly auditEvent: AuditEventRecord;
    readonly savedSearch: SavedSearchRecord;
  } | null>;
}

/** Keyset cursor for list_snapshots paging: created_at desc, id desc. */
export interface SnapshotListCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListedSnapshotApproval {
  readonly actorId: string;
  readonly expiresAt: Date;
}

export interface ListedSnapshotExport {
  readonly externalIdCount: number;
  /** True when any attempt for the snapshot reached a success status. */
  readonly hasSuccess: boolean;
  readonly lastAttemptAt: Date;
  readonly status: ExportAttemptStatus;
}

/** Joined list row: snapshot plus latest approval and latest export attempt. */
export interface ListedSnapshotRecord {
  readonly actorId: string;
  readonly approval: ListedSnapshotApproval | null;
  readonly createdAt: Date;
  readonly export: ListedSnapshotExport | null;
  readonly id: string;
  readonly query: string;
  readonly resultCount: number;
}

export interface QuerySnapshotStore {
  create: (
    record: Omit<QuerySnapshotRecord, "createdAt" | "id">
  ) => Promise<QuerySnapshotRecord>;
  getById: (id: string, scopeId: string) => Promise<QuerySnapshotRecord | null>;
  /**
   * Owner-scoped keyset listing ordered by created_at desc, id desc. One
   * joined read: latest approval per snapshot plus the latest export attempt
   * and the count of external ids; no per-row lookups.
   */
  list: (input: {
    readonly cursor?: SnapshotListCursor;
    readonly limit: number;
    readonly scopeId: string;
    readonly userId: string;
  }) => Promise<readonly ListedSnapshotRecord[]>;
}

export interface ApprovalRecord {
  readonly actorId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly id: string;
  readonly motivatie: string;
  readonly resultIds: readonly string[];
  readonly scopeId: string;
  readonly snapshotId: string;
}

export type ApprovalWriteResult =
  | {
      readonly approval: ApprovalRecord;
      readonly auditEvent: AuditEventRecord;
      readonly created: boolean;
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly reason: "snapshot_already_approved";
    };

export interface ApprovalStore {
  /** Atomically persists the approval and its audit event. Exact retries are idempotent. */
  createWithAudit: (
    record: Omit<ApprovalRecord, "createdAt" | "id">,
    actorType: AuditActorType
  ) => Promise<ApprovalWriteResult>;
  getBySnapshotId: (
    snapshotId: string,
    scopeId: string
  ) => Promise<ApprovalRecord | null>;
}

export interface AanvraagStore {
  getById: (id: string) => Promise<AanvraagRecord | null>;
  /**
   * Batch read for search hydration (RJC-379). Returns records in input-id
   * order; ids without a record are skipped rather than failing the batch.
   */
  getByIds: (ids: readonly string[]) => Promise<readonly AanvraagRecord[]>;
  listVersies: (aanvraagId: string) => Promise<readonly AanvraagVersieRecord[]>;
}

export interface RawPayloadStore {
  getByRef: (ref: string) => Promise<RawPayloadRecord | null>;
}

export interface MarkeringStore {
  get: (
    aanvraagId: string,
    userId: string,
    scopeId: string
  ) => Promise<AanvraagMarkering | null>;
  /**
   * The only markering write boundary. Implementations must persist the
   * markering and its audit event atomically, or persist neither.
   */
  setWithAudit: (
    markering: Omit<AanvraagMarkering, "createdAt" | "revision" | "updatedAt">,
    actorType: AuditActorType
  ) => Promise<{
    readonly auditEvent: AuditEventRecord;
    readonly markering: AanvraagMarkering;
  }>;
  clearWithAudit: (
    aanvraagId: string,
    userId: string,
    scopeId: string,
    actorType: AuditActorType
  ) => Promise<{
    readonly auditEvent: AuditEventRecord;
    readonly cleared: AanvraagMarkering;
  } | null>;
}

export interface AuditStore {
  append: (
    event: Omit<AuditEventRecord, "createdAt" | "id">
  ) => Promise<AuditEventRecord>;
  /** Internal owner-scoped read used for verification and future audit UI. */
  listByActorId: (
    actorId: string,
    scopeId: string
  ) => Promise<readonly AuditEventRecord[]>;
  /** Bounded newest-first read ordered by createdAt and id within owner/scope. */
  listRecentByActorId: (
    actorId: string,
    scopeId: string,
    limit: number
  ) => Promise<readonly AuditEventRecord[]>;
}

export interface AlertStore {
  ack: (alertId: string, actorId: string) => Promise<AlertRecord | null>;
  create: (
    record: Omit<AlertRecord, "ackedAt" | "ackedBy" | "createdAt" | "id"> & {
      readonly id?: string;
    }
  ) => Promise<AlertRecord>;
  findOpenByDedupeKey: (dedupeKey: string) => Promise<AlertRecord | null>;
  getById: (alertId: string) => Promise<AlertRecord | null>;
  listOpen: () => Promise<readonly AlertRecord[]>;
}

export interface BronHealthStore {
  getByBronId: (bronId: string) => Promise<BronHealthRecord | null>;
  list: () => Promise<readonly BronHealthRecord[]>;
  upsert: (record: BronHealthRecord) => Promise<BronHealthRecord>;
  /**
   * Updates health only while this run still owns the source. The null result
   * is an ownership loss and must not be treated as a successful health write.
   */
  upsertForRun?: (
    input: BronHealthRunWrite
  ) => Promise<BronHealthRecord | null>;
}

export interface OperatorRunStore {
  startRun: (bronId: string) => Promise<{ readonly runId: string }>;
  startTestImport: (bronId: string) => Promise<{ readonly runId: string }>;
}

export type ExportTarget = "spott";

export type ExportActionType = "create";

export type ExportEffectStatus =
  | "reserved"
  | "external_id_acquired"
  | "confirmed";

export type ExportExternalIdSource = "manual_evidence" | "provider_response";

export interface ExportEffectKey {
  readonly actionType: ExportActionType;
  readonly canonicalVacancyId: string;
  readonly scopeId: string;
  readonly target: ExportTarget;
}

export interface ExportEffectRecord extends ExportEffectKey {
  readonly createdAt: Date;
  readonly externalId: string | null;
  readonly externalIdSource: ExportExternalIdSource | null;
  readonly status: ExportEffectStatus;
  readonly updatedAt: Date;
}

/** Outcome of this local invocation; `failed` does not prove provider failure. */
export type ExportAttemptStatus = "created" | "failed" | "skipped";

export interface ExternalIdCrosswalkRecord {
  readonly actionType: ExportActionType;
  readonly canonicalVacancyId: string;
  readonly createdAt: Date;
  readonly externalId: string;
  readonly scopeId: string;
  readonly target: ExportTarget;
}

export interface ExternalIdCrosswalkStore {
  create: (
    record: Omit<ExternalIdCrosswalkRecord, "createdAt">
  ) => Promise<ExternalIdCrosswalkRecord>;
  get: (input: {
    actionType: ExportActionType;
    canonicalVacancyId: string;
    scopeId: string;
    target: ExportTarget;
  }) => Promise<ExternalIdCrosswalkRecord | null>;
}

export interface ExportAttemptRecord {
  readonly actionType: ExportActionType;
  readonly approvalId: string;
  readonly canonicalVacancyId: string;
  readonly createdAt: Date;
  readonly errorMessage: string | null;
  readonly externalId: string | null;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly snapshotId: string;
  readonly scopeId: string;
  readonly status: ExportAttemptStatus;
  readonly target: ExportTarget;
}

export interface ExportAttemptStore {
  create: (
    record: Omit<ExportAttemptRecord, "createdAt" | "id">
  ) => Promise<ExportAttemptRecord>;
  listBySnapshotId: (
    snapshotId: string,
    scopeId: string
  ) => Promise<readonly ExportAttemptRecord[]>;
}

export interface ExternalReceiptRecord {
  readonly canonicalVacancyId: string;
  readonly confirmedEffect: boolean;
  readonly createdAt: Date;
  readonly exportAttemptId: string;
  readonly id: string;
  readonly responseHash: string;
  readonly scopeId: string;
  readonly spottVacancyId: string | null;
}

export interface ExternalReceiptStore {
  create: (
    record: Omit<ExternalReceiptRecord, "createdAt" | "id">
  ) => Promise<ExternalReceiptRecord>;
  getByExportAttemptId: (
    exportAttemptId: string,
    scopeId: string
  ) => Promise<ExternalReceiptRecord | null>;
  listByCanonicalVacancyId: (
    canonicalVacancyId: string,
    scopeId: string
  ) => Promise<readonly ExternalReceiptRecord[]>;
}

export type FinalizeConfirmedExportResult =
  | {
      readonly created: false;
      readonly externalId: string;
    }
  | {
      readonly attempt: ExportAttemptRecord;
      readonly created: true;
      readonly externalId: string;
      readonly receipt: ExternalReceiptRecord;
    };

export interface ExportEffectStore {
  /**
   * Atomically claims the provider-effect key. A non-acquired reservation is
   * never safe to POST again; a known provider ID authorizes GET-only repair.
   */
  reserve: (key: ExportEffectKey) => Promise<{
    readonly acquired: boolean;
    readonly effect: ExportEffectRecord;
  }>;
  /**
   * Persists provider evidence before confirmation. A different existing ID
   * is a hard conflict and must never be overwritten.
   */
  recordExternalId: (
    key: ExportEffectKey & {
      readonly externalId: string;
      readonly source: ExportExternalIdSource;
    }
  ) => Promise<ExportEffectRecord>;
  /**
   * Atomically confirms the reservation and writes its crosswalk, successful
   * attempt and receipt. Exact concurrent finalizations return created=false.
   */
  finalizeConfirmed: (
    input: ExportEffectKey & {
      readonly approvalId: string;
      readonly externalId: string;
      readonly idempotencyKey: string;
      readonly responseHash: string;
      readonly snapshotId: string;
    }
  ) => Promise<FinalizeConfirmedExportResult>;
}

export interface SliceAStores {
  readonly alerts: AlertStore;
  readonly aanvragen: AanvraagStore;
  readonly approvals: ApprovalStore;
  readonly audit: AuditStore;
  readonly bronHealth: BronHealthStore;
  readonly exportEffects: ExportEffectStore;
  readonly exportAttempts: ExportAttemptStore;
  readonly externalCrosswalk: ExternalIdCrosswalkStore;
  readonly externalReceipts: ExternalReceiptStore;
  readonly markeringen: MarkeringStore;
  readonly operatorRuns: OperatorRunStore;
  readonly rawPayloads: RawPayloadStore;
  readonly savedSearches: SavedSearchStore;
  readonly snapshots: QuerySnapshotStore;
}

export interface BronRunFailureCount {
  readonly code: string;
  readonly count: number;
}

/**
 * One row of `bron_run_stats`. `bronId` is `null` on the `totaal` row only.
 *
 * Grouped by `bron_id`, never by `naam`: the seven legacy Motian rows share
 * their display name with live sources, so grouping by name silently merges a
 * dead source into a healthy one.
 */
export interface BronRunStatsRow {
  readonly aantalGevonden: number;
  readonly actief: boolean | null;
  readonly avgDurationMs: number | null;
  readonly bronId: string | null;
  readonly cancelled: number;
  readonly failed: number;
  readonly fouten: number;
  readonly gesloten: number;
  readonly gewijzigd: number;
  readonly interval: string | null;
  readonly lastFailureClass: string | null;
  readonly lastFailureCode: string | null;
  readonly lastFailureMessage: string | null;
  readonly lastFailurePhase: string | null;
  readonly lastRunAt: Date | null;
  readonly lastRunStatus: string | null;
  readonly naam: string | null;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly p95DurationMs: number | null;
  readonly rejected: number;
  readonly runs: number;
  readonly running: number;
  readonly succeeded: number;
  readonly successRate: number | null;
  readonly topFailures: readonly BronRunFailureCount[];
}

export interface BronRunStatsResult {
  readonly bronnen: readonly BronRunStatsRow[];
  readonly runKind: BronRunKindFilter;
  readonly since: Date;
  readonly totaal: BronRunStatsRow;
  readonly window: BronRunStatsWindow;
}

export interface BronRunTimeseriesPoint {
  readonly aantalGevonden: number;
  readonly avgDurationMs: number | null;
  readonly bronId: string;
  readonly bucket: Date;
  readonly failed: number;
  readonly fouten: number;
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly rejected: number;
  readonly runs: number;
  readonly succeeded: number;
}

export interface BronRunStatsQuery {
  /** Restrict to these sources. Omitted means every source in the register. */
  readonly bronIds?: readonly string[];
  /** Injected so the window is deterministic under test. */
  readonly now?: Date;
  /** Defaults to `poll`, which keeps legacy backfill runs out of poll stats. */
  readonly runKind?: BronRunKindFilter;
  readonly window: BronRunStatsWindow;
}

export interface BronRunTimeseriesQuery extends BronRunStatsQuery {
  readonly bucket?: BronRunTimeseriesBucket;
}

/**
 * Reads the brondashboard aggregates straight from Postgres.
 *
 * Deliberately has no dependency on Trigger.dev or any other network service:
 * Motian's dashboard called the Trigger.dev runs API on every page load, which
 * cost 1-10s per request and occasionally timed out. Scheduler liveness is
 * derived from run rows instead.
 */
export interface BronRunStatsReader {
  bronRunStats: (query: BronRunStatsQuery) => Promise<BronRunStatsResult>;
  bronRunTimeseries: (
    query: BronRunTimeseriesQuery
  ) => Promise<readonly BronRunTimeseriesPoint[]>;
}

export interface ScrapeRunListQuery {
  readonly bronId?: string;
  readonly cursor?: string;
  readonly failureCode?: string;
  readonly limit?: number;
  readonly runKind?: BronRunKindFilter;
  readonly since?: Date;
  readonly status?: "cancelled" | "failed" | "running" | "succeeded";
}

export interface ScrapeRunCheckpoint {
  readonly cursor?: number | string;
  readonly hasMore?: boolean;
  readonly offset?: number;
  readonly page?: number;
}

export interface ScrapeRunLifecycleSummary {
  readonly incremented: number;
  readonly reopened: number;
  readonly reset: number;
  readonly staled: number;
}

export interface ScrapeRunObservationDistribution {
  readonly created: number;
  readonly rejected: number;
  readonly unchanged: number;
  readonly updated: number;
}

export interface ScrapeRunView {
  readonly aantalGevonden: number;
  readonly bronId: string;
  readonly checkpoint: ScrapeRunCheckpoint | null;
  readonly circuitStatus: string;
  readonly createdAt: Date;
  readonly failureClass: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly failurePhase: string | null;
  readonly fouten: number;
  readonly geindigd: Date | null;
  readonly gesloten: number;
  readonly gestart: Date;
  readonly gewijzigd: number;
  readonly id: string;
  readonly lifecycleSummary: ScrapeRunLifecycleSummary;
  readonly nieuw: number;
  readonly observationDistribution: ScrapeRunObservationDistribution;
  readonly rejected: number;
  readonly runKind: BronRunKindFilter;
  readonly status: string;
  readonly versieAdapter: string | null;
}

export interface ScrapeRunReader {
  getById: (id: string) => Promise<ScrapeRunView | null>;
  list: (query: ScrapeRunListQuery) => Promise<{
    readonly items: readonly ScrapeRunView[];
    readonly nextCursor: string | null;
  }>;
}

/**
 * Cross-bron overlap from curated.dedup_groep + aanvraag_bron_link (DEC-003).
 * No second matching heuristic — Motian overlap strategies stay out of JI.
 */
export interface BronOverlapGroup {
  readonly aanvraagCount: number;
  readonly bronCount: number;
  readonly bronIds: readonly string[];
  readonly bronNamen: readonly string[];
  readonly groepId: string;
}

export interface BronOverlapBronShare {
  readonly bronId: string;
  readonly naam: string;
  readonly overlappingAanvragen: number;
  readonly share: number | null;
  readonly totalAanvragen: number;
}

export interface BronOverlapResult {
  readonly overlapGroepCount: number;
  readonly perBron: readonly BronOverlapBronShare[];
  readonly topGroups: readonly BronOverlapGroup[];
}

export interface BronOverlapReader {
  bronOverlap: () => Promise<BronOverlapResult>;
}

/**
 * Read-only analytics port over the `marts` schema (Marktvragen / JI-DSH-07).
 * Implementations enforce the SELECT-only contract themselves — the port
 * deliberately takes raw SQL because the agent writes it. Handlers must not
 * pre-execute or mutate the SQL beyond validation.
 */
export interface MartsColumnInfo {
  readonly dataType: string;
  readonly name: string;
  readonly nullable: boolean;
}

export interface MartsTableInfo {
  readonly columns: readonly MartsColumnInfo[];
  readonly name: string;
}

/** One marts result row: JSON-shaped cell values keyed by column name. */
export type MartsRow = Readonly<Record<string, JsonValue>>;

export interface MartsQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly MartsRow[];
  /** True when more rows matched than the reader's row cap returned. */
  readonly truncated: boolean;
}

/**
 * SQL-level outcome: `ok:false` means the query itself was rejected (guard
 * violation or Postgres parse/plan error) and `reason` is safe to show the
 * agent — it is the feedback signal it rewrites against. Infra failures
 * (connection, timeout misconfiguration) still throw.
 */
export type MartsSqlOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface MartsReader {
  /** Pre-execution validation (EXPLAIN). Returns one plan line per row. */
  explain: (sql: string) => Promise<MartsSqlOutcome<readonly string[]>>;
  /** Live introspection of the marts schema (tables + columns). */
  listTables: () => Promise<readonly MartsTableInfo[]>;
  /**
   * Execute a guarded SELECT inside a read-only transaction with a statement
   * timeout and a row cap.
   */
  query: (sql: string) => Promise<MartsSqlOutcome<MartsQueryResult>>;
}
