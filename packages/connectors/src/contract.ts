import type { BronId, ScrapeRunId, SourceRecordId } from "@ji/domain";

import type { RawContentType } from "./object-store";
import { mergeOutcomeCounts } from "./run-outcomes";
import type { RejectKind, RunOutcomeCounts } from "./run-outcomes";

export const CONNECTOR_OBSERVATION_CONTRACT_VERSION =
  "connector-observation/v1" as const;
export const CONNECTOR_FIXTURE_CONTRACT_VERSION =
  "connector-fixture/v1" as const;

export interface ConnectorCheckpoint {
  cursor?: string;
  page?: number;
  pageSize?: number;
}

export interface DiscoverItem {
  bronReferentie: string;
  contentHash: string;
  listingPayload?: unknown;
}

export interface ConnectorDiscoverResult {
  checkpoint: ConnectorCheckpoint;
  hasMore: boolean;
  items: DiscoverItem[];
  /**
   * RJC-397: set when the connector stopped paging before the source ran
   * out (a page cap such as STRIIVE_MAX_PAGES) while still reporting
   * `hasMore: false`. A truncated run must not count unseen records as
   * missed, so the runner reports it as incomplete. Absent means the
   * connector exhausted the listing.
   */
  truncated?: boolean;
}

export interface ConnectorFetchedResult {
  body: Uint8Array;
  bronReferentie: string;
  contentHash: string;
  contentType: RawContentType;
  status: "fetched";
}

export interface ConnectorRejectedResult {
  bronReferentie: string;
  /** Classifies the rejection for run accounting; absent counts as `invalid`. */
  kind?: RejectKind;
  reason: string;
  status: "rejected";
}

export type ConnectorFetchResult =
  | ConnectorFetchedResult
  | ConnectorRejectedResult;

export interface ConnectorRunMetrics {
  changed: number;
  closed?: number;
  error: number;
  found: number;
  new: number;
  /** Per-outcome counters persisted as `scrape_run.outcome_counts`. */
  outcomes?: RunOutcomeCounts;
  rejected: number;
  unchanged: number;
}

/** Stable hand-off from source connectors to the U5 normalisation pipeline. */
export interface ConnectorObservation {
  contractVersion: typeof CONNECTOR_OBSERVATION_CONTRACT_VERSION;
  bronId: BronId;
  bronReferentie: string;
  contentHash: string;
  contentType: RawContentType;
  observedAt: string;
  rawPayloadRef: string;
  scrapeRunId: ScrapeRunId;
  sourceRecordId: SourceRecordId;
}

/** Source-owned, serialisable fixture envelope. Payloads remain source-specific. */
export interface ConnectorFixture {
  contractVersion: typeof CONNECTOR_FIXTURE_CONTRACT_VERSION;
  source: string;
  capturedAt: string;
  /** What the committed file actually holds, when that is narrower than the
   * capture it came from (e.g. one sanitised record out of a 25-record page).
   * Keeps a fixture from being read as evidence it cannot carry. */
  captureNote?: string;
  contentType: RawContentType;
  payload: unknown;
}

export interface Connector {
  readonly bronId: BronId;
  /**
   * Whether fetch() requests the upstream source. Omitted means network-backed,
   * so fetches remain subject to the per-source request limiter by default.
   */
  readonly fetchUsesNetwork?: boolean;
  discover: (
    checkpoint: ConnectorCheckpoint | null,
    signal?: AbortSignal
  ) => Promise<ConnectorDiscoverResult>;
  fetch: (
    item: DiscoverItem,
    signal?: AbortSignal
  ) => Promise<ConnectorFetchResult | null>;
  /**
   * Optional pre-fetch check, answered from local state only. True means the
   * item is unchanged since its last persisted fetch: the runner counts it as
   * observed (never missed) and skips `fetch` without taking a request-limiter
   * slot, so an unchanged page costs no crawl delay.
   */
  skipFetch?: (item: DiscoverItem) => Promise<boolean>;
}

export const emptyRunMetrics = (): ConnectorRunMetrics => ({
  changed: 0,
  error: 0,
  found: 0,
  new: 0,
  rejected: 0,
  unchanged: 0,
});

export const mergeRunMetrics = (
  left: ConnectorRunMetrics,
  right: ConnectorRunMetrics
): ConnectorRunMetrics => {
  const merged: ConnectorRunMetrics = {
    changed: left.changed + right.changed,
    error: left.error + right.error,
    found: left.found + right.found,
    new: left.new + right.new,
    rejected: left.rejected + right.rejected,
    unchanged: left.unchanged + right.unchanged,
  };
  if (left.closed !== undefined || right.closed !== undefined) {
    merged.closed = (left.closed ?? 0) + (right.closed ?? 0);
  }
  const outcomes = mergeOutcomeCounts(left.outcomes, right.outcomes);
  if (outcomes !== undefined) {
    merged.outcomes = outcomes;
  }
  return merged;
};

/** CTP-610: one contactpersoon as published by a source payload. The
 * pipeline-owned art. 14 fields (`geinformeerdOp`, `notificatieKanaal`) are
 * added downstream; a source only ever supplies these four. */
export interface SourceContact {
  email?: string | null;
  naam?: string | null;
  rol?: string | null;
  telefoon?: string | null;
}
