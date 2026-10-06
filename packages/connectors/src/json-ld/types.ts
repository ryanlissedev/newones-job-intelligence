import type { SourceContact } from "../contract";

export type JsonLdPrimitive = boolean | null | number | string;

export type JsonLdValue =
  | JsonLdPrimitive
  | JsonLdValue[]
  | { [key: string]: JsonLdValue };

/** A single parsed `<script type="application/ld+json">` node (e.g. a JobPosting). */
export type JsonLdNode = Record<string, JsonLdValue>;

/** One discovered detail-page URL, from a sitemap `<url>` entry or a listing-page link. */
export interface JsonLdDiscoveryUrl {
  lastmod?: string;
  url: string;
}

export interface JsonLdListingPaginationConfig {
  maxPages?: number;
  pageParam: string;
  pagePointer: string;
  pageSizeParam: string;
  pageSizePointer: string;
  totalPointer: string;
}

export type JsonLdDiscoveryConfig =
  | { kind: "sitemap"; url: string }
  | { kind: "listing"; linkPattern: RegExp; url: string }
  | {
      kind: "json-listing";
      linkPattern: RegExp;
      pagination?: JsonLdListingPaginationConfig;
      url: string;
      urlPointer: string;
    }
  | {
      kind: "sitemap-index";
      /**
       * CTP-624: bound on discovery items per `discover()` page, so the run
       * loop's per-page checkpoint holds real progress and an abort or
       * durable retry resumes mid-corpus instead of re-enumerating it.
       * Absent means the whole selected corpus is emitted in one page
       * (`hasMore: false`), the pre-CTP-624 behaviour every other source
       * keeps.
       */
      batchSize?: number;
      /** Matches child `<sitemap><loc>` URLs to follow; must expose a named `chunk` group with the numeric chunk suffix. */
      childPattern: RegExp;
      /** Keep only the N children with the highest numeric `chunk` (depth 1, no recursion). */
      newest: number;
      url: string;
    };

/** A label-block field: a regex with a named `value` capture group, applied either
 * against the raw detail HTML (`"html"`, the default) or the JobPosting's own
 * `description` text (`"description"`, for sources that embed the label table
 * inside the JSON-LD description rather than in surrounding markup). */
export interface JsonLdLabelBlockField {
  pattern: RegExp;
  source?: "description" | "html";
}

/** CTP-610: re-exported from the connector contract -- contactpersonen are a
 * cross-family shape (json-ld synthesizers, CTM Atom, …), not a json-ld-only
 * concept. */
export type { SourceContact } from "../contract";

/** A JobPosting (+label-block fields) rebuilt from non-JSON-LD detail data —
 * framework state (`__NEXT_DATA__`, `vike_pageContext`), embedded payloads, or
 * a JSON API body — by a source's `detailSynthesizer`. A synthesizer may also
 * return only `contactpersonen` (e.g. a recruiter block outside the JSON-LD
 * node) with `jobPosting: null`, and it runs on every detail body so those
 * contacts are extracted even when an explicit JobPosting exists. */
export interface DetailSynthesis {
  contactpersonen?: SourceContact[];
  jobPosting: JsonLdNode | null;
  labelBlock: Record<string, string>;
}

export interface JsonLdConnectorConfig {
  /** Absolute base URL relative hrefs are resolved against for `discovery.kind === "listing"`. */
  detailBaseUrl?: string;
  /** Fixture path per discovered detail URL, keyed by the exact URL string. */
  detailFixtures?: Record<string, string>;
  /** Rewrites the discovered detail URL for the live fetch only (e.g. Alliander's
   * public `/vacatures/<slug>/jr<id>` page is client-rendered; the same record is
   * served at `/api/vacancy/JR<id>`). The observation keeps the public URL. */
  detailUrlRewrite?: { pattern: RegExp; replace: string };
  discovery: JsonLdDiscoveryConfig;
  /** URLs matching any of these are dropped from discovery (facet/order/pagination links). */
  excludePatterns?: RegExp[];
  /** Opt-in synthesis for detail bodies that carry JobPosting data outside
   * `ld+json` (Next.js `__NEXT_DATA__`, Vike `vike_pageContext`, a JSON API
   * record, or embedded page state). Its `jobPosting` is used only when no
   * explicit JobPosting node exists; it runs on every detail body so a
   * synthesizer may also surface `contactpersonen` alongside explicit
   * JSON-LD. */
  detailSynthesizer?: (body: string, url: string) => DetailSynthesis | null;
  labelBlock?: Record<string, JsonLdLabelBlockField>;
  /**
   * Opt-in for a source whose sitemap lists detail pages that fail with HTTP
   * 5xx. The first `attempts - 1` 5xx answers for a URL are rethrown, so the
   * runner's retry policy repeats the fetch behind the crawl-delay limiter
   * with its backoff (it must allow at least `attempts` tries). A page that
   * still answers 5xx on attempt `attempts` is rejected, so it stays observed
   * and is never staled, instead of failing the whole run. More than
   * `maxRejectedPerRun` such pages in one run is treated as an upstream outage
   * and fails the run as before.
   */
  detailServerErrorPolicy?: {
    attempts: number;
    maxRejectedPerRun: number;
  };
  /** Fixture path for the sitemap/listing page when not running live. */
  listingFixturePath?: string;
  /** Fixture path per child sitemap URL (sitemap-index only), keyed by exact URL. */
  sitemapFixtures?: Record<string, string>;
  /** Env var name gating live HTTP vs. fixtures for this source's own client instance. */
  liveEnvVar?: string;
  parserVersion: string;
  slug: string;
}

/** Fetched detail-page payload, stored as the connector's raw JSON observation body. */
export interface JsonLdFetchedPayload {
  /** CTP-610: contactpersonen the source published on this detail (synthesizer
   * output or, in normalise, `hiringOrganization.contactPoint`). Absent/empty
   * for sources without contact fields. */
  contactpersonen?: SourceContact[];
  jobPosting: JsonLdNode;
  labelBlock: Record<string, string>;
  parserVersion: string;
  slug: string;
  url: string;
}
