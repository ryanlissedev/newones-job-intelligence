/** One `/job/<uuid>/` entry discovered from a `pji_job` child sitemap. */
export interface ProunityListingItem {
  /** Sitemap `<lastmod>` for this URL entry (present on every entry today). */
  lastmod?: string;
  url: string;
  uuid: string;
}

/** One `<li>` under a Requirements `<h6>` heading: `<b>name</b> <span class="tag2">status</span>`. */
export interface ProunityRequirementTag {
  naam: string;
  /** e.g. "Confirmed" (roles/skills) or "Active knowledge" (languages). */
  status?: string;
}

/** Typed fields scraped from a `/job/<uuid>/` SSR detail page (`.post-content` inside the pji_job article). */
export interface ProunityDetail {
  /** `platform.pro-unity.com` apply link rendered as "Sign in to apply". */
  applyUrl?: string;
  /** `span.putag` duration badge ("2 months"); absent on historical pages. */
  duur?: string;
  /** Second `.job__infobar` span -- a country name ("Belgium"), positional. */
  land?: string;
  /** First `.job__infobar` span ("12/10/2026 - 31/12/2026"), positional. */
  periode?: string;
  /** `(K10127)` suffix parsed from the title, when present. */
  referentie?: string;
  roles: ProunityRequirementTag[];
  skills: ProunityRequirementTag[];
  talen: ProunityRequirementTag[];
  titel: string;
  uuid: string;
}

/** DEC-008 whitelist: only these fields leave the connector as the stored body. */
export interface ProunityFetchedPayload {
  detail: ProunityDetail;
  listing: ProunityListingItem;
  /** Sanitised `div.richtext` description HTML (scripts/styles stripped). */
  raw: { html: string };
}

export const PROUNITY_PARSER_VERSION = "prounity/v1" as const;

export const PROUNITY_SITEMAP_INDEX_URL =
  "https://www.pro-unity.com/sitemap.xml";

/** Matches `pji_job` child sitemap `<loc>` URLs inside the sitemap index
 * (`pji_job-sitemap.xml` … `pji_job-sitemap5.xml`). */
export const PROUNITY_JOB_SITEMAP_PATTERN =
  /^https:\/\/www\.pro-unity\.com\/pji_job-sitemap\d*\.xml$/u;

/** `/job/<uuid>/` detail URLs inside a `pji_job` child sitemap. */
export const PROUNITY_JOB_URL_PATTERN =
  /^https:\/\/www\.pro-unity\.com\/job\/(?<uuid>[0-9a-f-]{36})\/?$/iu;

/** Child-sitemap fixtures keyed by their exact `<loc>` URL (the index
 * fixture keeps all five children; fixture mode skips children without a
 * fixture, matching the trim-sitemap convention of only recording what has
 * a detail fixture). */
export const PROUNITY_SITEMAP_FIXTURES = {
  "https://www.pro-unity.com/pji_job-sitemap.xml":
    "prounity/sitemap-pji-job.json",
} satisfies Record<string, string>;

/** Detail fixtures keyed by job uuid. Recorded with
 * `bun tools/fixtures/record.ts --source prounity --name detail-<uuid>`. */
export const PROUNITY_DETAIL_FIXTURES = {
  "0e8d62af-0955-4915-86f1-5c4fc2fdf74c":
    "prounity/detail-0e8d62af-0955-4915-86f1-5c4fc2fdf74c.json",
  "2d7d21bd-840e-46e9-b43c-1e00dee5140e":
    "prounity/detail-2d7d21bd-840e-46e9-b43c-1e00dee5140e.json",
  "3469b088-d2f6-45cb-81cd-1b98c9558417":
    "prounity/detail-3469b088-d2f6-45cb-81cd-1b98c9558417.json",
} satisfies Record<string, string>;
