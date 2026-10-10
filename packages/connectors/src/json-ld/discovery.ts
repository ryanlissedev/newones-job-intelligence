/* oxlint-disable anti-slop/no-runtime-typeof -- JSON listing traversal narrows JSON.parse output at this I/O boundary. */
import { decodeHtmlEntities } from "../html-entities";
import { extractJobPosting, extractLabelBlock } from "./extract";
import type {
  DetailSynthesis,
  JsonLdConnectorConfig,
  JsonLdDiscoveryUrl,
  JsonLdListingPaginationConfig,
  JsonLdNode,
  SourceContact,
} from "./types";

export interface JsonLdDetailPayload {
  contactpersonen?: SourceContact[];
  jobPosting: JsonLdNode | null;
  labelBlock: Record<string, string>;
  url: string;
}

const SITEMAP_URL_BLOCK_PATTERN = /<url>(?<block>[\s\S]*?)<\/url>/giu;
const SITEMAP_ENTRY_BLOCK_PATTERN = /<sitemap>(?<block>[\s\S]*?)<\/sitemap>/giu;
const SITEMAP_LOC_PATTERN = /<loc>(?<loc>[\s\S]*?)<\/loc>/u;
const SITEMAP_LASTMOD_PATTERN = /<lastmod>(?<lastmod>[\s\S]*?)<\/lastmod>/u;
const HREF_PATTERN = /href=["'](?<href>[^"']+)["']/giu;

const decodeXmlEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

/** Parses a sitemap.xml document's `<url>` entries into discovery rows. */
export const extractSitemapUrls = (xml: string): JsonLdDiscoveryUrl[] => {
  const urls: JsonLdDiscoveryUrl[] = [];
  SITEMAP_URL_BLOCK_PATTERN.lastIndex = 0;
  let match = SITEMAP_URL_BLOCK_PATTERN.exec(xml);
  while (match) {
    const block = match.groups?.block ?? "";
    const loc = SITEMAP_LOC_PATTERN.exec(block)?.groups?.loc?.trim();
    if (loc) {
      const lastmod =
        SITEMAP_LASTMOD_PATTERN.exec(block)?.groups?.lastmod?.trim();
      urls.push(
        lastmod
          ? { lastmod, url: decodeXmlEntities(loc) }
          : { url: decodeXmlEntities(loc) }
      );
    }
    match = SITEMAP_URL_BLOCK_PATTERN.exec(xml);
  }
  return urls;
};

/** Selects newest sitemap chunks by numeric chunk number, not `<lastmod>`. */
export const selectSitemapIndexChildren = (
  xml: string,
  childPattern: RegExp,
  newest: number
): string[] => {
  const children: { chunk: number; url: string }[] = [];
  SITEMAP_ENTRY_BLOCK_PATTERN.lastIndex = 0;
  let match = SITEMAP_ENTRY_BLOCK_PATTERN.exec(xml);
  while (match) {
    const block = match.groups?.block ?? "";
    const loc = SITEMAP_LOC_PATTERN.exec(block)?.groups?.loc?.trim();
    if (loc) {
      const url = decodeXmlEntities(loc);
      childPattern.lastIndex = 0;
      const childMatch = childPattern.exec(url);
      const chunk = Number(childMatch?.groups?.chunk);
      if (childMatch && Number.isFinite(chunk)) {
        children.push({ chunk, url });
      }
    }
    match = SITEMAP_ENTRY_BLOCK_PATTERN.exec(xml);
  }
  return children
    .toSorted((left, right) => right.chunk - left.chunk)
    .slice(0, newest)
    .map(({ url }) => url);
};

/** Extracts detail-page links from a listing HTML page, resolving every href against
 * `baseUrl` first (so both relative and absolute hrefs are handled identically) and
 * then matching `linkPattern` against the resolved URL's pathname -- Hero.eu's own
 * listing renders only relative hrefs today, but resolving before matching means an
 * absolute href would be discovered the same way, not silently dropped. Results are
 * deduplicated by absolute URL. */
