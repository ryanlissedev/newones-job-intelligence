import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { resolveHttpTimeoutMs, withHttpTimeout } from "../http-timeout";
import { STRIIVE_JOBS_PATH } from "./types";
import type { StriiveJob, StriiveListingResponse } from "./types";

export interface StriiveClient {
  fetchListing: (page: number) => Promise<StriiveListingResponse>;
}

export interface StriiveClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
  /** Maximum time for one live request, including response-body consumption. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://striive-cms.codebridge.nl";

const readJson = async <Payload>(response: Response): Promise<Payload> => {
  if (!response.ok) {
    throw new Error(`Striive request failed with status ${response.status}`);
  }
  // SAFETY: Striive's public jobs endpoint returns the shape observed by
  // the live probe (see types.ts doc comment).
  return (await response.json()) as Payload;
};

export const createStriiveClient = (
  options: StriiveClientOptions = {}
): StriiveClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("striive");
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);
  const liveEnabled = options.liveEnabled ?? process.env.STRIIVE_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "striive/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  return {
    fetchListing: async (page) => {
      if (!liveEnabled) {
        const fixture =
          await loadConnectorFixture<StriiveListingResponse>(
            listingFixturePath
          );
        // Fixture/replay runs only ever serve page 1 -- matching the
        // documented API behaviour where page 0/1 are the same first page.
        if (page > 1) {
          return { data: [], total: fixture.payload.total };
        }
        return fixture.payload;
      }
      return await withHttpTimeout(async (signal) => {
        const response = await fetchImpl(
          `${baseUrl}${STRIIVE_JOBS_PATH}?open=true&page=${page}`,
          { signal }
        );
        return await readJson<StriiveListingResponse>(response);
      }, timeoutMs);
    },
  };
};

export const striiveBronReferentie = (job: Pick<StriiveJob, "id">): string =>
  job.id;
