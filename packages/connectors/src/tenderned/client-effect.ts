import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  readJsonBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import { buildTenderNedListingUrl } from "./client";
import type { TenderNedClient, TenderNedClientOptions } from "./client";
import { coerceTenderNedIds } from "./ids";
import type {
  TenderNedDetail,
  TenderNedFilters,
  TenderNedListingPage,
} from "./types";
import { TENDER_NED_MAX_PAGE_SIZE } from "./types";

const LISTING_BASE =
  "https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties";

export interface TenderNedEffectClientOptions extends Omit<
  TenderNedClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const coerceListingPage = (
  page: TenderNedListingPage
): TenderNedListingPage => ({
  ...page,
  content: page.content.map(coerceTenderNedIds),
});

const isLive = (options: TenderNedEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.TENDER_NED_LIVE === "1";

export const fetchListingEffect = (
  options: TenderNedEffectClientOptions,
  page: number,
  filters: TenderNedFilters
): Effect.Effect<TenderNedListingPage, ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "tenderned/listing-page-0.json";

  if (!isLive(options)) {
    if (page > 0) {
      return Effect.succeed({
        content: [],
        first: false,
        last: true,
        number: page,
        size: TENDER_NED_MAX_PAGE_SIZE,
        totalElements: 1,
        totalPages: 1,
      });
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load TenderNed listing fixture ${listingFixturePath}`,
        }),
      try: () => loadConnectorFixture<TenderNedListingPage>(listingFixturePath),
    }).pipe(Effect.map((fixture) => coerceListingPage(fixture.payload)));
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "tenderned",
    url: buildTenderNedListingUrl(page, filters, TENDER_NED_MAX_PAGE_SIZE),
  }).pipe(
    Effect.flatMap((response) => readJsonBody<TenderNedListingPage>(response)),
    Effect.map(coerceListingPage)
  );
};

export const fetchDetailEffect = (
  options: TenderNedEffectClientOptions,
  publicatieId: string
): Effect.Effect<TenderNedDetail, ReadIoFault> => {
  const detailFixtures = options.detailFixtures ?? {
    "fixture-pub-001": "tenderned/detail-pub-001.json",
  };

  if (!isLive(options)) {
    const relativePath = detailFixtures[publicatieId];
    if (!relativePath) {
      return Effect.fail(
        new ValidationFault({
          message: `Missing TenderNed detail fixture for ${publicatieId}`,
        })
      );
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load TenderNed detail fixture ${relativePath}`,
        }),
      try: () => loadConnectorFixture<TenderNedDetail>(relativePath),
    }).pipe(Effect.map((fixture) => coerceTenderNedIds(fixture.payload)));
  }

  const baseUrl = options.baseUrl ?? LISTING_BASE;
  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "tenderned",
    url: `${baseUrl}/${publicatieId}`,
  }).pipe(
    Effect.flatMap((response) => readJsonBody<TenderNedDetail>(response)),
    Effect.map(coerceTenderNedIds)
  );
};

/** Effect-backed TenderNed client. Production default remains native. */
export const createTenderNedEffectClient = (
  options: TenderNedEffectClientOptions = {}
): TenderNedClient => ({
  fetchDetail: (publicatieId) =>
    runReadIoPromise(fetchDetailEffect(options, publicatieId), {
      signal: options.signal,
    }),
  fetchListing: (page, filters) =>
    runReadIoPromise(fetchListingEffect(options, page, filters), {
      signal: options.signal,
    }),
});
