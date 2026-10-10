import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import type { InhuurdeskAssignment, InhuurdeskListingPage } from "./types";
import { INHUURDESK_SEARCH_PATH } from "./types";

export interface InhuurdeskClient {
  fetchListing: (page: number) => Promise<InhuurdeskListingPage>;
}

export interface InhuurdeskClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
}

const DEFAULT_BASE_URL = "https://www.inhuurdesk.nl";

const readJson = async <Payload>(response: Response): Promise<Payload> => {
  if (!response.ok) {
    throw new Error(`Inhuurdesk request failed with status ${response.status}`);
  }
  // SAFETY: Inhuurdesk WP JSON listing responses match InhuurdeskListingPage.
  return (await response.json()) as Payload;
};

export const createInhuurdeskClient = (
  options: InhuurdeskClientOptions = {}
): InhuurdeskClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("inhuurdesk");
  const liveEnabled =
    options.liveEnabled ?? process.env.INHUURDESK_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "inhuurdesk/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  return {
    fetchListing: async (page) => {
      if (!liveEnabled) {
        if (page > 1) {
          return { data: [], total: 1 };
        }
        const fixture =
          await loadConnectorFixture<InhuurdeskListingPage>(listingFixturePath);
        return fixture.payload;
      }
      const response = await fetchImpl(
        `${baseUrl}${INHUURDESK_SEARCH_PATH}?page=${page}`
      );
      return readJson<InhuurdeskListingPage>(response);
    },
  };
};

/** The platform UUID is the stable external id: the public detail URL is
 * keyed on it and it is the record's primary identity across the
 * HeadFirst-family APIs (same choice as Striive). `referenceCode` (the
 * human-facing `SRQ…` aanvraagnummer) is kept in bronSpecifiek. */
export const inhuurdeskBronReferentie = (
  assignment: InhuurdeskAssignment
): string => assignment.id;
