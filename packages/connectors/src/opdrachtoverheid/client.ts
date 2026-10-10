/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the private listing API is an untrusted JSON boundary and is narrowed before projection. */
import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import {
  OPDRACHTOVERHEID_SITE_BASE_URL,
  OPDRACHTOVERHEID_SITEMAP_PATH,
  parseOpdrachtoverheidDetailPage,
  parseOpdrachtoverheidSitemap,
} from "./ssr";
import type {
  OpdrachtoverheidDetailPage,
  OpdrachtoverheidSitemapEntry,
} from "./ssr";
import {
  OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES,
  OPDRACHTOVERHEID_MAX_RECORDS,
  OPDRACHTOVERHEID_SEARCH_PATH,
} from "./types";
import type {
  OpdrachtoverheidListingResponse,
  OpdrachtoverheidTender,
} from "./types";

export interface OpdrachtoverheidListingPage {
  items: OpdrachtoverheidTender[];
  /** True when this listing must be treated as incomplete. Live responses are
   * always true because the private API has no verified EOF signal; finite
   * fixtures may be complete when they are under the bound. */
  hasMore: boolean;
}

export interface OpdrachtoverheidClient {
  /** Private `POST /search` snapshot — the fallback when the public sitemap
   * is unavailable. */
  fetchListing: (page: number) => Promise<OpdrachtoverheidListingPage>;
  /** Market-wide discovery (CTP-601): every `/inhuuropdracht/` entry in the
   * public sitemap. Resolves to `[]` when not in live mode and no sitemap
   * fixture is configured, which makes the connector fall back to the
   * private listing path. */
  fetchSitemap: () => Promise<OpdrachtoverheidSitemapEntry[]>;
  /** Fetches and parses one SSR detail page: the Nuxt tender record plus the
   * JobPosting JSON-LD node. Both are `null` when not in live mode and no
   * detail fixture is registered for the page's `web_key`, or when the page
   * carries no such data. */
  fetchDetail: (
    entry: Pick<OpdrachtoverheidSitemapEntry, "detailUrl" | "webKey">
  ) => Promise<OpdrachtoverheidDetailPage>;
}

export interface OpdrachtoverheidClientOptions {
  /** Private API origin. */
  baseUrl?: string;
  /** Fixture paths (relative to `fixtures/connectors`) keyed by `web_key`,
   * used instead of the network when not live. */
  detailFixturePaths?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
  /** Public site origin that serves the sitemap and the SSR detail pages. */
  siteBaseUrl?: string;
  /** Sitemap fixture path (relative to `fixtures/connectors`), used instead
   * of the network when not live. Unset means "no sitemap in fixture mode". */
  sitemapFixturePath?: string;
  /** Maximum time for one live request, including response-body consumption. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://kbenp-match-api.azurewebsites.net";

/** Byte bound for one public page (sitemap or SSR detail) before parsing. */
export const OPDRACHTOVERHEID_MAX_PAGE_BODY_BYTES = 2 * 1024 * 1024;

const readBoundedText = async (
  response: Response,
  what: string
): Promise<string> => {
  if (!response.ok) {
    throw new Error(
      `Opdrachtoverheid ${what} request failed with status ${response.status}`
    );
  }
  const text = await response.text();
  if (
    new TextEncoder().encode(text).byteLength >
    OPDRACHTOVERHEID_MAX_PAGE_BODY_BYTES
  ) {
    throw new Error(
      `Opdrachtoverheid ${what} response exceeds ${OPDRACHTOVERHEID_MAX_PAGE_BODY_BYTES} bytes`
    );
  }
  return text;
};

const responseTooLarge = (): Error =>
  new Error(
    `Opdrachtoverheid listing response exceeds ${OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES} bytes`
  );

const parseJson = <Payload>(text: string): Payload =>
  // SAFETY: Callers validate source-specific response shape at the parser
  // boundary after this wire-level JSON decode.
  JSON.parse(text) as Payload;

export const readBoundedOpdrachtoverheidJson = async <Payload>(
  response: Response,
  signal?: AbortSignal
): Promise<Payload> => {
  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw (
        signal.reason ??
        new DOMException("The operation was aborted", "AbortError")
      );
    }
  };

  if (!response.ok) {
    throw new Error(
      `Opdrachtoverheid request failed with status ${response.status}`
    );
  }

  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength ? Number(contentLength) : Number.NaN;
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // The size violation is the actionable error.
    }
    throw responseTooLarge();
  }

  throwIfAborted();
  if (!response.body) {
    const text = await response.text();
    throwIfAborted();
    if (
      new TextEncoder().encode(text).byteLength >
      OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES
    ) {
      throw responseTooLarge();
    }
    return parseJson<Payload>(text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelReader = async (reason?: unknown): Promise<void> => {
    try {
      await reader.cancel(reason);
    } catch {
      // The original timeout or size error remains the actionable error.
    }
  };
  const abortReader = (): void => {
    void cancelReader(signal?.reason);
  };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      throwIfAborted();
      // oxlint-disable-next-line no-await-in-loop -- stream chunks are ordered and must be bounded cumulatively
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- consume cancellation before reporting the size violation
        await cancelReader(responseTooLarge());
        throw responseTooLarge();
      }
      chunks.push(chunk.value);
    }
    throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJson<Payload>(new TextDecoder().decode(body));
};

