/**
 * LinkedIn Jobs public guest routes (CTP-549, POC).
 *
 * Discovery rides the guest listing fragment
 * `/jobs-guest/jobs/api/seeMoreJobPostings/search` (HTML `base-card` blocks),
 * details come from the public `/jobs/view/<slug>-<jobId>` page. That page
 * usually embeds a JobPosting `ld+json` node — but not deterministically:
 * two of three recordings on 2026-09-18 served the same markup without it.
 * `parseLinkedinDetail` therefore synthesises the JobPosting from the
 * topcard/criteria/description markup whenever the explicit node is absent.
 */

export interface LinkedinListingItem {
  /** `jobs/view/<slug>-<jobId>` — derived from the canonical public URL. */
  bronReferentie: string;
  /** Numeric `urn:li:jobPosting:<id>` id from the card's `data-entity-urn`. */
  jobId: string;
  /** Public job URL with LinkedIn's tracking query params stripped. */
  url: string;
  titel: string;
  opdrachtgever?: string;
  locatie?: string;
  /** `job-search-card__listdate` `datetime` attribute (YYYY-MM-DD), when present. */
  geplaatst?: string;
}

export interface LinkedinListingPage {
  items: LinkedinListingItem[];
}

/** Criterion labels LinkedIn publishes in `description__job-criteria-item`
 * blocks, in the two locales seen on live captures (English on
 * www.linkedin.com, Dutch on nl.linkedin.com). */
export const LINKEDIN_CRITERIA_LABELS = new Map<string, string>([
  ["seniority level", "seniority_level"],
  ["senioriteitsniveau", "seniority_level"],
  ["employment type", "employment_type"],
  ["soort baan", "employment_type"],
  ["job function", "job_function"],
  ["functie", "job_function"],
  ["industries", "industries"],
  ["bedrijfstakken", "industries"],
]);

export const LINKEDIN_PARSER_VERSION = "linkedin/v1" as const;
export const LINKEDIN_SLUG = "linkedin" as const;
export const LINKEDIN_LISTING_PATH =
  "/jobs-guest/jobs/api/seeMoreJobPostings/search";
export const LINKEDIN_SEARCH_KEYWORDS = "freelance";
export const LINKEDIN_SEARCH_LOCATION = "Netherlands";
/** Cards per listing fragment observed on live captures (2026-09-18). */
export const LINKEDIN_PAGE_SIZE = 10;
/** POC bound: one run walks at most this many listing pages (~50 jobs). */
export const LINKEDIN_MAX_LISTING_PAGES = 5;
export const LINKEDIN_LIVE_ENV = "LINKEDIN_LIVE";
