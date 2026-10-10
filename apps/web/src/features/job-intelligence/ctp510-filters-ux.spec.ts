import { describe, expect, it } from "bun:test";

import { countActiveJobFilters } from "./job-filters";
import { mapApiFiltersToUi, mapUiFiltersToApi } from "./rest/filter-mapping";
import { resetJobSearchState } from "./search-state";
import { DEFAULT_JOB_SEARCH_STATE, JOB_PAGE_SIZE_OPTIONS } from "./types";

describe("CTP-510 filter UX helpers", () => {
  it("includes 25 in page size options", () => {
    expect(JOB_PAGE_SIZE_OPTIONS).toContain(25);
  });

  it("resetJobSearchState clears filters while callers can keep query draft separately", () => {
    const reset = resetJobSearchState();
    expect(reset.query).toBe("");
    expect(reset.filters).toEqual(DEFAULT_JOB_SEARCH_STATE.filters);
    expect(countActiveJobFilters(reset.filters)).toBe(0);
  });

  it("round-trips saved-search API filters for contract/status/rate", () => {
    const bronCatalog = new Map([
      ["bron-1", { bronId: "bron-1", naam: "Flextender" }],
    ]);
    const ui = {
      ...DEFAULT_JOB_SEARCH_STATE.filters,
      contractTypes: ["interim" as const],
      maxRate: 120,
      minRate: 80,
      sources: ["flextender"],
      status: ["active" as const],
    };
    const api = mapUiFiltersToApi(ui, bronCatalog);
    const back = mapApiFiltersToUi(api, bronCatalog);
    expect(back.contractTypes).toEqual(["interim"]);
    expect(back.status).toEqual(["active"]);
    expect(back.minRate).toBe(80);
    expect(back.maxRate).toBe(120);
    expect(back.sources).toEqual(["flextender"]);
  });
});
