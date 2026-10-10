import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { ONEFELLOW_LISTING_URL } from "./types";
import type { OnefellowJob, OnefellowListingResponse } from "./types";

export interface OnefellowClient {
  /** No pagination: the endpoint returns all open opdrachten in one call
   * (confirmed live 2026-08-31, 50/50 jobs, no cursor/offset behaviour
   * observed). Call at most once per few hours per docs/sources/onefellow.md. */
  fetchListing: () => Promise<OnefellowJob[]>;
}

export interface OnefellowClientOptions {
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
}

export const createOnefellowClient = (
  options: OnefellowClientOptions = {}
): OnefellowClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("onefellow");
  const liveEnabled = options.liveEnabled ?? process.env.ONEFELLOW_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "onefellow/listing-page-0.json";

  return {
    fetchListing: async () => {
      if (!liveEnabled) {
        const fixture =
          await loadConnectorFixture<OnefellowListingResponse>(
            listingFixturePath
          );
        return fixture.payload.jobs;
      }
      const response = await fetchImpl(ONEFELLOW_LISTING_URL);
      if (!response.ok) {
        throw new Error(
          `Onefellow listing request failed with status ${response.status}`
        );
      }
      // SAFETY: Onefellow's private JSON endpoint returns the shape
      // observed by the live probe (see types.ts doc comment) -- an
      // undocumented API that can change without notice.
      const body = (await response.json()) as OnefellowListingResponse;
      return body.jobs;
    },
  };
};
