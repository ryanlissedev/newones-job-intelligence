import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readJsonBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import type { StriiveClient, StriiveClientOptions } from "./client";
import type { StriiveListingResponse } from "./types";
import { STRIIVE_JOBS_PATH } from "./types";

const DEFAULT_BASE_URL = "https://striive-cms.codebridge.nl";

export interface StriiveEffectClientOptions extends Omit<
  StriiveClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: StriiveEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.STRIIVE_LIVE === "1";

export const fetchListingEffect = (
  options: StriiveEffectClientOptions,
  page: number
): Effect.Effect<StriiveListingResponse, ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "striive/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!isLive(options)) {
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Striive listing fixture ${listingFixturePath}`,
        }),
      try: () =>
        loadConnectorFixture<StriiveListingResponse>(listingFixturePath),
    }).pipe(
      Effect.map((fixture) => {
        if (page > 1) {
          return { data: [], total: fixture.payload.total };
        }
        return fixture.payload;
      })
    );
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "striive",
    url: `${baseUrl}${STRIIVE_JOBS_PATH}?open=true&page=${page}`,
  }).pipe(
    Effect.flatMap((response) => readJsonBody<StriiveListingResponse>(response))
  );
};

/** Effect-backed Striive client. Production default remains native. */
export const createStriiveEffectClient = (
  options: StriiveEffectClientOptions = {}
): StriiveClient => ({
  fetchListing: (page) =>
    runReadIoPromise(fetchListingEffect(options, page), {
      signal: options.signal,
    }),
});
