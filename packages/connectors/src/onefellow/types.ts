/** Onefellow (docs/sources/onefellow.md, probe 2026-08-31) exposes an
 * undocumented, private JSON endpoint that returns all open opdrachten in
 * a single call with no pagination -- this is a private API that can
 * change without warning; the documented fallback path is rendering
 * `/opdrachten/<joborder_id>` in a browser and parsing the visible fields
 * plus the post-hydration JobPosting JSON-LD (not built in this PR). Shape
 * below is recorded directly from a live capture (see
 * fixtures/connectors/onefellow/), trimmed to the fields this connector
 * actually reads -- the real response carries ~70 keys per job, including
 * recruiter/sourcer/contact PII this connector never touches. */
export interface OnefellowJob {
  /** Numeric job order id in the live response; kept as-is and stringified
   * for `bronReferentie`/detail-URL construction. */
  joborder_id: number;
  title: string;
  /** HTML-escaped rich text (confirmed live: entities encode both markup
   * and accented characters, e.g. `&lt;p&gt;`, `&eacute;`) -- decode
   * entities before stripping tags, not the other way round. */
  description?: string;
  teaser?: string;
  /** Real eindklant name, not the staffing agency. */
  company?: string;
  company_city?: string;
  address_city?: string;
  /** String range, e.g. "24-28", or a single value, e.g. "32". */
  hours?: string;
  /** Populated on only 7/50 sampled records (2026-08-31 probe) -- numeric
   * string when present. Never treat an empty/absent value as a rate. */
  max_rate?: string;
  /** Free-text tariff/salary line; kept as raw provenance, not parsed into
   * `NormalisedTarief` (unlike `max_rate`, its format is not confirmed
   * consistent across records). */
  salary?: string;
  duration?: string;
  workplace_type?: string;
  status?: string;
  /** Unix seconds. */
  start_date?: number;
  time_deadline?: number;
  time_published?: number;
  time_updated?: number;
}

export interface OnefellowListingResponse {
  jobs: OnefellowJob[];
}

export interface OnefellowFetchedPayload {
  job: OnefellowJob;
}

export const ONEFELLOW_PARSER_VERSION = "onefellow/v3" as const;

export const ONEFELLOW_LISTING_URL =
  "https://yhjktxqtoyeruztiwupf.supabase.co/functions/v1/olli-jobs?action=list";

export const onefellowBronReferentie = (job: { joborder_id: number }): string =>
  String(job.joborder_id);

export const onefellowDetailUrl = (job: { joborder_id: number }): string =>
  `https://onefellow.nl/opdrachten/${job.joborder_id}`;
