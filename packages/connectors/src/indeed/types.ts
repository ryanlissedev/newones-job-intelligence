/**
 * Indeed NL (`nl.indeed.com`) public search-page shapes, derived from a real
 * headed-Chrome capture on 2026-09-18 (fixtures/connectors/indeed/, see
 * docs/sources/indeed.md):
 *
 * - `GET /jobs?q=<q>&l=Nederland&start=<n>` serves a server-rendered SERP
 *   that embeds `window.mosaic.providerData["mosaic-provider-jobcards"]`
 *   (job cards) and `window._initialData` (pageLinks / totalNumResults /
 *   `autoOpenTwoPaneViewjobResponse` — a full viewjob payload for the
 *   auto-opened card).
 * - `GET /viewjob?jk=<jobkey>` is login-gated even in a real browser
 *   (`from=bot-detection-anonymous` → secure.indeed.com), so the detail
 *   record is read from the SERP's embedded viewjob body instead. When the
 *   viewjob route ever serves anonymous HTML again it carries a JobPosting
 *   `application/ld+json` node — `parseIndeedJobPosting` in extract.ts is
 *   ready for it but unverified against a live page (no capture exists).
 *
 * Plain curl/Bun fetch from this environment gets Cloudflare (403 managed
 * challenge on /jobs, 401 "Authenticating..." on /viewjob); the capture
 * below is what a real Chrome on a NL IP received.
 */
export const INDEED_PARSER_VERSION = "indeed/v1" as const;

/** Result cards per SERP page on the 2026-09-18 capture (15 observed,
 * sponsored + organic mixed). Pagination itself follows `pageLinks`
 * (`start` stride 10 upstream), not this count. */
export const INDEED_OBSERVED_PAGE_RESULTS = 15;

export interface IndeedSalarySnippet {
  currency: string | null;
  source: string | null;
  text: string | null;
}

export interface IndeedExtractedSalary {
  max: number | null;
  min: number | null;
  /** Upstream period label, e.g. "MONTHLY" | "YEARLY" | "HOURLY". */
  type: string | null;
}

export interface IndeedRemoteWorkModel {
  text: string | null;
  /** e.g. "REMOTE_HYBRID" | "REMOTE_FULLY". */
  type: string | null;
}

export interface IndeedSalaryInfoModel {
  salaryCurrency: string | null;
  salaryMax: number | null;
  salaryMin: number | null;
  salarySource: string | null;
  salaryText: string | null;
  salaryType: string | null;
}

/** DEC-008 whitelist of one `mosaicProviderJobCardsModel.results[]` entry —
 * the raw card carries ~100 fields (tracking urls, encrypted ids, ranking
 * scores, resume/match models); only the named fields below ever reach
 * `listingPayload` or the stored body. */
export interface IndeedJobCard {
  jobkey: string;
  title: string | null;
  displayTitle: string | null;
  normTitle: string | null;
  company: string | null;
  truncatedCompany: string | null;
  formattedLocation: string | null;
  jobLocationCity: string | null;
  jobLocationState: string | null;
  country: string | null;
  jobTypes: string[];
  remoteWorkModel: IndeedRemoteWorkModel | null;
  salarySnippet: IndeedSalarySnippet | null;
  extractedSalary: IndeedExtractedSalary | null;
  /** Publish timestamp, epoch ms upstream. */
  pubDate: number | null;
  createDate: number | null;
  /** NL relative label, e.g. "30+ dagen geleden". */
  formattedRelativeTime: string | null;
  /** HTML snippet of the description as shown on the SERP. */
  snippet: string | null;
  /** Relative canonical job URL (`/viewjob?jk=…&<tracking>`). */
  viewJobLink: string | null;
  sponsored: boolean;
  /** Source-side "this posting expired" flag. */
  expired: boolean;
  urgentlyHiring: boolean;
  newJob: boolean;
  companyRating: number | null;
  companyReviewCount: number | null;
  /** Requirement/tag labels from `jobCardRequirementsModel` (e.g. "Bachelor",
   * "Nederlands") — display labels only, ids dropped. */
  requirementLabels: string[];
  /** `hiringMultipleCandidatesModel.hiresNeededExact`, when published. */
  hiresNeededExact: string | null;
  indeedApplyable: boolean;
  redirectToThirdPartySite: boolean;
}

export interface IndeedPageLink {
  href: string | null;
  label: number | null;
}

/** What the connector needs out of a parsed SERP page. */
export interface IndeedSearchPage {
  cards: IndeedJobCard[];
  pageNum: number | null;
  pageLinks: IndeedPageLink[];
  totalNumResults: number | null;
}

/** DEC-008 whitelist of `_initialData.autoOpenTwoPaneViewjobResponse.body` —
 * the embedded viewjob payload carries ~160 fields (account/session models,
 * tracking, promos); only the named fields leave the connector. */
export interface IndeedViewJob {
  jobKey: string | null;
  jobTitle: string | null;
  jobLocation: string | null;
  jobLanguage: string | null;
  jobOccupations: string[];
  companyName: string | null;
  formattedLocation: string | null;
  remoteWorkModel: IndeedRemoteWorkModel | null;
  salaryInfoModel: IndeedSalaryInfoModel | null;
  /** Full job description, sanitised HTML as embedded by Indeed. */
  sanitizedJobDescription: string | null;
  /** Relative-age label from `jobMetadataFooterModel`, e.g. "30+ dagen geleden". */
  age: string | null;
  advertiserName: string | null;
}

/** Serialised observation body: listing card + the embedded viewjob
 * payload. `card` is null only when a caller fetched by bare jobkey without
 * the discover-time listing payload. */
export interface IndeedFetchedPayload {
  card: IndeedJobCard | null;
  detail: IndeedViewJob;
  jobkey: string;
}
