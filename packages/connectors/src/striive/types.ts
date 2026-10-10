import type { SourceContact } from "../contract";

/**
 * Striive is a Craft CMS-fronted JSON API (`striive-cms.codebridge.nl`)
 * aggregating opdrachten from several brokers/HeadFirst-family sources.
 * Reading `GET /api/jobs?open=true` is public with no auth header observed
 * (see docs/sources/striive.md, probe 2026-08-31). The shape below is
 * recorded directly from a live capture -- the API returns far more raw
 * fields per job than declared here (recruiter PII, zero-valued tariff
 * fields, internal Craft/staffing-system ids); only the whitelisted fields
 * below are ever kept past the connector boundary (see the DEC-008
 * projection in connector.ts).
 *
 * Pagination (confirmed live 2026-08-31): `page` query param, 1-indexed.
 * `page=0` and `page=1` both return the same first page; pages 2..N return
 * distinct subsequent pages of `STRIIVE_PAGE_SIZE` (25) records; a page past
 * the end returns an empty `data` array with `total` unchanged. There is no
 * documented upper bound on `total`, so discover() also treats a short page
 * (`data.length < STRIIVE_PAGE_SIZE`) as the end, without relying solely on
 * `total` arithmetic.
 */
export interface StriiveGeoPoint {
  type: string;
  coordinates: [number, number];
}

/** Whitelisted job fields kept past the connector boundary -- see the
 * `docs/sources/striive.md` field-mapping table. Recruiter/order-contact/
 * requester slots were folded into `contactpersonen` under CTP-610 (owner
 * decision: werkenbij- and platform-contacts are in scope); the raw person
 * slots below stay projection-inputs only and never leave the boundary.
 * The tariff fields below were previously excluded too, but that exclusion
 * was never a DEC-008 (PII) concern -- they are commercial facts, and
 * DEC-008 governs raw-data minimisation for personal data only
 * (docs/IMPLEMENTATION_BACKLOG.md "Definieer raw-data-minimalisatie en
 * retentie"). They were confirmed live to be zero/false across the full
 * 109-record capture at the time (`hasMaxRate: false`, `hourlyRateMin/Max:
 * 0`, `monthlyRateMin/Max: 0`, `rateType: 0`) -- unusable then, not
 * forbidden. Kept whitelisted now (CTP-524, F09) so a future capture with
 * real values is honestly mapped instead of silently dropped.
 */
export interface StriiveJob {
  id: string;
  referenceCode?: string | null;
  referenceCodeClient?: string | null;
  title: string;
  /** HTML fragment; stripped by the normaliser, never stored raw as prose. */
  content?: string | null;
  clientName?: string | null;
  location?: string | null;
  regionLocation?: StriiveGeoPoint | null;
  hoursPerWeekMin?: number | null;
  hoursPerWeekMax?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  /** Deadline for the staffing broker/supplier to submit candidates. */
  closingDateInvoice?: string | null;
  /** Deadline visible to the end client -- the canonical `sluitingsdatum`. */
  closingDateClient?: string | null;
  broker?: string | null;
  source?: string | null;
  /** The API's own public detail-page URL for this job (confirmed live to
   * match the documented `https://striive.com/nl/opdrachten?id=<uuid>`
   * pattern exactly) -- used verbatim as `bronUrl` rather than
   * reconstructing it. */
  brokerUrl?: string | null;
  /** Whether an upper tariff bound is published at all (CTP-524, F09). */
  hasMaxRate?: boolean | null;
  hourlyRateMin?: number | null;
  hourlyRateMax?: number | null;
  monthlyRateMin?: number | null;
  monthlyRateMax?: number | null;
  /** Numeric rate-unit code; meaning unconfirmed (0 observed live, never
   * documented). Kept verbatim in bronSpecifiek, never used to pick an
   * eenheid -- see `resolveTarief` in normalise/striive.ts. */
  rateType?: number | null;
  /** VMS engagement/contract-type field (CTP-524, F06) -- confirmed live
   * 2026-09-16 (`fixtures/connectors/striive/listing-live.json`),
   * `null` across all 25 records of that capture. Kept whitelisted for when a
   * broker publishes it, same honest-future-proofing as the tariff fields. */
  jobType?: string | null;
  /** Structured skills/tags list (CTP-524, F15) -- confirmed live
   * 2026-09-16, `[]` across all 25 records of that capture. Never confirmed
   * non-empty, so entry shape is unverified; `normaliseSkills` drops
   * anything that is not a plain string. */
  tags?: unknown[] | null;
  /** CTP-610: contactpersonen built by the projection from the raw
   * recruiter- and orderContact/requester slots below (confirmed in the live
   * field list, scrubbed from fixtures -- see listing-live.json's note).
   * The raw fields themselves never leave the connector boundary; only
   * this folded list is whitelisted. */
  contactpersonen?: SourceContact[];
  // --- projection inputs only (raw API fields; not emitted by
  // projectStriiveJob, folded into `contactpersonen`) ---
  recruiterFirstName?: string | null;
  recruiterMiddleName?: string | null;
  recruiterLastName?: string | null;
  recruiterFunctionTitle?: string | null;
  recruiterEmail?: string | null;
  recruiterPhoneNumber?: string | null;
  orderContactFullName?: string | null;
  orderContactLegalName?: string | null;
  requesterEmail?: string | null;
}

export interface StriiveListingResponse {
  total: number;
  data: StriiveJob[];
}

export interface StriiveFetchedPayload {
  job: StriiveJob;
}

export const STRIIVE_PARSER_VERSION = "striive/v3" as const;

export const STRIIVE_JOBS_PATH = "/api/jobs";

/** Confirmed live 2026-08-31: 25 records per page, `total: 109` at capture
 * time (109 = 4 full pages of 25 + a final page of 9). */
export const STRIIVE_PAGE_SIZE = 25;

/** Bounded page cap so a stale/misreported `total` can never spin
 * discover() into an unbounded loop against the live site. At capture time
 * this was 5 pages; this leaves ample headroom for growth. */
export const STRIIVE_MAX_PAGES = 40;
