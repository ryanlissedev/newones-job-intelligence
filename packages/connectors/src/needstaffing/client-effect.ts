import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readTextBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import { parseNeedstaffingListing } from "./client";
import type { NeedstaffingClient, NeedstaffingClientOptions } from "./client";
import type { NeedstaffingListingPage } from "./types";
import {
  NEEDSTAFFING_DETAIL_FIXTURES,
  NEEDSTAFFING_OPDRACHTEN_PATH,
} from "./types";

const DEFAULT_BASE_URL = "https://www.needstaffing.nl";

export interface NeedstaffingEffectClientOptions extends Omit<
  NeedstaffingClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: NeedstaffingEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.NEEDSTAFFING_LIVE === "1";

export const fetchListingEffect = (
  options: NeedstaffingEffectClientOptions,
  page: number
): Effect.Effect<NeedstaffingListingPage, ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "needstaffing/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!isLive(options)) {
    if (page > 0) {
      return Effect.succeed({ hasNextPage: false, items: [] });
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Needstaffing listing fixture ${listingFixturePath}`,
        }),
      try: () => loadConnectorFixture<string>(listingFixturePath),
    }).pipe(
      Effect.flatMap((fixture) =>
        Effect.tryPromise({
          catch: (cause) =>
            new ValidationFault({
              cause,
              message: "Failed to parse Needstaffing listing HTML",
            }),
          try: () => parseNeedstaffingListing(fixture.payload),
        })
      )
    );
  }

  const params = new URLSearchParams({
    PageNumber: String(page + 1),
    SortOrder: "NewestFirst",
  });
  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "needstaffing",
    url: `${baseUrl}${NEEDSTAFFING_OPDRACHTEN_PATH}?${params.toString()}`,
  }).pipe(
    Effect.flatMap(readTextBody),
    Effect.flatMap((html) =>
      Effect.tryPromise({
        catch: (cause) =>
          new ValidationFault({
            cause,
            message: "Failed to parse Needstaffing listing HTML",
          }),
        try: () => parseNeedstaffingListing(html),
      })
    )
  );
};

export const fetchDetailHtmlEffect = (
  options: NeedstaffingEffectClientOptions,
  id: string
): Effect.Effect<string, ReadIoFault> => {
  const detailFixtures = options.detailFixtures ?? NEEDSTAFFING_DETAIL_FIXTURES;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!isLive(options)) {
    const relativePath = detailFixtures[id];
    if (!relativePath) {
      return Effect.fail(
        new ValidationFault({
          message: `Missing Needstaffing detail fixture for ${id}`,
        })
      );
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Needstaffing detail fixture ${relativePath}`,
        }),
      try: () => loadConnectorFixture<string>(relativePath),
    }).pipe(Effect.map((fixture) => fixture.payload));
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "needstaffing",
    url: `${baseUrl}${NEEDSTAFFING_OPDRACHTEN_PATH}/${id}`,
  }).pipe(Effect.flatMap(readTextBody));
};

/** Effect-backed Needstaffing client. Production default remains native. */
export const createNeedstaffingEffectClient = (
  options: NeedstaffingEffectClientOptions = {}
): NeedstaffingClient => ({
  fetchDetailHtml: (id) =>
    runReadIoPromise(fetchDetailHtmlEffect(options, id), {
      signal: options.signal,
    }),
  fetchListing: (page) =>
    runReadIoPromise(fetchListingEffect(options, page), {
      signal: options.signal,
    }),
});
