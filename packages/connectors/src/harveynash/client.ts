/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- This is the Harvey Nash SSR detail-page I/O boundary: the JobPosting JSON-LD block is arbitrary external JSON with no declared shape, so a runtime typeof check is how the field contract gets established here (mirrors packages/connectors/src/tenderned/ids.ts). */
import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { extractJobPosting } from "../json-ld/extract";
import type {
  HarveyNashDetailFacts,
  HarveyNashDetailFragment,
  HarveyNashSearchResponse,
} from "./types";
import { HARVEYNASH_PAGE_SIZE, HARVEYNASH_SEARCH_PATH } from "./types";

export interface HarveyNashClient {
  fetchListing: (page: number) => Promise<HarveyNashSearchResponse>;
  /** `detailUrl` is only used live; fixture runs key off `jobId`. */
  fetchDetail: (
    jobId: string,
    detailUrl: string
  ) => Promise<HarveyNashDetailFragment>;
}

export interface HarveyNashClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  /** jobId -> fixture path for the raw SSR detail HTML. */
  detailFixtures?: Record<string, string>;
  liveEnabled?: boolean;
}

const DEFAULT_BASE_URL = "https://www.harveynash.nl";

const decodeEntities = (text: string): string =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&euro;", "€")
    .replaceAll("&#8217;", "’");

const cleanText = (raw: string): string =>
  decodeEntities(raw.replaceAll(/<[^>]+>/gu, " "))
    .replaceAll(/\s+/gu, " ")
    .trim();

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The detail page's visible "post-info-title"/"post-info-content" pairs
 * (confirmed live: "Locatie:", "Salaris:", "Job Ref:"). Tolerant of
 * whitespace/newlines between the two divs, extra classes on either div
 * (`class="[^"]*post-info-title[^"]*"`, not an exact-match class), and other
 * attributes on either tag -- the real page is compact with no whitespace
 * between tags, but a future SourceFlow template revision could reformat or
 * add classes without changing these two marker strings. */
