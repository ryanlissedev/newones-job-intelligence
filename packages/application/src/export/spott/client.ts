import { SpottApiError } from "./errors";
import { loadSpottFixture } from "./fixtures";
import { SpottRateLimitError } from "./rate-limit-error";
import type {
  SpottCreateVacancyRequest,
  SpottCreateVacancyResponse,
  SpottListVacanciesParams,
  SpottListVacanciesResponse,
  SpottVacancyDetail,
} from "./types";
import { SPOTT_API_BASE_URL, SPOTT_API_KEY_HEADER } from "./types";

export { SpottApiError } from "./errors";
export { SpottRateLimitError } from "./rate-limit-error";

export interface SpottClient {
  getVacancy: (id: string) => Promise<SpottVacancyDetail>;
  listVacancies: (
    params?: SpottListVacanciesParams
  ) => Promise<SpottListVacanciesResponse>;
}

export type SpottFetchImpl = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const fixtureCreateCounter = { next: 1 };

export interface SpottClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: SpottFetchImpl;
  fixtureVacancyRegistry?: Map<string, SpottVacancyDetail>;
  listFixturePath?: string;
  liveEnabled?: boolean;
  vacancyFixturePath?: string;
}

const nextFixtureVacancyId = (): string => {
  const id = `spott-fixture-${String(fixtureCreateCounter.next).padStart(6, "0")}`;
  fixtureCreateCounter.next += 1;
  return id;
};

const authHeaders = (apiKey: string) =>
  ({
    [SPOTT_API_KEY_HEADER]: apiKey,
    Accept: "application/json",
  }) as const;

const readJson = async <Payload>(response: Response): Promise<Payload> => {
  if (response.status === 429) {
    throw new SpottRateLimitError();
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new SpottApiError(
      `Spott request failed with status ${response.status}: ${detail}`,
      response.status
    );
  }
  // SAFETY: Spott REST responses match the typed DTOs validated in fixture tests.
  return (await response.json()) as Payload;
};

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

const resolveApiKey = (apiKey: string | undefined): string => {
  const resolved = apiKey ?? process.env.SPOTT_API_KEY?.trim();
  if (!resolved) {
    throw new Error(
      "SPOTT_API_KEY is required for live Spott requests. Set it in apps/server/.env."
    );
  }
  return resolved;
};

export const createSpottClient = (
  options: SpottClientOptions = {}
): SpottClient => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const liveEnabled = options.liveEnabled ?? process.env.SPOTT_LIVE === "1";
  const baseUrl = options.baseUrl ?? SPOTT_API_BASE_URL;
  const listFixturePath = options.listFixturePath ?? "vacancies-page-0.json";
  const vacancyFixturePath =
    options.vacancyFixturePath ?? "vacancy-fixture-001.json";
  const fixtureVacancyRegistry =
    options.fixtureVacancyRegistry ?? new Map<string, SpottVacancyDetail>();

  return {
    getVacancy: async (id) => {
      if (!liveEnabled) {
        const fromRegistry = fixtureVacancyRegistry.get(id);
        if (fromRegistry) {
          return fromRegistry;
        }

        const fixture =
          await loadSpottFixture<SpottVacancyDetail>(vacancyFixturePath);
        if (fixture.payload.id !== id) {
          throw new SpottApiError(`Vacancy not found: ${id}`, 404);
        }
        return fixture.payload;
      }

      const response = await fetchImpl(buildVacancyUrl(baseUrl, id), {
        headers: authHeaders(resolveApiKey(options.apiKey)),
        method: "GET",
      });
      return readJson<SpottVacancyDetail>(response);
    },

    listVacancies: async (params = {}) => {
      if (!liveEnabled) {
        if (params.cursor) {
          return {
            items: [],
            pageInfo: { hasNextPage: false, nextCursor: null },
          };
        }
        const fixture =
          await loadSpottFixture<SpottListVacanciesResponse>(listFixturePath);
        return fixture.payload;
      }

      const response = await fetchImpl(buildListUrl(baseUrl, params), {
        headers: authHeaders(resolveApiKey(options.apiKey)),
        method: "GET",
      });
      return readJson<SpottListVacanciesResponse>(response);
    },
  };
};

export type SpottWriteClient = SpottClient & {
  createVacancy: (
    input: SpottCreateVacancyRequest
  ) => Promise<SpottCreateVacancyResponse>;
};

export const createSpottWriteClient = (
  options: SpottClientOptions = {}
): SpottWriteClient => {
  const fixtureVacancyRegistry =
    options.fixtureVacancyRegistry ?? new Map<string, SpottVacancyDetail>();
  const baseClient = createSpottClient({
    ...options,
    fixtureVacancyRegistry,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const liveEnabled = options.liveEnabled ?? process.env.SPOTT_LIVE === "1";
  const baseUrl = options.baseUrl ?? SPOTT_API_BASE_URL;

  return {
    ...baseClient,
    createVacancy: async (input) => {
      if (!liveEnabled) {
        const id = nextFixtureVacancyId();
        fixtureVacancyRegistry.set(id, {
          companyId: input.companyId,
          description: input.description,
          id,
          name: input.name,
          restricted: false,
          stageId: input.stageId,
        });
        return { id };
      }

      const response = await fetchImpl(`${baseUrl}/vacancies`, {
        body: JSON.stringify(input),
        headers: {
          ...authHeaders(resolveApiKey(options.apiKey)),
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      return readJson<SpottCreateVacancyResponse>(response);
    },
  };
};