/**
 * Live probing found that offset values other than 0 fail. More importantly,
 * cumulative limits and repeated requests can reorder records, so tail
 * slicing cannot identify a stable next page. Each run takes one bounded
 * snapshot from offset 0, deduplicates tender IDs, and reports every live
 * response as truncated because no upstream EOF contract has been verified.
 * This private API may change without notice.
 *
 * The endpoint does not reliably return active tenders first and accepts no
 * verified sort or filter control. Liveness is handled downstream from the
 * source's tender_active and tender_status fields. The established
 * 400-record bound remains the request budget and completeness limit.
 */
const deduplicateTenders = (
  tenders: OpdrachtoverheidTender[]
): OpdrachtoverheidTender[] => {
  const seenTenderIds = new Set<string>();
  return tenders.filter((tender) => {
    if (!tender.tender_id) {
      return true;
    }
    if (seenTenderIds.has(tender.tender_id)) {
      return false;
    }
    seenTenderIds.add(tender.tender_id);
    return true;
  });
};

const hasValidTenderId = (value: unknown): value is OpdrachtoverheidTender => {
  if (typeof value !== "object" || value === null || !("tender_id" in value)) {
    return false;
  }
  return (
    typeof value.tender_id === "string" && value.tender_id.trim().length > 0
  );
};

export const parseOpdrachtoverheidListing = (
  body: unknown
): OpdrachtoverheidListingPage => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("negometrix_tenders" in body) ||
    !Array.isArray(body.negometrix_tenders)
  ) {
    throw new Error("Opdrachtoverheid listing response has invalid items");
  }
  const all = body.negometrix_tenders;
  if (!all.every(hasValidTenderId)) {
    throw new Error(
      "Opdrachtoverheid listing response contains an invalid tender_id"
    );
  }
  if (all.length > OPDRACHTOVERHEID_MAX_RECORDS) {
    throw new Error(
      `Opdrachtoverheid listing returned ${all.length} records; maximum supported snapshot is ${OPDRACHTOVERHEID_MAX_RECORDS}`
    );
  }
  return {
    hasMore: all.length === OPDRACHTOVERHEID_MAX_RECORDS,
    items: deduplicateTenders(all),
  };
};

const parseLiveOpdrachtoverheidListing = (
  body: unknown
): OpdrachtoverheidListingPage => {
  const listing = parseOpdrachtoverheidListing(body);
  return { ...listing, hasMore: true };
};

export const createOpdrachtoverheidClient = (
  options: OpdrachtoverheidClientOptions = {}
): OpdrachtoverheidClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("opdrachtoverheid");
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);
  const liveEnabled =
    options.liveEnabled ?? process.env.OPDRACHTOVERHEID_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "opdrachtoverheid/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const siteBaseUrl = options.siteBaseUrl ?? OPDRACHTOVERHEID_SITE_BASE_URL;
  const { detailFixturePaths, sitemapFixturePath } = options;

  return {
    fetchDetail: async ({ detailUrl, webKey }) => {
      if (!liveEnabled) {
        const fixturePath = detailFixturePaths?.[webKey];
        if (!fixturePath) {
          return { jobPosting: null, tender: null };
        }
        const fixture = await loadConnectorFixture<string>(fixturePath);
        return parseOpdrachtoverheidDetailPage(fixture.payload, detailUrl);
      }
      return await withHttpTimeout(async (signal) => {
        const response = await fetchImpl(detailUrl, { signal });
        if (response.status === 404 || response.status === 410) {
          return { jobPosting: null, tender: null };
        }
        const html = await readBoundedText(response, "detail");
        return parseOpdrachtoverheidDetailPage(html, detailUrl);
      }, timeoutMs);
    },
    fetchListing: async (_page) => {
      if (!liveEnabled) {
        const fixture =
          await loadConnectorFixture<OpdrachtoverheidListingResponse>(
            listingFixturePath
          );
        return parseOpdrachtoverheidListing(fixture.payload);
      }

      const body = await withHttpTimeout(async (signal) => {
        const response = await fetchImpl(
          `${baseUrl}${OPDRACHTOVERHEID_SEARCH_PATH}`,
          {
            body: JSON.stringify({
              limit: OPDRACHTOVERHEID_MAX_RECORDS,
              offset: 0,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal,
          }
        );
        return await readBoundedOpdrachtoverheidJson<OpdrachtoverheidListingResponse>(
          response,
          signal
        );
      }, timeoutMs);
      return parseLiveOpdrachtoverheidListing(body);
    },
    fetchSitemap: async () => {
      if (!liveEnabled) {
        if (!sitemapFixturePath) {
          return [];
        }
        const fixture = await loadConnectorFixture<string>(sitemapFixturePath);
        return parseOpdrachtoverheidSitemap(fixture.payload);
      }
      return await withHttpTimeout(async (signal) => {
        const response = await fetchImpl(
          `${siteBaseUrl}${OPDRACHTOVERHEID_SITEMAP_PATH}`,
          { signal }
        );
        const xml = await readBoundedText(response, "sitemap");
        return parseOpdrachtoverheidSitemap(xml);
      }, timeoutMs);
    },
  };
};

export const opdrachtoverheidBronReferentie = (
  tender: OpdrachtoverheidTender
): string => tender.tender_id;
