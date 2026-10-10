import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readJsonBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import type { InhuurdeskClient, InhuurdeskClientOptions } from "./client";
import type { InhuurdeskListingPage } from "./types";
import { INHUURDESK_SEARCH_PATH } from "./types";

const DEFAULT_BASE_URL = "https://www.inhuurdesk.nl";

export interface InhuurdeskEffectClientOptions extends Omit<
  InhuurdeskClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: InhuurdeskEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.INHUURDESK_LIVE === "1";

export const fetchListingEffect = (
  options: InhuurdeskEffectClientOptions,
  page: number
): Effect.Effect<InhuurdeskListingPage, ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "inhuurdesk/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!isLive(options)) {
    if (page > 1) {
      return Effect.succeed({ data: [], total: 1 });
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Inhuurdesk listing fixture ${listingFixturePath}`,
        }),
      try: () =>
        loadConnectorFixture<InhuurdeskListingPage>(listingFixturePath),
    }).pipe(Effect.map((fixture) => fixture.payload));
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "inhuurdesk",
    url: `${baseUrl}${INHUURDESK_SEARCH_PATH}?page=${page}`,
  }).pipe(
    Effect.flatMap((response) => readJsonBody<InhuurdeskListingPage>(response))
  );
};

/** Effect-backed Inhuurdesk client. Production default remains native. */
export const createInhuurdeskEffectClient = (
  options: InhuurdeskEffectClientOptions = {}
): InhuurdeskClient => ({
  fetchListing: (page) =>
    runReadIoPromise(fetchListingEffect(options, page), {
      signal: options.signal,
    }),
});
