/** Harvey Nash NL is a Next.js/Staffing Future (Bullhorn) site. Its listing is
 * a client-side call to an undocumented search endpoint; the shapes below are
 * recorded directly from a live capture (see fixtures/connectors/harveynash/
 * and docs/research/source-probes-2026-08-31.md on origin/main), not
 * reconstructed. It is a private, undocumented API that can change without
 * warning -- the documented fallback path is sitemap discovery plus detail-
 * page JSON-LD/SSR parsing, which `client.fetchDetail` relies on. */
export interface HarveyNashCategoryValue {
  name?: string;
}

export interface HarveyNashCategory {
  name?: string;
  values?: HarveyNashCategoryValue[];
}

export interface HarveyNashSearchItem {
  /** Bullhorn job id (a UUID in practice). Primary `bronReferentie` source. */
  id: string;
  title: string;
  /** e.g. "Zwolle , Overijssel". First entry is used for locatie. */
  addresses?: string[];
  /** e.g. "BBBH121494_1788161094" -- the BBBH reference plus a timestamp
   * suffix, kept verbatim. Fallback `bronReferentie` when `id` is absent, and
   * always kept in `bronSpecifiek` for cross-source dedup (reference codes
   * are the cross-source dedup key per the probe). */
  external_reference?: string;
  /** Site-relative slug for the SSR detail page: `/vacatures/<url_slug>`. */
  url_slug?: string;
  /** Free-text tarief line, e.g. "Max tarief 106.50 euro all-in exclusief
   * btw" or "Bespreekbaar" / "Tarief in overleg". The listing also carries
   * `salary_low`/`salary_high`, but those are always 0 in practice -- this
   * free-text field is the real tarief source, same text the detail page's
   * "Salaris:" field shows. */
  salary_package?: string;
  /** Unix seconds. Used as the deterministic "observation date" for the
   * deadline year-inference rule (see normalise/harveynash.ts) instead of
   * wall-clock time, so replaying an identical fixture twice is idempotent. */
  published_at?: number;
  expires_at?: number;
  updated_at?: number;
  /** Category "Clients" holds the real eindklant name (e.g. "Politie"); not
   * every job has one. Category "Consultants" holds the recruiter's name --
   * deliberately not modelled here, it is PII we never carry through. */
  categories?: HarveyNashCategory[];
}

export interface HarveyNashSearchResult {
  job: HarveyNashSearchItem;
}

export interface HarveyNashSearchResponse {
  total_size: number;
  results: HarveyNashSearchResult[];
}

/** Labelled key:value facts scraped from the SSR detail page. `locatie`,
 * `richttarief` and `jobRef` come from the page's visible
 * "post-info-title"/"post-info-content" block; `deadline`/`uren`/`start`
 * come from labelled paragraphs inside the JobPosting JSON-LD's own
 * `description` field (the same text is also SSR-rendered on the page).
 * Real labels vary a lot across postings ("Verwachte startdatum" vs
 * "Gewenste startdatum" vs "Start", "Aantal uren per week" vs "Uren", with
 * or without a weekday prefix on the deadline) -- these are matched by
 * keyword, not exact label text, and are best-effort: a posting that never
 * mentions a field simply leaves it undefined. */
export interface HarveyNashDetailFacts {
  locatie?: string;
  richttarief?: string;
  jobRef?: string;
  deadline?: string;
  uren?: string;
  start?: string;
}

/** The parts of the JobPosting JSON-LD block worth keeping. `baseSalary` is
 * deliberately excluded: confirmed on a live detail page to be junk
 * (currency GBP, unitText "YEAR", value a copy of the free-text tarief line)
 * -- the "Salaris:" / "Richttarief" field is the real tarief source. */
export interface HarveyNashJsonLd {
  /** Full source HTML description; retained for canonical beschrijving. */
  description?: string;
  title?: string;
  datePosted?: string;
  validThrough?: string;
}

/** Fragment client.fetchDetail extracts from the SSR detail HTML, before the
 * connector merges in listing-derived fields (id/reference/title/url/
 * eindklant/publishedAt) to build the full HarveyNashDetail payload. */
export interface HarveyNashDetailFragment {
  facts: HarveyNashDetailFacts;
  jsonLd: HarveyNashJsonLd;
}

export interface HarveyNashDetail {
  jobId: string;
  reference: string;
  title: string;
  url: string;
  /** From the listing's "Clients" category; undefined when the posting has
   * none (confirmed on a real posting -- not every job carries one). */
  eindklant?: string;
  /** Unix seconds, from the listing. */
  publishedAt?: number;
  facts: HarveyNashDetailFacts;
  jsonLd: HarveyNashJsonLd;
}

export interface HarveyNashFetchedPayload {
  detail: HarveyNashDetail;
}

export const HARVEYNASH_PARSER_VERSION = "harveynash/v3" as const;

/** Undocumented Staffing Future/Bullhorn search endpoint. Live capture
 * 2026-08-31 required a `job_search` wrapper object with `offset` and
 * `jobs_per_page`; a flat body 400s with "A required parameter is missing -
 * job_search". 15 results per page, `total_size: 31` at capture time. */
export const HARVEYNASH_SEARCH_PATH = "/_sf/api/v1/jobs/search.json";
export const HARVEYNASH_PAGE_SIZE = 15;
