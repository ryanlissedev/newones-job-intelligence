import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readTextBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import { parseCtmFeed } from "./client";
import type { CtmClient, CtmClientOptions } from "./client";
import type { CtmListingPage } from "./types";
import { CTM_FEED_PATH } from "./types";

const DEFAULT_BASE_URL = "https://eu.eu-supply.com";
const DEFAULT_BULLETIN = "CTMSOLUTION";
const DEFAULT_DAYS = 30;

export interface CtmEffectClientOptions extends Omit<
  CtmClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: CtmEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.CTM_LIVE === "1";

export const fetchListingEffect = (
  options: CtmEffectClientOptions
): Effect.Effect<CtmListingPage, ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "ctm/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const bulletin = options.bulletin ?? DEFAULT_BULLETIN;
  const days = options.days ?? DEFAULT_DAYS;

  if (!isLive(options)) {
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load CTM listing fixture ${listingFixturePath}`,
        }),
      try: () => loadConnectorFixture<CtmListingPage>(listingFixturePath),
    }).pipe(Effect.map((fixture) => fixture.payload));
  }

  const url = `${baseUrl}${CTM_FEED_PATH}?days=${days}&b=${bulletin}`;
  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "ctm",
    url,
  }).pipe(
    Effect.flatMap(readTextBody),
    Effect.flatMap((xml) =>
      Effect.try({
        catch: (cause) =>
          new ValidationFault({
            cause,
            message: "Failed to parse CTM feed XML",
          }),
        try: () => parseCtmFeed(xml),
      })
    )
  );
};

/** Effect-backed CTM client. Production default remains native. */
export const createCtmEffectClient = (
  options: CtmEffectClientOptions = {}
): CtmClient => ({
  fetchListing: () =>
    runReadIoPromise(fetchListingEffect(options), {
      signal: options.signal,
    }),
});
