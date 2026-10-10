import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

process.env.NEXT_PUBLIC_SERVER_URL ??= "http://server.test";

const { createRestJobDataAdapter } = await import("./rest-job-data-adapter");
const { parseJobSearchState } = await import("./search-state");
const { JOB_PAGE_SIZE } = await import("./types");

const BRON_ID = "00000000-0000-4000-8000-000000000001";
const SEARCH_RESULT_COUNT = 100;
const WINDOW_LIMIT = 1000;

// RJC-368: the bron register has grown well past the 4 names that used to be
// hardcoded in the web UI (see packages/application/src/sources/index.ts).
// This list stands in for "however many bronnen are registered" -- the
// filter list must track it, not a fixed count baked into the UI.
const REGISTERED_BRONNEN = [
  { actief: true, bronId: "bron-bluetrail", naam: "Bluetrail" },
  { actief: true, bronId: "bron-ctm", naam: "CTM" },
  { actief: true, bronId: "bron-flinter", naam: "Flinter" },
  { actief: true, bronId: "bron-harveynash", naam: "Harvey Nash" },
  { actief: true, bronId: "bron-hero", naam: "Hero" },
  { actief: true, bronId: "bron-inhuurdesk", naam: "Inhuurdesk" },
  { actief: true, bronId: "bron-needstaffing", naam: "Needstaffing" },
  { actief: true, bronId: "bron-onefellow", naam: "One Fellow" },
  { actief: true, bronId: "bron-opdrachtoverheid", naam: "Opdrachtoverheid" },
  { actief: true, bronId: "bron-striive", naam: "Striive" },
  { actief: true, bronId: BRON_ID, naam: "TenderNed" },
  // Historical rows retain their original source, so inactive catalog entries
  // remain valid archive filters even when they no longer ingest new work.
  { actief: false, bronId: "bron-pro-act", naam: "Pro-Act" },
] as const;

const searchIds = Array.from(
  { length: SEARCH_RESULT_COUNT },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
);

