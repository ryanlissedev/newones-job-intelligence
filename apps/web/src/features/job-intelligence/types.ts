/* oxlint-disable prefer-export-from -- JOB_* aliases keep existing UI import paths while SoT lives in ./contracts (CTP-475). */
import {
  AANVRAAG_LIFECYCLE,
  MARKERING_STATUSES,
  SEARCH_SCOPES,
  SEARCH_SORT_OPTIONS,
} from "./contracts";
import type {
  ApprovalView,
  CommitExportResult,
  ExportStatusView,
  MarkeringStatus,
  SearchScope,
  SearchSort,
  SnapshotApprovalView,
  SnapshotDetailView,
} from "./contracts";

export const JOB_MARKERING_STATUSES = MARKERING_STATUSES;
export const JOB_SEARCH_SCOPES = SEARCH_SCOPES;
export const JOB_SORT_OPTIONS = SEARCH_SORT_OPTIONS;
/** Lifecycle values sent to the search API; presentation status stays separate. */
export const JOB_SEARCH_STATUS_VALUES = AANVRAAG_LIFECYCLE;
export type JobMarkeringStatus = MarkeringStatus;
export type JobSearchScope = SearchScope;
export type JobSort = SearchSort;
export type JobSearchStatus = (typeof JOB_SEARCH_STATUS_VALUES)[number];
/** CTP-509: Motian-style results page sizes (explicit API cap SEARCH_MAX_LIMIT=1000). */
export const JOB_PAGE_SIZE_OPTIONS = [25, 50, 100, 500, 1000] as const;
export type JobPageSize = (typeof JOB_PAGE_SIZE_OPTIONS)[number];
export const JOB_PAGE_SIZE: JobPageSize = 50;

export const RESULTS_VIEW_MODES = ["list", "map"] as const;
export type ResultsViewMode = (typeof RESULTS_VIEW_MODES)[number];
export const DEFAULT_RESULTS_VIEW_MODE: ResultsViewMode = "list";

export const JOB_CONTRACT_TYPES = [
  "interim",
  "detachering",
  "vast",
  "freelance",
] as const;

export type JobContractType = (typeof JOB_CONTRACT_TYPES)[number];

export const JOB_LIFECYCLE_STATUSES = [
  "open",
  "closing-soon",
  "closed",
] as const;

export type JobLifecycleStatus = (typeof JOB_LIFECYCLE_STATUSES)[number];

/**
 * RJC-394/RJC-449: the production search loader
 * (packages/db PostgresSearchDocumentLoader) fills `locatie` from the
 * curated `locatie_tekst` column and leaves it explicitly unknown when the
 * source publishes no location. It also fills `sluitingsdatum` from the
 * curated columns the normalisers populate. Existing rows require the search
 * generation replay before these semantics are reflected in the index.
 */
export const ENRICHED_SEARCH_DATA_AVAILABLE = true;

export const selectableJobSortOptions = (
  enrichedDataAvailable: boolean
): readonly JobSort[] =>
  enrichedDataAvailable
    ? SEARCH_SORT_OPTIONS
    : SEARCH_SORT_OPTIONS.filter((option) => option !== "closing-soon");

export const FRESHNESS_FILTERS = ["all", "24h", "7d", "30d"] as const;

/**
 * RJC-383: which search partitions a query reads. "active" is the placeable
 * stock and the default; "all" also searches the archive (closed, stale and
 * expired work) — the "ook in archief zoeken" toggle.
 */
export type FreshnessFilter = (typeof FRESHNESS_FILTERS)[number];

export const PREVIEW_STATUSES = [
  "ready",
  "loading",
  "empty",
  "syntax-error",
  "engine-error",
] as const;

export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

// RJC-368: sources are registered dynamically via the bron register (12+ and
// growing), so this is an opaque slug derived from the live /v1/bronnen
// catalog, not a fixed enum.
export type JobSource = string;

export interface JobSourceOption {
  readonly label: string;
  readonly value: JobSource;
}

export interface JobSourceRecord {
  /** Registered catalog label shown to users; `name` remains the stable slug. */
  readonly displayName: string;
  readonly id: string;
  readonly name: JobSource;
  readonly reference: string;
  readonly url: string;
  readonly scrapeRunId: string;
  readonly normalizationVersion: string;
  readonly firstSeenAt?: string | null;
  readonly lastSeenAt?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
}

export type JobRatePeriod = "hour" | "day" | "month" | "year" | "unknown";

export type JobRate = {
  readonly currency: "EUR";
  readonly period: JobRatePeriod;
} & (
  | {
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly min: number;
      readonly max: null;
    }
  | {
      readonly min: null;
      readonly max: number;
    }
);

