import { describe, expect, it } from "bun:test";

import {
  buildOverviewSearchRequest,
  createOverviewSnapshot,
  getOverviewStatus,
} from "./overview-contract";
import type { JobSearchResponse } from "./types";

const emptyFacets = {
  contractTypes: [],
  locations: [],
  sources: [],
  status: [],
} as const;

const response = (
  overrides: Partial<JobSearchResponse> = {}
): JobSearchResponse => ({
  archiveTotal: 4,
  complete: true,
  facets: emptyFacets,
  items: [],
  message: null,
  page: 1,
  pageSize: 1,
  status: "ready",
  total: 19,
  totalPages: 19,
  ...overrides,
});

describe("overview data contract", () => {
  it("requests one page while leaving the engine total and facets authoritative", () => {
    const request = buildOverviewSearchRequest();

    expect(request.pageSize).toBe(1);
    expect(request.page).toBe(1);
    expect(request.scope).toBe("active");
    expect(request.query).toBe("");
  });

  it("uses the true total instead of counting the paginated items", () => {
    const snapshot = createOverviewSnapshot(response(), []);

    expect(snapshot?.total).toBe(19);
    expect(snapshot?.archiveTotal).toBe(4);
  });

  it("does not show incomplete engine output as a ready overview", () => {
    const incomplete = response({ complete: false, status: "ready" });

    expect(getOverviewStatus(incomplete)).toBe("error");
    expect(createOverviewSnapshot(incomplete, [])).toBeNull();
  });

  it("reports an empty but complete search separately", () => {
    const empty = response({ items: [], status: "empty", total: 0 });

    expect(getOverviewStatus(empty)).toBe("empty");
    expect(createOverviewSnapshot(empty, [])?.total).toBe(0);
  });
});
