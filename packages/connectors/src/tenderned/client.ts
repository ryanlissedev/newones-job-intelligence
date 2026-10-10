import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { coerceTenderNedIds } from "./ids";
import type {
  TenderNedDetail,
  TenderNedFilters,
  TenderNedListingPage,
} from "./types";
import { TENDER_NED_MAX_PAGE_SIZE } from "./types";

const LISTING_BASE =
  "https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties";

export interface TenderNedClient {
  fetchListing: (
    page: number,
    filters: TenderNedFilters
  ) => Promise<TenderNedListingPage>;
  fetchDetail: (publicatieId: string) => Promise<TenderNedDetail>;
}

export interface TenderNedClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  liveEnabled?: boolean;
  listingFixturePath?: string;
  detailFixtures?: Record<string, string>;
}

const capPageSize = (requestedSize: number): number =>
  Math.min(requestedSize, TENDER_NED_MAX_PAGE_SIZE);

export const buildTenderNedListingUrl = (
  page: number,
  filters: TenderNedFilters,
  size = TENDER_NED_MAX_PAGE_SIZE
): string => {
  const params = new URLSearchParams({
    page: String(page),
    size: String(capPageSize(size)),
  });
  if (filters.publicatieDatumVanaf) {
    params.set("publicatieDatumVanaf", filters.publicatieDatumVanaf);
  }
  if (filters.typeOpdracht) {
    params.set("typeOpdracht", filters.typeOpdracht);
  }
  for (const cpv of filters.cpvCodes ?? []) {
    params.append("cpvCodes", cpv);
  }
  return `${LISTING_BASE}?${params.toString()}`;
};

const coerceListingPage = (
  page: TenderNedListingPage
): TenderNedListingPage => ({
  ...page,
  content: page.content.map(coerceTenderNedIds),
});

const readJson = async <Payload>(response: Response): Promise<Payload> => {
  if (!response.ok) {
    throw new Error(`TenderNed request failed with status ${response.status}`);
  }
  // SAFETY: TenderNed public API responses match the typed listing/detail schemas.
  return (await response.json()) as Payload;
};

export const createTenderNedClient = (
  options: TenderNedClientOptions = {}
): TenderNedClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("tenderned");
  const liveEnabled =
    options.liveEnabled ?? process.env.TENDER_NED_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "tenderned/listing-page-0.json";
  const detailFixtures = options.detailFixtures ?? {
    "fixture-pub-001": "tenderned/detail-pub-001.json",
  };

  return {
    fetchDetail: async (publicatieId) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[publicatieId];
        if (!relativePath) {
          throw new Error(
            `Missing TenderNed detail fixture for ${publicatieId}`
          );
        }
        const fixture =
          await loadConnectorFixture<TenderNedDetail>(relativePath);
        return coerceTenderNedIds(fixture.payload);
      }
      const baseUrl = options.baseUrl ?? LISTING_BASE;
      const response = await fetchImpl(`${baseUrl}/${publicatieId}`);
      return coerceTenderNedIds(await readJson<TenderNedDetail>(response));
    },
    fetchListing: async (page, filters) => {
      if (!liveEnabled) {
        if (page > 0) {
          return {
            content: [],
            first: false,
            last: true,
            number: page,
            size: TENDER_NED_MAX_PAGE_SIZE,
            totalElements: 1,
            totalPages: 1,
          };
        }
        const fixture =
          await loadConnectorFixture<TenderNedListingPage>(listingFixturePath);
        return coerceListingPage(fixture.payload);
      }
      const response = await fetchImpl(
        buildTenderNedListingUrl(page, filters, TENDER_NED_MAX_PAGE_SIZE)
      );
      return coerceListingPage(await readJson<TenderNedListingPage>(response));
    },
  };
};

export const requestedListingSize = (size: number): number => capPageSize(size);
