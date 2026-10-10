import { Effect } from "effect";

import type { FetchImpl, ReadIoFault } from "../effect-runtime";
import {
  httpRequest,
  mapHttpStatusToFault,
  readTextBody,
  runReadIoPromise,
  ValidationFault,
} from "../effect-runtime";
import { loadConnectorFixture } from "../fixtures/load";
import { resolveHttpTimeoutMs } from "../http-timeout";
import type {
  OpdrachtoverheidClient,
  OpdrachtoverheidClientOptions,
  OpdrachtoverheidListingPage,
} from "./client";
import {
  OPDRACHTOVERHEID_MAX_PAGE_BODY_BYTES,
  parseOpdrachtoverheidListing,
  readBoundedOpdrachtoverheidJson,
} from "./client";
import {
  OPDRACHTOVERHEID_SITE_BASE_URL,
  OPDRACHTOVERHEID_SITEMAP_PATH,
  parseOpdrachtoverheidDetailPage,
  parseOpdrachtoverheidSitemap,
} from "./ssr";
import type {
  OpdrachtoverheidDetailPage,
  OpdrachtoverheidSitemapEntry,
} from "./ssr";
import type { OpdrachtoverheidListingResponse } from "./types";
import {
  OPDRACHTOVERHEID_MAX_RECORDS,
  OPDRACHTOVERHEID_SEARCH_PATH,
} from "./types";

const DEFAULT_BASE_URL = "https://kbenp-match-api.azurewebsites.net";

export interface OpdrachtoverheidEffectClientOptions extends Omit<
  OpdrachtoverheidClientOptions,
  "fetchImpl"
