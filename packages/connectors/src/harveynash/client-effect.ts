import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readJsonBody,
  readTextBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import { parseHarveyNashDetailHtml } from "./client";
import type { HarveyNashClient, HarveyNashClientOptions } from "./client";
import type {
  HarveyNashDetailFragment,
  HarveyNashSearchResponse,
} from "./types";
import { HARVEYNASH_PAGE_SIZE, HARVEYNASH_SEARCH_PATH } from "./types";

const DEFAULT_BASE_URL = "https://www.harveynash.nl";

export interface HarveyNashEffectClientOptions extends Omit<
  HarveyNashClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: HarveyNashEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.HARVEYNASH_LIVE === "1";

export const fetchListingEffect = (
  options: HarveyNashEffectClientOptions,
  page: number
): Effect.Effect<HarveyNashSearchResponse, ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "harveynash/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!isLive(options)) {
    if (page > 0) {
      return Effect.succeed({ results: [], total_size: 1 });
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Harvey Nash listing fixture ${listingFixturePath}`,
        }),
      try: () =>
        loadConnectorFixture<HarveyNashSearchResponse>(listingFixturePath),
    }).pipe(Effect.map((fixture) => fixture.payload));
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    init: {
      body: JSON.stringify({
        job_search: {
          jobs_per_page: HARVEYNASH_PAGE_SIZE,
          offset: page * HARVEYNASH_PAGE_SIZE,
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    sourceSlug: "harveynash",
    url: `${baseUrl}${HARVEYNASH_SEARCH_PATH}`,
  }).pipe(
    Effect.flatMap((response) =>
      readJsonBody<HarveyNashSearchResponse>(response)
    )
  );
};

export const fetchDetailEffect = (
  options: HarveyNashEffectClientOptions,
  jobId: string,
  detailUrl: string
): Effect.Effect<HarveyNashDetailFragment, ReadIoFault> => {
  const detailFixtures = options.detailFixtures ?? {
    "452d25a3-ae7d-4ee6-9ceb-3c696332799f":
      "harveynash/detail-endpoints-specialist.json",
  };

  if (!isLive(options)) {
    const relativePath = detailFixtures[jobId];
    if (!relativePath) {
      return Effect.fail(
        new ValidationFault({
          message: `Missing Harvey Nash detail fixture for ${jobId}`,
        })
      );
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Harvey Nash detail fixture ${relativePath}`,
        }),
      try: () => loadConnectorFixture<string>(relativePath),
    }).pipe(
      Effect.flatMap((fixture) =>
        Effect.try({
          catch: (cause) =>
            new ValidationFault({
              cause,
              message: "Failed to parse Harvey Nash detail HTML",
            }),
          try: () => parseHarveyNashDetailHtml(fixture.payload),
        })
      )
    );
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "harveynash",
    url: detailUrl,
  }).pipe(
    Effect.flatMap(readTextBody),
    Effect.flatMap((html) =>
      Effect.try({
        catch: (cause) =>
          new ValidationFault({
            cause,
            message: "Failed to parse Harvey Nash detail HTML",
          }),
        try: () => parseHarveyNashDetailHtml(html),
      })
    )
  );
};

/** Effect-backed Harvey Nash client. Production default remains native. */
export const createHarveyNashEffectClient = (
  options: HarveyNashEffectClientOptions = {}
): HarveyNashClient => ({
  fetchDetail: (jobId, detailUrl) =>
    runReadIoPromise(fetchDetailEffect(options, jobId, detailUrl), {
      signal: options.signal,
    }),
  fetchListing: (page) =>
    runReadIoPromise(fetchListingEffect(options, page), {
      signal: options.signal,
    }),
});
