import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import { SEARCH_DOCUMENT_PARITY_DEFAULTS } from "@ji/search";

import { invokeMcpTool } from "../../../../server/src/capabilities/rest";
import { buildBronCatalog } from "./rest/bron-catalog";
import {
  buildSearchRequestBody,
  buildSnapshotBody,
  mapApiFacetsToUi,
  mapUiFiltersToApi,
} from "./rest/filter-mapping";
import { parseJobSearchState } from "./search-state";

const recruiterAuth = {
  principal: {
    kind: "agent" as const,
    permissions: permissionsForRole("recruiter"),
    subjectId: "ui-recruiter",
  },
  requestId: "req-ui-search",
};

describe("REST search request mapping", () => {
  it("maps shareable UI filters to U7 search filters", () => {
    const bronCatalog = buildBronCatalog([
      {
        bronId: "00000000-0000-4000-8000-000000000001",
        naam: "TenderNed",
      },
      {
        bronId: "00000000-0000-4000-8000-000000000002",
        naam: "Inhuurdesk",
      },
    ]);
    const state = parseJobSearchState(
      new URLSearchParams(
        "q=Azure&source=tenderned&contract=detachering&status=closed&freshness=7d&minRate=90&location=Nederland&sort=newest"
      )
    );

    expect(mapUiFiltersToApi(state.filters, bronCatalog)).toEqual({
      bronIds: ["00000000-0000-4000-8000-000000000001"],
      contracttype: ["detachering"],
      freshnessDays: 7,
      // RJC-378/RJC-394: the UI label "Nederland" maps back to the indexed
      // `locatie` value now that the loader fills it.
      locatie: ["NL"],
      status: ["closed"],
      tariefMin: 90,
    });
    expect(
      buildSearchRequestBody({
        bronCatalog,
        filters: state.filters,
        limit: 8,
        offset: 16,
        query: state.query,
        sort: state.sort,
      })
    ).toEqual({
      filters: {
        bronIds: ["00000000-0000-4000-8000-000000000001"],
        contracttype: ["detachering"],
        freshnessDays: 7,
        locatie: ["NL"],
        status: ["closed"],
        tariefMin: 90,
      },
      limit: 8,
      offset: 16,
      query: "Azure",
      sort: "newest",
    });
  });

  it("sends scope only for the archive opt-in (RJC-383)", () => {
    const bronCatalog = buildBronCatalog([]);
    const state = parseJobSearchState(new URLSearchParams("q=Azure&archief=1"));
    expect(
      buildSearchRequestBody({
        bronCatalog,
        filters: state.filters,
        limit: 8,
        offset: 0,
        query: state.query,
        scope: state.scope,
        sort: state.sort,
      })
    ).toEqual({
      limit: 8,
      offset: 0,
      query: "Azure",
      scope: "all",
      sort: "relevance",
    });
    expect(
      buildSnapshotBody({
        bronCatalog,
        filters: state.filters,
        query: state.query,
        scope: state.scope,
        selectedIds: ["00000000-0000-4000-8000-000000000011"],
      })
    ).toEqual({
      filters: undefined,
      query: "Azure",
      scope: "all",
      selectedIds: ["00000000-0000-4000-8000-000000000011"],
    });
  });

  it("switches the location filter/facet key on ENRICHED_SEARCH_DATA_AVAILABLE (RJC-394)", () => {
    const bronCatalog = buildBronCatalog([]);
    const state = parseJobSearchState(
      new URLSearchParams("location=Nederland")
    );

    expect(mapUiFiltersToApi(state.filters, bronCatalog, true)).toEqual({
      locatie: ["NL"],
    });
    expect(mapUiFiltersToApi(state.filters, bronCatalog, false)).toEqual({
      locatieLand: ["NL"],
    });

    const facets = {
      bron_id: [],
      contracttype: [],
      locatie: [{ count: 3, value: "Amsterdam" }],
      locatie_land: [{ count: 9, value: "NL" }],
      provincie: [{ count: 4, value: "Utrecht" }],
      skills: [{ count: 5, value: "TypeScript" }],
      status: [{ count: 2, value: "closed" }],
    };
    expect(mapApiFacetsToUi(facets, bronCatalog, true).locations).toEqual([
      { count: 3, value: "Amsterdam" },
    ]);
    expect(mapApiFacetsToUi(facets, bronCatalog, false).locations).toEqual([
      { count: 9, value: "Nederland" },
    ]);
    expect(mapApiFacetsToUi(facets, bronCatalog).status).toEqual([
      { count: 2, value: "closed" },
    ]);
    expect(mapApiFacetsToUi(facets, bronCatalog).provincies).toEqual([
      { count: 4, value: "Utrecht" },
    ]);
    expect(mapApiFacetsToUi(facets, bronCatalog).skills).toEqual([
      { count: 5, value: "TypeScript" },
    ]);
    expect(
      mapApiFacetsToUi({ ...facets, provincie: [], skills: [] }, bronCatalog)
        .provincies
    ).toEqual([]);
    expect(
      mapApiFacetsToUi({ ...facets, provincie: [], skills: [] }, bronCatalog)
        .skills
    ).toEqual([]);
  });
});