export const extractListingLinks = (
  html: string,
  linkPattern: RegExp,
  baseUrl: string
): JsonLdDiscoveryUrl[] => {
  const seen = new Set<string>();
  const urls: JsonLdDiscoveryUrl[] = [];
  HREF_PATTERN.lastIndex = 0;
  let match = HREF_PATTERN.exec(html);
  while (match) {
    const href = match.groups?.href;
    if (href) {
      const resolved = new URL(decodeHtmlEntities(href), baseUrl);
      linkPattern.lastIndex = 0;
      const absolute = resolved.toString();
      if (linkPattern.test(resolved.pathname) && !seen.has(absolute)) {
        seen.add(absolute);
        urls.push({ url: absolute });
      }
    }
    match = HREF_PATTERN.exec(html);
  }
  return urls;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- JSON.parse returns unknown; this narrows the JSON listing traversal boundary.
const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// oxlint-disable-next-line anti-slop/no-unknown-returns -- JSON.parse is validated by pointer traversal before use.
const parseJsonListing = (raw: string, baseUrl: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON listing response at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- pointer traversal accepts the parsed JSON boundary value.
const resolveJsonListingPointer = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- parsed JSON is validated by the caller's I/O boundary.
  parsed: unknown,
  urlPointer: string
): unknown[] => {
  const segments = urlPointer.split(".");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new Error(`JSON listing pointer "${urlPointer}" is empty or invalid`);
  }

  let values: unknown[] = [parsed];
  for (const segment of segments) {
    const isArrayPointer = segment.endsWith("[]");
    const key = isArrayPointer ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    let matched = false;
    for (const value of values) {
      if (!isJsonObject(value) || !(key in value)) {
        continue;
      }
      matched = true;
      const child = value[key];
      if (isArrayPointer) {
        if (!Array.isArray(child)) {
          throw new TypeError(
            `JSON listing pointer "${urlPointer}" expected "${key}" to be an array`
          );
        }
        next.push(...child);
      } else {
        next.push(child);
      }
    }
    if (!matched) {
      throw new Error(
        `JSON listing pointer "${urlPointer}" did not resolve at "${segment}"`
      );
    }
    if (next.length === 0) {
      return [];
    }
    values = next;
  }
  return values;
};

/** Extracts detail URLs from a JSON listing pointer, resolving and deduplicating absolute URLs. */
export const extractJsonListingUrls = (
  raw: string,
  urlPointer: string,
  linkPattern: RegExp,
  baseUrl: string
): JsonLdDiscoveryUrl[] => {
  const parsed = parseJsonListing(raw, baseUrl);
  const values = resolveJsonListingPointer(parsed, urlPointer);

  const seen = new Set<string>();
  const urls: JsonLdDiscoveryUrl[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const resolved = new URL(value, baseUrl);
    linkPattern.lastIndex = 0;
    const absolute = resolved.toString();
    if (linkPattern.test(resolved.pathname) && !seen.has(absolute)) {
      seen.add(absolute);
      urls.push({ url: absolute });
    }
  }
  return urls;
};

export interface JsonListingPagination {
  page: number;
  pageSize: number;
  total: number;
}

export const validateJsonListingPagination = (
  pagination: JsonListingPagination,
  config: JsonLdListingPaginationConfig,
  baseUrl: string
): JsonListingPagination & { pageCount: number } => {
  const { page, pageSize, total } = pagination;
  if (
    !Number.isInteger(page) ||
    !Number.isInteger(pageSize) ||
    !Number.isInteger(total) ||
    page < 1 ||
    pageSize < 1 ||
    total < 0
  ) {
    throw new Error(
      `JSON listing pagination at ${baseUrl} has invalid page, page size, or total`
    );
  }
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (page !== 1 || page > pageCount) {
    throw new Error(
      `JSON listing pagination at ${baseUrl} must start at page 1 and stay within ${pageCount} pages`
    );
  }
  const maxPages = config.maxPages ?? 100;
  if (pageCount > maxPages) {
    throw new Error(
      `JSON listing pagination at ${baseUrl} requires ${pageCount} pages, exceeding the limit of ${maxPages}`
    );
  }
  return { ...pagination, pageCount };
};

export const extractJsonListingPagination = (
  raw: string,
  pagination: JsonLdListingPaginationConfig,
  baseUrl: string
): JsonListingPagination => {
  const parsed = parseJsonListing(raw, baseUrl);
  const readNumber = (pointer: string): number => {
    const values = resolveJsonListingPointer(parsed, pointer);
    const [value] = values;
    if (
      values.length !== 1 ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      throw new Error(
        `JSON listing pointer "${pointer}" at ${baseUrl} did not resolve to one finite number`
      );
    }
    return value;
  };
  return {
    page: readNumber(pagination.pagePointer),
    pageSize: readNumber(pagination.pageSizePointer),
    total: readNumber(pagination.totalPointer),
  };
};

