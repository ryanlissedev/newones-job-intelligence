import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readTextBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import { parseFlinterListing } from "./client";
import type { FlinterClient, FlinterClientOptions } from "./client";
import type { FlinterListingItem } from "./types";
import { FLINTER_OPDRACHTEN_PATH } from "./types";

const DEFAULT_BASE_URL = "https://www.flinter.nl";

export interface FlinterEffectClientOptions extends Omit<
  FlinterClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: FlinterEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.FLINTER_LIVE === "1";

export const fetchListingEffect = (
  options: FlinterEffectClientOptions
): Effect.Effect<FlinterListingItem[], ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "flinter/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!isLive(options)) {
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Flinter listing fixture ${listingFixturePath}`,
        }),
      try: () => loadConnectorFixture<string>(listingFixturePath),
    }).pipe(
      Effect.flatMap((fixture) =>
        Effect.try({
          catch: (cause) =>
            new ValidationFault({
              cause,
              message: "Failed to parse Flinter listing HTML",
            }),
          try: () => parseFlinterListing(fixture.payload),
        })
      )
    );
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "flinter",
    url: `${baseUrl}${FLINTER_OPDRACHTEN_PATH}`,
  }).pipe(
    Effect.flatMap(readTextBody),
    Effect.flatMap((html) =>
      Effect.try({
        catch: (cause) =>
          new ValidationFault({
            cause,
            message: "Failed to parse Flinter listing HTML",
          }),
        try: () => parseFlinterListing(html),
      })
    )
  );
};

export const fetchDetailHtmlEffect = (
  options: FlinterEffectClientOptions,
  slug: string
): Effect.Effect<string, ReadIoFault> => {
  const detailFixtures = options.detailFixtures ?? {
    bedrijfsjurist: "flinter/detail-bedrijfsjurist.json",
    "vergunningverlener-agrarisch":
      "flinter/detail-vergunningverlener-agrarisch.json",
  };
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!isLive(options)) {
    const relativePath = detailFixtures[slug];
    if (!relativePath) {
      return Effect.fail(
        new ValidationFault({
          message: `Missing Flinter detail fixture for ${slug}`,
        })
      );
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Flinter detail fixture ${relativePath}`,
        }),
      try: () => loadConnectorFixture<string>(relativePath),
    }).pipe(Effect.map((fixture) => fixture.payload));
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "flinter",
    url: `${baseUrl}${FLINTER_OPDRACHTEN_PATH}/${slug}`,
  }).pipe(Effect.flatMap(readTextBody));
};

/** Effect-backed Flinter client. Production default remains native. */
export const createFlinterEffectClient = (
  options: FlinterEffectClientOptions = {}
): FlinterClient => ({
  fetchDetailHtml: (slug) =>
    runReadIoPromise(fetchDetailHtmlEffect(options, slug), {
      signal: options.signal,
    }),
  fetchListing: () =>
    runReadIoPromise(fetchListingEffect(options), {
      signal: options.signal,
    }),
});