export interface JobMarkering {
  readonly reden: string | null;
  /** Monotone server version used by the bounded detail poller. */
  readonly revision?: number;
  readonly status: JobMarkeringStatus;
  readonly updatedAt?: string;
}

export type JobEnrichedFieldName =
  | "beschrijving"
  | "contract"
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

export interface JobEnrichedField {
  readonly confidence: number;
  readonly field: JobEnrichedFieldName;
  readonly source: "deterministic" | "llm";
}

export const AANGEVULD_MIN_CONFIDENCE = 0.8;

export type MarkeringSyncState =
  | "idle"
  | "pending"
  | "commit"
  | "failure"
  | "uncertain";

/** CTP-610: a contactpersoon the source published on the vacancy. */
export interface JobContactpersoon {
  readonly email: string | null;
  readonly naam: string | null;
  readonly rol: string | null;
  readonly telefoon: string | null;
}

export interface JobListing {
  readonly id: string;
  readonly title: string;
  readonly organization: string | null;
  readonly location: string | null;
  /** Canonical NL province the source published; null when it did not. */
  readonly provincie?: string | null;
  readonly country: "NL" | null;
  readonly contractType: JobContractType | null;
  /** CTP-610: contactpersonen published by the source (recruiter detail only). */
  readonly contactpersonen?: readonly JobContactpersoon[];
  /** CTP-610: set when this listing shares a dedup group with another
   * aanvraag — surfaced as a duplicate indicator, never filtered out. */
  readonly dedupGroepId?: string | null;
  readonly rate: JobRate | null;
  readonly skills: readonly string[];
  readonly sourceRecords: readonly JobSourceRecord[];
  readonly publishedAt: string | null;
  readonly closingAt: string | null;
  readonly status: JobLifecycleStatus;
  readonly summary: string;
  readonly description: string;
  readonly educationLevel?: string | null;
  readonly endDate?: string | null;
  /** Duration text the source published when only a duration, not an end date, is given. */
  readonly duration?: string | null;
  readonly hoursPerWeek?: string | null;
  readonly remote: boolean | null;
  /** Curated source wording when a bron explicitly publishes the work form. */
  readonly workArrangement?: string | null;
  readonly markering?: JobMarkering | null;
  readonly enrichedFields?: readonly JobEnrichedField[];
  readonly rawPreview?: string;
  readonly startDate?: string | null;
}

/** Motian-parity work arrangement → SearchFilters.werkvormen. */
export const JOB_WERKVORMEN = ["hybride", "op_locatie", "remote"] as const;
export type JobWerkvorm = (typeof JOB_WERKVORMEN)[number];

/** Query text scope (title vs all) — distinct from archive JobSearchScope. */
export const JOB_QUERY_SCOPES = ["all", "title"] as const;
export type JobQueryScope = (typeof JOB_QUERY_SCOPES)[number];
export const DEFAULT_JOB_QUERY_SCOPE: JobQueryScope = "all";

/** Canonical NL provinces for the province facet (index fill often sparse). */
export const NL_PROVINCES = [
  "Drenthe",
  "Flevoland",
  "Friesland",
  "Gelderland",
  "Groningen",
  "Limburg",
  "Noord-Brabant",
  "Noord-Holland",
  "Overijssel",
  "Utrecht",
  "Zeeland",
  "Zuid-Holland",
] as const;

export interface JobSearchFilters {
  readonly sources: readonly JobSource[];
  readonly contractTypes: readonly JobContractType[];
  readonly locations: readonly string[];
  readonly status: readonly JobSearchStatus[];
  readonly freshness: FreshnessFilter;
  /** Hourly rate lower bound → tariefMin. */
  readonly minRate: number | null;
  /** Hourly rate upper bound → tariefMax. */
  readonly maxRate: number | null;
  /** Work arrangement → werkvormen. */
  readonly werkvormen: readonly JobWerkvorm[];
  /** Province → provincies (sparse OK; no invented facet counts). */
  readonly provincies: readonly string[];
  /** Skills → skills (often empty until enrichment). */
  readonly skills: readonly string[];
  /** Hours/week → urenPerWeekMin/Max. */
  readonly urenPerWeekMin: number | null;
  readonly urenPerWeekMax: number | null;
  /** Posted between → publicatiedatumVanaf/Tot (YYYY-MM-DD). */
  readonly publicatiedatumVanaf: string | null;
  readonly publicatiedatumTot: string | null;
  /** Title vs all → SearchFilters.queryScope (not archive scope). */
  readonly queryScope: JobQueryScope;
}