> {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

const isLive = (options: OpdrachtoverheidEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.OPDRACHTOVERHEID_LIVE === "1";

const parseListingEffect = (
  body: OpdrachtoverheidListingResponse,
  live: boolean
): Effect.Effect<OpdrachtoverheidListingPage, ValidationFault> =>
  Effect.try({
    catch: (cause) =>
      new ValidationFault({
        cause,
        message: "Invalid Opdrachtoverheid listing response",
      }),
    try: () => {
      const listing = parseOpdrachtoverheidListing(body);
      return live ? { ...listing, hasMore: true } : listing;
    },
  });

const readListingEffect = (
  response: Response
): Effect.Effect<OpdrachtoverheidListingResponse, ValidationFault> =>
  Effect.tryPromise({
    catch: (cause) =>
      new ValidationFault({
        cause,
        message: "Invalid Opdrachtoverheid listing response",
        status: response.status,
      }),
    try: (signal) =>
      readBoundedOpdrachtoverheidJson<OpdrachtoverheidListingResponse>(
        response,
        signal
      ),
  });

export const fetchListingEffect = (
  options: OpdrachtoverheidEffectClientOptions,
  _page: number
): Effect.Effect<OpdrachtoverheidListingPage, ReadIoFault> => {
  const listingFixturePath =
    options.listingFixturePath ?? "opdrachtoverheid/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = resolveHttpTimeoutMs(options.timeoutMs);

  if (!isLive(options)) {
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Opdrachtoverheid listing fixture ${listingFixturePath}`,
        }),
      try: () =>
        loadConnectorFixture<OpdrachtoverheidListingResponse>(
          listingFixturePath
        ),
    }).pipe(
      Effect.flatMap((fixture) => parseListingEffect(fixture.payload, false))
    );
  }

  return httpRequest({
    fetchImpl: options.fetchImpl,
    init: {
      body: JSON.stringify({ limit: OPDRACHTOVERHEID_MAX_RECORDS, offset: 0 }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    sourceSlug: "opdrachtoverheid",
    url: `${baseUrl}${OPDRACHTOVERHEID_SEARCH_PATH}`,
  }).pipe(
    Effect.flatMap(readListingEffect),
    Effect.flatMap((body) => parseListingEffect(body, true)),
    Effect.timeout(timeoutMs),
    Effect.catchTag("TimeoutError", (cause) =>
      Effect.fail(
        new ValidationFault({
          cause,
          message: `Opdrachtoverheid listing timed out after ${timeoutMs}ms`,
        })
      )
    )
  );
};

const loadHtmlFixtureEffect = (
  fixturePath: string
): Effect.Effect<string, ValidationFault> =>
  Effect.tryPromise({
    catch: (cause) =>
      new ValidationFault({
        cause,
        message: `Failed to load Opdrachtoverheid fixture ${fixturePath}`,
      }),
    try: async () => {
      const fixture = await loadConnectorFixture<string>(fixturePath);
      return fixture.payload;
    },
  });

const readBoundedPageEffect = (
  response: Response,
  what: string
): Effect.Effect<string, ReadIoFault> =>
  readTextBody(response).pipe(
    Effect.flatMap((text) =>
      new TextEncoder().encode(text).byteLength >
      OPDRACHTOVERHEID_MAX_PAGE_BODY_BYTES
        ? Effect.fail(
            new ValidationFault({
              message: `Opdrachtoverheid ${what} response exceeds ${OPDRACHTOVERHEID_MAX_PAGE_BODY_BYTES} bytes`,
              status: response.status,
            })
          )
        : Effect.succeed(text)
    )
  );

export const fetchSitemapEffect = (
  options: OpdrachtoverheidEffectClientOptions
): Effect.Effect<OpdrachtoverheidSitemapEntry[], ReadIoFault> => {
  if (!isLive(options)) {
    const { sitemapFixturePath } = options;
    if (!sitemapFixturePath) {
      return Effect.succeed([]);
    }
    return loadHtmlFixtureEffect(sitemapFixturePath).pipe(
      Effect.map(parseOpdrachtoverheidSitemap)
    );
  }
  const siteBaseUrl = options.siteBaseUrl ?? OPDRACHTOVERHEID_SITE_BASE_URL;
  return httpRequest({
    fetchImpl: options.fetchImpl,
    sourceSlug: "opdrachtoverheid",
    url: `${siteBaseUrl}${OPDRACHTOVERHEID_SITEMAP_PATH}`,
  }).pipe(
    Effect.flatMap((response) => readBoundedPageEffect(response, "sitemap")),
    Effect.map(parseOpdrachtoverheidSitemap)
  );
};

export const fetchDetailEffect = (
  options: OpdrachtoverheidEffectClientOptions,
  entry: Pick<OpdrachtoverheidSitemapEntry, "detailUrl" | "webKey">
): Effect.Effect<OpdrachtoverheidDetailPage, ReadIoFault> => {
  if (!isLive(options)) {
    const fixturePath = options.detailFixturePaths?.[entry.webKey];
    if (!fixturePath) {
      return Effect.succeed({ jobPosting: null, tender: null });
    }
    return loadHtmlFixtureEffect(fixturePath).pipe(
      Effect.map((html) =>
        parseOpdrachtoverheidDetailPage(html, entry.detailUrl)
      )
    );
  }
  return httpRequest({
    fetchImpl: options.fetchImpl,
    mapHttpErrors: false,
    sourceSlug: "opdrachtoverheid",
    url: entry.detailUrl,
  }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404 || response.status === 410) {
        return Effect.succeed({ jobPosting: null, tender: null });
      }
      if (!response.ok) {
        return Effect.fail(
          mapHttpStatusToFault({
            message: `HTTP ${response.status} for ${entry.detailUrl}`,
            retryAfterHeader: response.headers.get("Retry-After"),
            status: response.status,
          })
        );
      }
      return readBoundedPageEffect(response, "detail").pipe(
        Effect.map((html) =>
          parseOpdrachtoverheidDetailPage(html, entry.detailUrl)
        )
      );
    })
  );
};

/** Effect-backed Opdrachtoverheid client. Production default remains native. */
export const createOpdrachtoverheidEffectClient = (
  options: OpdrachtoverheidEffectClientOptions = {}
): OpdrachtoverheidClient => ({
  fetchDetail: (entry) =>
    runReadIoPromise(fetchDetailEffect(options, entry), {
      signal: options.signal,
    }),
  fetchListing: (page) =>
    runReadIoPromise(fetchListingEffect(options, page), {
      signal: options.signal,
    }),
  fetchSitemap: () =>
    runReadIoPromise(fetchSitemapEffect(options), {
      signal: options.signal,
    }),
});