describe("CTP-507 Motian filter mapping", () => {
  it("maps Motian-parity UI filters to SearchFilters keys", () => {
    const bronCatalog = buildBronCatalog([]);
    const state = parseJobSearchState(
      new URLSearchParams(
        "arrangement=hybride&province=Noord-Holland&skill=Python&minRate=90&maxRate=120&hoursMin=16&hoursMax=32&from=2026-07-01&to=2026-07-31&queryScope=all"
      )
    );

    expect(mapUiFiltersToApi(state.filters, bronCatalog)).toEqual({
      provincies: ["Noord-Holland"],
      publicatiedatumTot: "2026-07-31",
      publicatiedatumVanaf: "2026-07-01",
      skills: ["Python"],
      tariefMax: 120,
      tariefMin: 90,
      urenPerWeekMax: 32,
      urenPerWeekMin: 16,
      werkvormen: ["hybride"],
    });

    const defaultScope = parseJobSearchState(new URLSearchParams("minRate=50"));
    expect(mapUiFiltersToApi(defaultScope.filters, bronCatalog)).toEqual({
      tariefMin: 50,
    });

    const titleOnly = parseJobSearchState(
      new URLSearchParams("minRate=50&queryScope=title")
    );
    expect(mapUiFiltersToApi(titleOnly.filters, bronCatalog)).toEqual({
      queryScope: "title",
      tariefMin: 50,
    });
  });
});

describe("AE5 UI query parity with MCP search_aanvragen", () => {
  it("returns matching ids and total for the same mapped arguments", async () => {
    const bundle = createTestSliceARegistry();
    const aanvraagId = "00000000-0000-4000-8000-000000000011";
    await bundle.deps.engine.upsertDocument({
      ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
      beschrijving: "Azure kubernetes platform",
      bronId: "00000000-0000-4000-8000-000000000001",
      contracttype: "detachering",
      id: aanvraagId,
      laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
      locatieLand: "NL",
      status: "active",
      tariefMax: 110,
      tariefMin: 90,
      titel: "Azure engineer",
    });

    const bronCatalog = buildBronCatalog([
      {
        bronId: "00000000-0000-4000-8000-000000000001",
        naam: "TenderNed",
      },
    ]);
    const state = parseJobSearchState(
      new URLSearchParams("q=Azure&source=tenderned")
    );
    const uiRequest = buildSearchRequestBody({
      bronCatalog,
      filters: state.filters,
      limit: 20,
      offset: 0,
      query: state.query,
      sort: state.sort,
    });

    const rest = await bundle.registry.createInvoker({
      capabilityId: "search_aanvragen",
      operation: "POST /v1/aanvragen/search",
      transport: "rest",
    })(uiRequest, recruiterAuth);
    const mcp = await invokeMcpTool(
      bundle.registry,
      "search_aanvragen",
      uiRequest,
      recruiterAuth.principal,
      "req-ui-mcp"
    );

    expect(rest.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    if (!rest.ok || !mcp.ok) {
      return;
    }

    expect(mcp.value).toEqual(rest.value);
    expect(rest.value.ids).toEqual([aanvraagId]);
    expect(rest.value.total).toBe(1);
  });
});
