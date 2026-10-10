import type {
  JobSearchFacets,
  JobSearchRequest,
  JobSearchResponse,
  JobSourceOption,
} from "./types";
import { DEFAULT_JOB_SEARCH_STATE } from "./types";

export type OverviewStatus = "error" | "empty" | "loading" | "ready";

export interface OverviewSnapshot {
  readonly archiveTotal: number | null;
  readonly facets: JobSearchFacets;
  readonly sources: readonly JobSourceOption[];
  readonly total: number;
}

/**
 * The overview asks the search capability for one cheap page, then uses only
 * its engine supplied total and facets. The page items are intentionally not
 * used for overview metrics: they are a paginated window, never a global
 * count.
 */
export const buildOverviewSearchRequest = (): JobSearchRequest => ({
  ...DEFAULT_JOB_SEARCH_STATE,
  page: 1,
  pageSize: 1,
  selectedJobId: null,
});

export const getOverviewStatus = (
  response: JobSearchResponse
): OverviewStatus => {
  if (
    !response.complete ||
    response.status === "engine-error" ||
    response.status === "syntax-error"
  ) {
    return "error";
  }
  return response.total === 0 ? "empty" : "ready";
};

export const createOverviewSnapshot = (
  response: JobSearchResponse,
  sources: readonly JobSourceOption[]
): OverviewSnapshot | null =>
  getOverviewStatus(response) === "error"
    ? null
    : {
        archiveTotal: response.archiveTotal,
        facets: response.facets,
        sources,
        total: response.total,
      };