export interface JobSearchState {
  readonly query: string;
  readonly filters: JobSearchFilters;
  readonly scope: JobSearchScope;
  readonly sort: JobSort;
  readonly page: number;
  /** Results page size — allowlisted JOB_PAGE_SIZE_OPTIONS (CTP-509). */
  readonly pageSize: JobPageSize;
  readonly selectedJobId: string | null;
  readonly previewStatus: PreviewStatus;
}

export interface JobSearchRequest extends Omit<JobSearchState, "pageSize"> {
  /**
   * Page size for the request. UI uses JOB_PAGE_SIZE_OPTIONS; overview may use 1.
   * Search API rejects values above SEARCH_MAX_LIMIT (no silent truncate).
   */
  readonly pageSize?: number;
}

export interface FacetCount<T extends string = string> {
  readonly value: T;
  readonly count: number;
}

export interface JobSearchFacets {
  readonly sources: readonly FacetCount<JobSource>[];
  readonly contractTypes: readonly FacetCount<JobContractType>[];
  readonly locations: readonly FacetCount[];
  readonly status: readonly FacetCount<JobSearchStatus>[];
  /** Optional Motian-parity facets; absent only for legacy callers. */
  readonly provincies?: readonly FacetCount[];
  readonly werkvormen?: readonly FacetCount<JobWerkvorm>[];
  readonly skills?: readonly FacetCount[];
}

export interface JobSearchResponse {
  readonly items: readonly JobListing[];
  readonly total: number;
  /** Matches the same search has in the archive; null when the archive was searched too (RJC-383). */
  readonly archiveTotal: number | null;
  /** False when the engine timed out and returned only a partial result set. */
  readonly complete: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly facets: JobSearchFacets;
  readonly status: PreviewStatus;
  readonly message: string | null;
}

export interface JobDataAdapter {
  readonly getById: (id: string) => Promise<JobListing | null>;
  /** Read-only, actor and resource scoped marker readback for open details. */
  readonly getMarkering?: (
    id: string,
    signal?: AbortSignal
  ) => Promise<JobMarkering | null>;
  readonly listSources: () => Promise<readonly JobSourceOption[]>;
  readonly search: (request: JobSearchRequest) => Promise<JobSearchResponse>;
}

export interface SavedSearchSummary {
  readonly filters: JobSearchFilters;
  readonly id: string;
  readonly naam: string;
  readonly query: string;
  readonly updatedAt: string;
}

export interface JobIntelligenceActions {
  readonly createSavedSearch: (input: {
    readonly filters: JobSearchFilters;
    readonly naam: string;
    readonly query: string;
  }) => Promise<{ readonly id: string; readonly naam: string }>;
  readonly createSnapshot: (input: {
    readonly filters: JobSearchFilters;
    readonly query: string;
    readonly scope: JobSearchScope;
    readonly selectedIds: readonly string[];
  }) => Promise<{ readonly id: string; readonly resultCount: number }>;
  readonly deleteSavedSearch: (id: string) => Promise<void>;
  readonly listSavedSearches: () => Promise<readonly SavedSearchSummary[]>;
  readonly markeerAanvraag: (input: {
    readonly aanvraagId: string;
    readonly reden?: string | null;
    readonly status: JobMarkeringStatus;
  }) => Promise<JobMarkering>;
  // CTP-652: snapshot approval/export screen actions.
  readonly getSnapshot: (id: string) => Promise<SnapshotDetailView>;
  /** Resolves null when the API answers APPROVAL_NOT_FOUND. */
  readonly getSnapshotApproval: (
    id: string
  ) => Promise<SnapshotApprovalView | null>;
  readonly approveSnapshot: (input: {
    readonly expiresAt: string;
    readonly id: string;
    readonly motivatie: string;
  }) => Promise<ApprovalView>;
  readonly commitExport: (snapshotId: string) => Promise<CommitExportResult>;
  readonly getExportStatus: (snapshotId: string) => Promise<ExportStatusView>;
}

export const DEFAULT_JOB_SEARCH_STATE: JobSearchState = {
  filters: {
    contractTypes: [],
    freshness: "all",
    locations: [],
    maxRate: null,
    minRate: null,
    provincies: [],
    publicatiedatumTot: null,
    publicatiedatumVanaf: null,
    queryScope: DEFAULT_JOB_QUERY_SCOPE,
    skills: [],
    sources: [],
    status: [],
    urenPerWeekMax: null,
    urenPerWeekMin: null,
    werkvormen: [],
  },
  page: 1,
  pageSize: JOB_PAGE_SIZE,
  previewStatus: "ready",
  query: "",
  scope: "active",
  selectedJobId: null,
  sort: "relevance",
};
