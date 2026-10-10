import type { FetchImpl, ReadIoFault } from "@ji/connectors/effect-runtime";
import {
  AuthFault,
  httpRequest,
  NotFoundFault,
  readJsonBody,
  runReadIoPromise,
  ValidationFault,
} from "@ji/connectors/effect-runtime";
import { Effect } from "effect";

import type { SpottClient } from "./client";
import { loadSpottFixture } from "./fixtures";
import type {
  SpottListVacanciesParams,
  SpottListVacanciesResponse,
  SpottVacancyDetail,
} from "./types";
import { SPOTT_API_BASE_URL, SPOTT_API_KEY_HEADER } from "./types";

export interface SpottEffectClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  fixtureVacancyRegistry?: Map<string, SpottVacancyDetail>;
  listFixturePath?: string;
  liveEnabled?: boolean;
  signal?: AbortSignal;
  vacancyFixturePath?: string;
}

const authHeaders = (apiKey: string) =>
  ({
    [SPOTT_API_KEY_HEADER]: apiKey,
    Accept: "application/json",
  }) as const;

const buildVacancyUrl = (baseUrl: string, id: string): string =>
  `${baseUrl}/vacancies/${encodeURIComponent(id)}`;

const buildListUrl = (
  baseUrl: string,
  params: SpottListVacanciesParams = {}
): string => {
  const url = new URL(`${baseUrl}/vacancies`);
  if (params.cursor !== undefined) {
    url.searchParams.set("cursor", params.cursor);
  }
  if (params.limit !== undefined) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.modifiedSince !== undefined) {
    url.searchParams.set("modifiedSince", params.modifiedSince);
  }
  if (params.modifiedUntil !== undefined) {
    url.searchParams.set("modifiedUntil", params.modifiedUntil);
  }
  return url.toString();
};

const resolveApiKey = (
  apiKey: string | undefined
): Effect.Effect<string, ReadIoFault> => {
  const resolved = apiKey ?? process.env.SPOTT_API_KEY?.trim();
  if (!resolved) {
    return Effect.fail(
      new AuthFault({
        message:
          "SPOTT_API_KEY is required for live Spott requests. Set it in apps/server/.env.",
      })
    );
  }
  return Effect.succeed(resolved);
};

const isLive = (options: SpottEffectClientOptions): boolean =>
  options.liveEnabled ?? process.env.SPOTT_LIVE === "1";

export const listVacanciesEffect = (
  options: SpottEffectClientOptions,
  params: SpottListVacanciesParams = {}
): Effect.Effect<SpottListVacanciesResponse, ReadIoFault> => {
  const baseUrl = options.baseUrl ?? SPOTT_API_BASE_URL;
  const listFixturePath = options.listFixturePath ?? "vacancies-page-0.json";

  if (!isLive(options)) {
    if (params.cursor) {
      return Effect.succeed({
        items: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Spott list fixture ${listFixturePath}`,
        }),
      try: () => loadSpottFixture<SpottListVacanciesResponse>(listFixturePath),
    }).pipe(Effect.map((fixture) => fixture.payload));
  }

  return resolveApiKey(options.apiKey).pipe(
    Effect.flatMap((apiKey) =>
      httpRequest({
        fetchImpl: options.fetchImpl,
        init: {
          headers: authHeaders(apiKey),
          method: "GET",
        },
        url: buildListUrl(baseUrl, params),
      })
    ),
    Effect.flatMap((response) =>
      readJsonBody<SpottListVacanciesResponse>(response)
    )
  );
};

export const getVacancyEffect = (
  options: SpottEffectClientOptions,
  id: string
): Effect.Effect<SpottVacancyDetail, ReadIoFault> => {
  const baseUrl = options.baseUrl ?? SPOTT_API_BASE_URL;
  const vacancyFixturePath =
    options.vacancyFixturePath ?? "vacancy-fixture-001.json";
  const fixtureVacancyRegistry =
    options.fixtureVacancyRegistry ?? new Map<string, SpottVacancyDetail>();

  if (!isLive(options)) {
    const fromRegistry = fixtureVacancyRegistry.get(id);
    if (fromRegistry) {
      return Effect.succeed(fromRegistry);
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ValidationFault({
          cause,
          message: `Failed to load Spott vacancy fixture ${vacancyFixturePath}`,
        }),
      try: () => loadSpottFixture<SpottVacancyDetail>(vacancyFixturePath),
    }).pipe(
      Effect.flatMap((fixture) => {
        if (fixture.payload.id !== id) {
          return Effect.fail(
            new NotFoundFault({
              message: `Vacancy not found: ${id}`,
              status: 404,
            })
          );
        }
        return Effect.succeed(fixture.payload);
      })
    );
  }

  return resolveApiKey(options.apiKey).pipe(
    Effect.flatMap((apiKey) =>
      httpRequest({
        fetchImpl: options.fetchImpl,
        init: {
          headers: authHeaders(apiKey),
          method: "GET",
        },
        url: buildVacancyUrl(baseUrl, id),
      })
    ),
    Effect.flatMap((response) => readJsonBody<SpottVacancyDetail>(response))
  );
};

/**
 * Effect-backed Spott read client (list/get only). Write/POST stays native.
 * Production default remains native `createSpottClient` (Effect path opt-in).
 */
export const createSpottEffectClient = (
  options: SpottEffectClientOptions = {}
): SpottClient => ({
  getVacancy: (id) =>
    runReadIoPromise(getVacancyEffect(options, id), {
      signal: options.signal,
    }),
  listVacancies: (params) =>
    runReadIoPromise(listVacanciesEffect(options, params), {
      signal: options.signal,
    }),
});
