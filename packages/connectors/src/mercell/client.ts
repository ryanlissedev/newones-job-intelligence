import { loadConnectorFixture } from "../fixtures/load";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import type {
  MercellDetail,
  MercellListingItem,
  MercellListingPage,
  MercellSearchParameters,
} from "./types";
import { MERCELL_PAGE_SIZE, MERCELL_TODAY_SEARCH_PROPERTY } from "./types";

/**
 * Mercell s2c public API. Verified 2026-09-18:
 * `POST <LISTING_URL>` and `GET <DETAIL_URL>?tenderId=` both answer without
 * credentials (the Angular portal calls them unauthenticated). The
 * `Content-Type: application/json` header is required on the POST — a bare
 * body is answered `500`.
 */
const LISTING_URL =
  "https://api.s2c.mercell.com/api/v1/PublishedTender/GetPublishedTendersBySpecified";
const DETAIL_URL =
  "https://api.s2c.mercell.com/api/v1/PublishedTender/GetPublishedTenderDetails";

export interface MercellClient {
  fetchListing: (
    page: number,
    options?: { todayOnly?: boolean }
  ) => Promise<MercellListingPage>;
  fetchDetail: (tenderId: string) => Promise<MercellDetail>;
}

export interface MercellClientOptions {
  /** API origin override (tests). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  liveEnabled?: boolean;
  listingFixturePath?: string;
  /** Fixture paths (relative to `fixtures/connectors`) keyed by TenderId. */
  detailFixtures?: Record<string, string>;
  timeoutMs?: number;
}

/** Request shape the portal posts — `StartIndex`/`EndIndex` are 1-based
 * inclusive row bounds, so page 0 is rows 1..100 and page 1 is 101..200. */
export const buildMercellSearchParameters = (
  page: number,
  options?: { todayOnly?: boolean; pageSize?: number }
): MercellSearchParameters => {
  const pageSize = options?.pageSize ?? MERCELL_PAGE_SIZE;
  const startIndex = page * pageSize + 1;
  return {
    EndIndex: startIndex + pageSize - 1,
    Keywords: [],
    OrderAscending: false,
    OrderColumn: "CreatedDate",
    PropertyFilters: [],
    SearchProperty: options?.todayOnly
      ? { ...MERCELL_TODAY_SEARCH_PROPERTY }
      : null,
    SearchText: null,
    StartIndex: startIndex,
    UserId: null,
  };
};

interface MercellListingResponse {
  ResultsCount?: number;
  CurrentPageResults?: MercellListingItem[];
}

const readJson = async <Payload>(
  response: Response,
  what: string
): Promise<Payload> => {
  if (!response.ok) {
    throw new Error(
      `Mercell ${what} request failed with status ${response.status}`
    );
  }
  // SAFETY: Mercell's public API responses match the declared listing/detail
  // shapes; DEC-008 projection in the connector bounds what leaves the client.
  return (await response.json()) as Payload;
};

const toListingPage = (
  raw: MercellListingResponse,
  startIndex: number,
  endIndex: number
): MercellListingPage => ({
  endIndex,
  results: raw.CurrentPageResults ?? [],
  resultsCount: raw.ResultsCount ?? 0,
  startIndex,
});

const emptyListingPage = (startIndex: number): MercellListingPage => ({
  endIndex: startIndex - 1,
  results: [],
  resultsCount: 0,
  startIndex,
});

/** Wire shape of the detail response — `PublicationAuthorities` carries full
 * authority records; only `Mnemonic` is modelled downstream. Fixture payloads
 * are raw wire bodies, so this mapping applies to both fetch paths. */
type MercellDetailWire = Omit<MercellDetail, "publicationAuthorities"> & {
  PublicationAuthorities?: { Mnemonic?: string | null }[] | null;
};

const toMercellDetail = (raw: MercellDetailWire): MercellDetail => {
  const { PublicationAuthorities, ...rest } = raw;
  return {
    ...rest,
    publicationAuthorities: (PublicationAuthorities ?? []).flatMap(
      (authority) => (authority?.Mnemonic ? [authority.Mnemonic] : [])
    ),
  };
};

export const createMercellClient = (
  options: MercellClientOptions = {}
): MercellClient => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const liveEnabled = options.liveEnabled ?? process.env.MERCELL_LIVE === "1";
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);
  const { baseUrl } = options;
  const listingUrl = baseUrl
    ? `${baseUrl}${new URL(LISTING_URL).pathname}`
    : LISTING_URL;
  const detailUrl = baseUrl
    ? `${baseUrl}${new URL(DETAIL_URL).pathname}`
    : DETAIL_URL;
  const listingFixturePath =
    options.listingFixturePath ?? "mercell/listing-page-0.json";
  // Real TenderIds captured in listing-page-0.json (2026-09-18).
  const detailFixtures = options.detailFixtures ?? {
    "226047": "mercell/detail-226047.json",
    "227142": "mercell/detail-227142.json",
    "228236": "mercell/detail-228236.json",
    "228388": "mercell/detail-228388.json",
    "234450": "mercell/detail-234450.json",
  };

  return {
    fetchDetail: async (tenderId) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[tenderId];
        if (!relativePath) {
          throw new Error(`Missing Mercell detail fixture for ${tenderId}`);
        }
        const fixture =
          await loadConnectorFixture<MercellDetailWire>(relativePath);
        return toMercellDetail(fixture.payload);
      }
      return withHttpTimeout(async (signal) => {
        const response = await fetchImpl(
          `${detailUrl}?tenderId=${encodeURIComponent(tenderId)}`,
          { signal }
        );
        return toMercellDetail(
          await readJson<MercellDetailWire>(response, "detail")
        );
      }, timeoutMs);
    },
    fetchListing: async (page, fetchOptions) => {
      const search = buildMercellSearchParameters(page, fetchOptions);
      if (!liveEnabled) {
        if (page > 0) {
          return emptyListingPage(search.StartIndex);
        }
        const fixture =
          await loadConnectorFixture<MercellListingResponse>(
            listingFixturePath
          );
        return toListingPage(
          fixture.payload,
          search.StartIndex,
          search.EndIndex
        );
      }
      return withHttpTimeout(async (signal) => {
        const response = await fetchImpl(listingUrl, {
          body: JSON.stringify({ SearchParameters: search }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal,
        });
        const raw = await readJson<MercellListingResponse>(response, "listing");
        return toListingPage(raw, search.StartIndex, search.EndIndex);
      }, timeoutMs);
    },
  };
};