interface RecordedRequest {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

const searchBodySchema = z.object({
  filters: z
    .object({
      locatie: z.array(z.string()).optional(),
      locatieLand: z.array(z.string()).optional(),
    })
    .optional(),
  limit: z.number(),
  offset: z.number(),
  query: z.string(),
  scope: z.enum(["active", "all"]).optional(),
  sort: z.string(),
});
const ARCHIVE_TOTAL = 7;

// Recording fake server: counts every HTTP round-trip a search performs so a
// return of the per-id hydration loop (RJC-379) fails this suite loudly, and
// serves exactly the requested offset/limit window out of `searchTotal` ids
// so any client-side slicing (RJC-378) shows up as a wrong page.
const recordedRequests: RecordedRequest[] = [];
let failBatch = false;
let searchTotal = SEARCH_RESULT_COUNT;
let searchEmptyReason: "no_results" | "query_timeout" | null = null;
let searchIncomplete = false;
let bronnenResponse: readonly (typeof REGISTERED_BRONNEN)[number][] = [
  { actief: true, bronId: BRON_ID, naam: "TenderNed" },
];

const fakeFetch = (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const method =
    (input instanceof Request ? input.method : init?.method) ?? "GET";
  const rawBody = z.string().safeParse(init?.body);
  const body: unknown = rawBody.success ? JSON.parse(rawBody.data) : null;
  recordedRequests.push({ body, method, path: url.pathname });

  if (url.pathname === "/v1/bronnen") {
    return Promise.resolve(Response.json(bronnenResponse));
  }
  if (url.pathname === "/v1/aanvragen/search") {
    const search = searchBodySchema.parse(body);
    if (search.offset + search.limit > WINDOW_LIMIT) {
      return Promise.resolve(
        Response.json(
          { error: { code: "INVALID_INPUT", message: "offset + limit" } },
          { status: 400 }
        )
      );
    }
    const allIds = Array.from({ length: searchTotal }, (_, index) =>
      searchIds[index % SEARCH_RESULT_COUNT]?.replace(
        /^0000/u,
        String(Math.floor(index / SEARCH_RESULT_COUNT)).padStart(4, "0")
      )
    ).filter((id): id is string => id !== undefined);
    // RJC-383: the API only counts the archive for the active scope.
    const archiveCount =
      search.scope === "all" ? {} : { archiveTotal: ARCHIVE_TOTAL };
    return Promise.resolve(
      Response.json({
        ...archiveCount,
        emptyReason: searchEmptyReason,
        facets: {
          bron_id: [],
          contracttype: [],
          // RJC-394: ENRICHED_SEARCH_DATA_AVAILABLE is on, so the UI reads
          // the `locatie` bucket; `locatie_land` stays populated too since a
          // real engine indexes both.
          locatie: [{ count: searchTotal, value: "NL" }],
          locatie_land: [{ count: searchTotal, value: "NL" }],
          provincie: [],
          skills: [],
          status: [],
        },
        ids: allIds.slice(search.offset, search.offset + search.limit),
        incomplete: searchIncomplete,
        scope: search.scope ?? "active",
        total: searchTotal,
        windowLimit: WINDOW_LIMIT,
      })
    );
  }
  if (url.pathname === "/v1/aanvragen/batch") {
    if (failBatch) {
      return Promise.resolve(
        Response.json(
          {
            error: { code: "INTERNAL_ERROR", message: "batch exploded" },
          },
          { status: 500 }
        )
      );
    }
    const parsedBody = z.object({ ids: z.array(z.string()) }).safeParse(body);
    const ids = parsedBody.success ? parsedBody.data.ids : [];
    return Promise.resolve(
      Response.json({
        items: ids.map((id) => ({
          aanvraag: {
            beschrijving: `Beschrijving ${id}`,
            bronId: BRON_ID,
            bronReferentie: `TN-${id}`,
            id,
            mode: "preview",
            rawPayloadRef: `raw/${id}.json`,
            scrapeRunId: "run-1",
            status: "active",
            titel: `Titel ${id}`,
          },
          id,
          markering: null,
          versies: [
            {
              geldigTot: null,
              geldigVan: "2026-08-01T00:00:00.000Z",
              id: `versie-${id}`,
              normalisatieversie: "1",
              scrapeRunId: "run-1",
            },
          ],
        })),
      })
    );
  }
  return Promise.resolve(
    Response.json({
      error: { code: "NOT_FOUND", message: `Unexpected route ${url.pathname}` },
    })
  );
};

const originalFetch = globalThis.fetch;

describe("search hydration call count (RJC-379)", () => {
  beforeAll(() => {
    // SAFETY: the adapter only calls fetch(url, init) and reads json(); the
    // fake covers exactly that surface for the routes under test.
    globalThis.fetch = fakeFetch as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("hydrates a full page in O(1) HTTP calls, not per id", async () => {
    recordedRequests.length = 0;
    const adapter = createRestJobDataAdapter({
      baseUrl: "http://server.test",
    });
    const state = parseJobSearchState(new URLSearchParams("q=Azure"));

    const response = await adapter.search(state);

    expect(response.status).toBe("ready");
    expect(response.total).toBe(SEARCH_RESULT_COUNT);
    // RJC-378: only the displayed page is hydrated, never the full window.
    expect(response.items).toHaveLength(JOB_PAGE_SIZE);

    // Exactly: 1x bron catalog + 1x search + 1x batch hydration. The old
    // per-id loop issued 2 GETs per hit (200 extra calls for 100 hits) and
    // would fail both assertions below.
    expect(recordedRequests).toHaveLength(3);
    const perIdCalls = recordedRequests.filter(
      (request) =>
        request.method === "GET" &&
        /^\/v1\/aanvragen\/[^/]+(?:\/versies)?$/u.test(request.path)
    );
    expect(perIdCalls).toHaveLength(0);
    expect(
      recordedRequests.filter(
        (request) => request.path === "/v1/aanvragen/batch"
      )
    ).toHaveLength(1);
    expect(
      recordedRequests.find((request) => request.path === "/v1/aanvragen/batch")
        ?.body
    ).not.toHaveProperty("full");
  });

  it("renders a failed batch call as engine-error, never as an empty result", async () => {
    recordedRequests.length = 0;
    failBatch = true;
    try {
      const adapter = createRestJobDataAdapter({
        baseUrl: "http://server.test",
      });
      const state = parseJobSearchState(new URLSearchParams("q=Azure"));

      const response = await adapter.search(state);

      // A server/network failure during hydration must NOT look like a
      // legitimate "no results" outcome (RJC-380 failure class): the user
      // must see a retry message, not "Geen vacatures gevonden".
      expect(response.status).toBe("engine-error");
      expect(response.message).toBe(
        "De zoekmachine reageert niet. Probeer het over een moment opnieuw."
      );
      expect(response.items).toHaveLength(0);
    } finally {
      failBatch = false;
    }
  });
});

describe("incomplete timeout results (RJC-431)", () => {
  beforeAll(() => {
    // SAFETY: this adapter only uses the standard fetch surface implemented
    // by the deterministic fake server above.
    globalThis.fetch = fakeFetch as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    searchEmptyReason = null;
    searchIncomplete = false;
    searchTotal = SEARCH_RESULT_COUNT;
  });

  it("marks partial hits incomplete while retaining the visible rows", async () => {
    searchIncomplete = true;
    searchTotal = 3;
    const adapter = createRestJobDataAdapter({ baseUrl: "http://server.test" });

    const response = await adapter.search(parseJobSearchState({ q: "Azure" }));

    expect(response.complete).toBe(false);
    expect(response.status).toBe("ready");
    expect(response.items).toHaveLength(3);
  });

  it("honors query_timeout compatibility for zero hits", async () => {
    searchEmptyReason = "query_timeout";
    searchTotal = 0;
    const adapter = createRestJobDataAdapter({ baseUrl: "http://server.test" });

    const response = await adapter.search(parseJobSearchState({}));

    expect(response.complete).toBe(false);
    expect(response.status).toBe("empty");
    expect(response.items).toHaveLength(0);
  });
});

// RJC-378: sort, location filter and pagination are the engine's job. The
// adapter sends them and trusts the returned page and total; it never slices,
// re-sorts or re-filters, and derives the page count from the true total
// capped by the retrievable window.
describe("server-side sort, filter and pagination (RJC-378)", () => {
  beforeAll(() => {
    // SAFETY: the adapter only calls fetch(url, init) and reads json(); the
    // fake covers exactly that surface for the routes under test.
    globalThis.fetch = fakeFetch as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    searchTotal = SEARCH_RESULT_COUNT;
  });

  const search = (params: string) =>
    createRestJobDataAdapter({
      baseUrl: "http://server.test",
    }).search(parseJobSearchState(new URLSearchParams(params)));

  const lastSearchBody = () =>
    searchBodySchema.parse(
      recordedRequests.findLast(
        (request) => request.path === "/v1/aanvragen/search"
      )?.body
    );

  it("sends sort, offset/limit for the requested page and the location filter", async () => {
    recordedRequests.length = 0;
    searchTotal = 300;

    const response = await search(
      "q=Azure&sort=newest&page=3&location=Nederland"
    );

    expect(lastSearchBody()).toEqual({
      // RJC-394: ENRICHED_SEARCH_DATA_AVAILABLE is on, so the location
      // filter now sends the `locatie` key.
      filters: { locatie: ["NL"] },
      limit: JOB_PAGE_SIZE,
      offset: JOB_PAGE_SIZE * 2,
      query: "Azure",
      sort: "newest",
    });
    expect(response.page).toBe(3);
    expect(response.items).toHaveLength(JOB_PAGE_SIZE);
    // The hydrated ids are exactly the server's page, in server order.
    const hydrated = z
      .object({ ids: z.array(z.string()) })
      .parse(
        recordedRequests.find(
          (request) => request.path === "/v1/aanvragen/batch"
        )?.body
      ).ids;
    expect(response.items.map((item) => item.id)).toEqual(hydrated);
    expect(response.facets.locations).toEqual([
      { count: 300, value: "Nederland" },
    ]);
  });

  it("defaults to the active partition and surfaces the archive count; the toggle sends scope=all (RJC-383)", async () => {
    recordedRequests.length = 0;
    searchTotal = 12;

    const active = await search("q=Azure");
    expect(lastSearchBody().scope).toBeUndefined();
    expect(active.archiveTotal).toBe(ARCHIVE_TOTAL);

    const all = await search("q=Azure&archief=1");
    expect(lastSearchBody().scope).toBe("all");
    expect(all.archiveTotal).toBeNull();
  });

  it("derives totalPages from the true total, not a fixed hit window", async () => {
    recordedRequests.length = 0;
    searchTotal = 300;

    const response = await search("q=Azure");

    expect(response.total).toBe(300);
    expect(response.totalPages).toBe(Math.ceil(300 / JOB_PAGE_SIZE));
  });

  it("caps totalPages at the retrievable window when the total exceeds it", async () => {
    recordedRequests.length = 0;
    searchTotal = 3000;

    const response = await search("q=Azure");

    expect(response.total).toBe(3000);
    expect(response.totalPages).toBe(Math.floor(WINDOW_LIMIT / JOB_PAGE_SIZE));
  });

  it("falls back to the last page once when the requested page is past the end", async () => {
    recordedRequests.length = 0;
    searchTotal = 20;

    const response = await search("q=Azure&page=9");

    // Default page size is 50 (CTP-509), so 20 hits fit on a single page.
    expect(response.page).toBe(1);
    expect(response.items).toHaveLength(20);
    expect(
      recordedRequests.filter(
        (request) => request.path === "/v1/aanvragen/search"
      )
    ).toHaveLength(2);
  });

  it("does not rewrite an incomplete empty page as a stale complete page", async () => {
    recordedRequests.length = 0;
    searchIncomplete = true;
    searchTotal = 0;
    try {
      const response = await search("q=Azure&page=9");

      expect(response.complete).toBe(false);
      expect(response.page).toBe(9);
      expect(response.items).toHaveLength(0);
      expect(
        recordedRequests.filter(
          (request) => request.path === "/v1/aanvragen/search"
        )
      ).toHaveLength(1);
    } finally {
      searchIncomplete = false;
    }
  });

  it("explains a page beyond the window instead of showing an engine error", async () => {
    recordedRequests.length = 0;
    searchTotal = 3000;

    const response = await search("q=Azure&page=200");

    expect(response.status).toBe("empty");
    expect(response.message).toContain("Verfijn je zoekopdracht");
    expect(response.page).toBe(200);
  });
});

describe("bron filter list derives from the API (RJC-368)", () => {
  beforeAll(() => {
    // SAFETY: the adapter only calls fetch(url, init) and reads json(); the
    // fake covers exactly that surface for the routes under test.
    globalThis.fetch = fakeFetch as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("includes every catalog source so historical rows remain filterable", async () => {
    bronnenResponse = REGISTERED_BRONNEN;
    try {
      const adapter = createRestJobDataAdapter({
        baseUrl: "http://server.test",
      });

      const sources = await adapter.listSources();

      expect(sources).toHaveLength(REGISTERED_BRONNEN.length);
      expect(sources.length).toBeGreaterThan(4);
      expect(new Set(sources.map((source) => source.value)).size).toBe(
        REGISTERED_BRONNEN.length
      );
      expect(sources).toContainEqual({ label: "Pro-Act", value: "pro-act" });
    } finally {
      bronnenResponse = [{ actief: true, bronId: BRON_ID, naam: "TenderNed" }];
    }
  });
});