const POST_INFO_PAIR =
  /<div[^>]*\bclass="[^"]*post-info-title[^"]*"[^>]*>(?<label>[^<]*)<\/div>\s*<div[^>]*\bclass="[^"]*post-info-content[^"]*"[^>]*>(?<value>[\s\S]*?)<\/div>/giu;

interface HarveyNashPostInfo {
  locatie?: string;
  salaris?: string;
  "job ref"?: string;
}

const extractPostInfo = (html: string): HarveyNashPostInfo => {
  const facts: HarveyNashPostInfo = {};
  for (const match of html.matchAll(POST_INFO_PAIR)) {
    const label = cleanText(match.groups?.label ?? "")
      .toLowerCase()
      .replace(/:$/u, "");
    const value = cleanText(match.groups?.value ?? "");
    if (!(label && value)) {
      continue;
    }
    if (label === "locatie" || label === "salaris" || label === "job ref") {
      facts[label] = value;
    }
  }
  return facts;
};

/** Labels observed inside the JobPosting JSON-LD `description` field's
 * `<p>` paragraphs vary a lot across postings (weekday prefixes, "Verwachte"
 * vs "Gewenste" startdatum, "Uren:" vs "Aantal uren per week:") -- matched
 * by keyword, not exact text. Best-effort: a posting that phrases a field
 * differently, or omits it, simply leaves that key undefined. */
const classifyDescriptionLabel = (
  label: string
): "deadline" | "start" | "uren" | undefined => {
  const lower = label.toLowerCase();
  if (lower.includes("deadline")) {
    return "deadline";
  }
  if (lower.includes("uren")) {
    return "uren";
  }
  if (lower.includes("startdatum") || lower === "start") {
    return "start";
  }
  return undefined;
};

const DESCRIPTION_PARAGRAPH = /<p[^>]*>(?<body>[\s\S]*?)<\/p>/giu;

const extractDescriptionFacts = (
  descriptionHtml: string
): Pick<HarveyNashDetailFacts, "deadline" | "start" | "uren"> => {
  const facts: Pick<HarveyNashDetailFacts, "deadline" | "start" | "uren"> = {};
  for (const match of descriptionHtml.matchAll(DESCRIPTION_PARAGRAPH)) {
    const text = cleanText(match.groups?.body ?? "");
    const separatorIndex = text.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = classifyDescriptionLabel(text.slice(0, separatorIndex));
    const value = text.slice(separatorIndex + 1).trim();
    if (key && value && !facts[key]) {
      facts[key] = value;
    }
  }
  return facts;
};

export const parseHarveyNashDetailHtml = (
  html: string
): HarveyNashDetailFragment => {
  const jobPosting = extractJobPosting(html);
  const description = jobPosting
    ? asOptionalString(jobPosting.description)
    : undefined;
  const postInfo = extractPostInfo(html);
  const descriptionFacts = description
    ? extractDescriptionFacts(description)
    : {};

  return {
    facts: {
      ...descriptionFacts,
      jobRef: postInfo["job ref"],
      locatie: postInfo.locatie,
      richttarief: postInfo.salaris,
    },
    jsonLd: jobPosting
      ? {
          datePosted: asOptionalString(jobPosting.datePosted),
          description,
          title: asOptionalString(jobPosting.title),
          validThrough: asOptionalString(jobPosting.validThrough),
        }
      : {},
  };
};

const readOk = (response: Response, label: string): Response => {
  if (!response.ok) {
    throw new Error(
      `Harvey Nash ${label} request failed with status ${response.status}`
    );
  }
  return response;
};

export const createHarveyNashClient = (
  options: HarveyNashClientOptions = {}
): HarveyNashClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("harveynash");
  const liveEnabled =
    options.liveEnabled ?? process.env.HARVEYNASH_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "harveynash/listing-page-0.json";
  const detailFixtures = options.detailFixtures ?? {
    "452d25a3-ae7d-4ee6-9ceb-3c696332799f":
      "harveynash/detail-endpoints-specialist.json",
  };
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  return {
    fetchDetail: async (jobId, detailUrl) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[jobId];
        if (!relativePath) {
          throw new Error(`Missing Harvey Nash detail fixture for ${jobId}`);
        }
        const fixture = await loadConnectorFixture<string>(relativePath);
        return parseHarveyNashDetailHtml(fixture.payload);
      }
      const response = readOk(await fetchImpl(detailUrl), "detail");
      return parseHarveyNashDetailHtml(await response.text());
    },
    fetchListing: async (page) => {
      if (!liveEnabled) {
        if (page > 0) {
          return { results: [], total_size: 1 };
        }
        const fixture =
          await loadConnectorFixture<HarveyNashSearchResponse>(
            listingFixturePath
          );
        return fixture.payload;
      }
      // Live capture 2026-08-31: a flat body 400s with "A required parameter
      // is missing - job_search" -- the endpoint requires this wrapper.
      const response = readOk(
        await fetchImpl(`${baseUrl}${HARVEYNASH_SEARCH_PATH}`, {
          body: JSON.stringify({
            job_search: {
              jobs_per_page: HARVEYNASH_PAGE_SIZE,
              offset: page * HARVEYNASH_PAGE_SIZE,
            },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        "search"
      );
      return (await response.json()) as HarveyNashSearchResponse;
    },
  };
};

export const resolveHarveyNashDetailUrl = (
  urlSlug?: string,
  baseUrl = DEFAULT_BASE_URL
): string | undefined => {
  if (!urlSlug) {
    return undefined;
  }
  try {
    return new URL(`/vacatures/${urlSlug}`, baseUrl).toString();
  } catch {
    return undefined;
  }
};

export const harveyNashBronReferentie = (item: {
  id?: string;
  external_reference?: string;
}): string => {
  if (item.id?.trim()) {
    return item.id;
  }
  return item.external_reference?.trim() ?? "";
};

export const harveyNashEindklant = (item: {
  categories?: { name?: string; values?: { name?: string }[] }[];
}): string | undefined =>
  item.categories?.find((category) => category.name === "Clients")?.values?.[0]
    ?.name;
