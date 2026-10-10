import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readJsonBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import type { OnefellowClient, OnefellowClientOptions } from "./client";
import type { OnefellowJob, OnefellowListingResponse } from "./types";
import { ONEFELLOW_LISTING_URL } from "./types";

export interface OnefellowEffectClientOptions extends Omit<
  OnefellowClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: OnefellowEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.ONEFELLOW_LIVE === "1";

export const fetchListingEffect = (
  options: OnefellowEffectClientOptions
): Effect.Effect<OnefellowJob[], ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "onefellow/listing-page-0.json";

  if (!isLive(options)) {
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Onefellow listing fixture ${listingFixturePath}`,
        }),
      try: () =>
        loadConnectorFixture<OnefellowListingResponse>(listingFixturePath),
    }).pipe(Effect.map((fixture) => fixture.payload.jobs));
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "onefellow",
    url: ONEFELLOW_LISTING_URL,
  }).pipe(
    Effect.flatMap((response) =>
      readJsonBody<OnefellowListingResponse>(response)
    ),
    Effect.map((body) => body.jobs)
  );
};

/** Effect-backed Onefellow client. Production default remains native. */
export const createOnefellowEffectClient = (
  options: OnefellowEffectClientOptions = {}
): OnefellowClient => ({
  fetchListing: () =>
    runReadIoPromise(fetchListingEffect(options), {
      signal: options.signal,
    }),
});
