import type { SourceContact } from "../contract";

/**
 * Inhuurdesk (Staffing MS / HeadFirst-family) WP JSON search endpoint,
 * `GET /wp-json/headfirst-assignments/search?page=N` -> `{ total, data[] }`.
 * The shape below is recorded from a live capture on 2026-09-03 (21 records,
 * see fixtures/connectors/inhuurdesk/listing-page-0.json): the raw record
 * carries ~120 fields (recruiter PII slots, worksite/positionRule blocks,
 * internal Salesforce ids), all but the whitelist below are dropped at the
 * connector boundary (DEC-008 projection in connector.ts). The previous
 * `aanvraagnummer`-based type was never a live shape -- every live record
 * was rejected against it (2026-09-03 production test-import: 21/21).
 */
export interface InhuurdeskAssignment {
  /** Platform UUID; the site's own detail URL is keyed on it -- the stable
   * external id (`bronReferentie`). */
  id: string;
  /** Human-facing aanvraagnummer, e.g. `SRQ178204` (equals `recordId`). */
  referenceCode?: string | null;
  title: string;
  /** URL slug segments: `/aanvragen/<clientNameSlug>/<titleSlug>/<id>`
   * (pattern confirmed live 2026-09-03 against the listing page's hrefs). */
  titleSlug?: string | null;
  clientNameSlug?: string | null;
  clientName?: string | null;
  /** HTML fragment; entity-decoded and stripped by the normaliser. */
  content?: string | null;
  location?: string | null;
  hoursPerWeekMin?: number | null;
  hoursPerWeekMax?: number | null;
  /** Naive ISO datetimes (`2026-09-21T00:00:00`, Europe/Amsterdam). */
  startDate?: string | null;
  endDate?: string | null;
  /** Deadline visible to the end client -- the canonical `sluitingsdatum`. */
  closingDateClient?: string | null;
  /** Supplier/broker submission deadline; bronSpecifiek only. */
  closingDateInvoice?: string | null;
  publishedDate?: string | null;
  segmentName?: string | null;
  /** Live 2026-09-03: `false` / `0` on all 21 records. `0` means "no rate
   * published", never a rate of zero -- the normaliser maps only `> 0`. */
  hasMaxRate?: boolean | null;
  hourlyRateMin?: number | null;
  hourlyRateMax?: number | null;
  /** CTP-610: contactpersonen folded by the projection from the raw
   * recruiter/requester slots below (real fields in the ~120-field live
   * record, null/`""` on all 21 capture records -- see
   * fixtures/connectors/inhuurdesk/listing-page-0.json). The raw slots
   * never leave the connector boundary; only this list is whitelisted. */
  contactpersonen?: SourceContact[];
  // --- projection inputs only (raw API fields; folded into
  // `contactpersonen`, never emitted by projectInhuurdeskAssignment) ---
  /** Never confirmed non-null live (null on all 21 capture records).
   * HeadFirst-family sibling Striive carries the person slots flat
   * (recruiterFirstName/...); Inhuurdesk's `recruiter` reads as a nested
   * object, so the projection reads it defensively and ignores
   * non-object values. */
  recruiter?: {
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
    name?: string | null;
    functionTitle?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
  } | null;
  recruiterEmail?: string | null;
  recruiterPhoneNumber?: string | null;
  /** Live 2026-09-03: `""` on all 21 records -- an empty string is "no
   * requester e-mail published", not a value. */
  requesterEmail?: string | null;
}

export interface InhuurdeskListingPage {
  data: InhuurdeskAssignment[];
  total: number;
}

export interface InhuurdeskFetchedPayload {
  assignment: InhuurdeskAssignment;
}

export const INHUURDESK_PARSER_VERSION = "inhuurdesk/v4" as const;

export const INHUURDESK_SEARCH_PATH = "/wp-json/headfirst-assignments/search";