/** Drops discovery rows whose URL matches any of the source's exclude patterns. */
export const applyExcludes = (
  urls: JsonLdDiscoveryUrl[],
  excludePatterns: RegExp[] | undefined
): JsonLdDiscoveryUrl[] => {
  if (!excludePatterns || excludePatterns.length === 0) {
    return urls;
  }
  return urls.filter(
    (entry) =>
      !excludePatterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(entry.url);
      })
  );
};

/** Deduplicates discovery rows by URL, keeping the first occurrence. */
export const dedupeUrls = (
  urls: readonly JsonLdDiscoveryUrl[]
): JsonLdDiscoveryUrl[] => {
  const seen = new Set<string>();
  return urls.filter((entry) => {
    if (seen.has(entry.url)) {
      return false;
    }
    seen.add(entry.url);
    return true;
  });
};

/** Parses a single-document listing source (sitemap, HTML listing, JSON listing) into
 * discovery rows with the source's exclude patterns applied. `sitemap-index` sources
 * are multi-document and are handled by the clients themselves. */
export const parseListingSource = (
  config: JsonLdConnectorConfig,
  raw: string
): JsonLdDiscoveryUrl[] => {
  let urls: JsonLdDiscoveryUrl[];
  if (config.discovery.kind === "sitemap") {
    urls = extractSitemapUrls(raw);
  } else if (config.discovery.kind === "listing") {
    urls = extractListingLinks(
      raw,
      config.discovery.linkPattern,
      config.detailBaseUrl ?? config.discovery.url
    );
  } else if (config.discovery.kind === "json-listing") {
    urls = extractJsonListingUrls(
      raw,
      config.discovery.urlPointer,
      config.discovery.linkPattern,
      config.detailBaseUrl ?? config.discovery.url
    );
  } else {
    urls = [];
  }
  return applyExcludes(urls, config.excludePatterns);
};

/** Resolves the URL the detail fetch actually requests: `detailUrlRewrite` maps
 * the public vacancy URL onto the endpoint that serves its data (a JSON API
 * detail, say), while the observation keeps the public URL as its identity.
 * No rewrite configured or no match → the discovered URL is fetched as-is. */
export const resolveDetailFetchUrl = (
  config: JsonLdConnectorConfig,
  url: string
): string => {
  const rewrite = config.detailUrlRewrite;
  if (!rewrite) {
    return url;
  }
  const parsed = new URL(url);
  const rewritten = parsed.pathname.replace(rewrite.pattern, rewrite.replace);
  if (rewritten === parsed.pathname) {
    return url;
  }
  parsed.pathname = rewritten;
  return parsed.toString();
};

/** A detail fixture's `payload` is JsonValue: HTML pages are recorded as
 * strings, but a JSON-API detail (Alliander's `/api/vacancy`) is recorded as a
 * parsed object and must be serialised back to the raw body text the
 * synthesizer parses. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the fixture envelope's payload is JsonValue by contract; this helper IS the boundary narrowing.
export const detailFixtureBody = (payload: unknown): string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrowing the recorded fixture payload's representation at the I/O boundary.
  typeof payload === "string" ? payload : JSON.stringify(payload);

/** Builds the detail payload for one page. The synthesizer runs on every body
 * so it may surface `contactpersonen` alongside explicit JSON-LD; its
 * `jobPosting` only fills in when no explicit JobPosting node exists (Next.js
 * `__NEXT_DATA__`, Vike `vike_pageContext`, JSON API records, embedded page
 * state). */
export const buildDetailPayload = (
  config: JsonLdConnectorConfig,
  url: string,
  html: string
): JsonLdDetailPayload => {
  const explicitJobPosting = extractJobPosting(html);
  const synthesis: DetailSynthesis | null =
    config.detailSynthesizer?.(html, url) ?? null;
  const jobPosting = explicitJobPosting ?? synthesis?.jobPosting ?? null;
  return {
    contactpersonen: synthesis?.contactpersonen ?? [],
    jobPosting,
    labelBlock: {
      ...extractLabelBlock(html, jobPosting, config.labelBlock),
      ...synthesis?.labelBlock,
    },
    url,
  };
};
