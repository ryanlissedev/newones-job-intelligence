export const SPOTT_API_BASE_URL = "https://api.gospott.com";

export const SPOTT_API_KEY_HEADER = "x-api-key";

export const SPOTT_RATE_LIMIT_PER_MINUTE = 600;

export const SPOTT_MCP_URL = "https://mcp.spott.io/mcp";

export interface SpottCursorPageInfo {
  hasNextPage: boolean;
  nextCursor: string | null;
}

export interface SpottVacancySummary {
  id: string;
  name: string;
  description: string | null;
  restricted: boolean;
}

export interface SpottListVacanciesResponse {
  items: SpottVacancySummary[];
  pageInfo: SpottCursorPageInfo;
}

export interface SpottVacancyDetail extends SpottVacancySummary {
  companyId: string;
  stageId: string;
}

export interface SpottListVacanciesParams {
  cursor?: string;
  limit?: number;
  modifiedSince?: string;
  modifiedUntil?: string;
}

export interface SpottCreateVacancyRequest {
  clientContactIds: string[];
  companyId: string;
  description: string | null;
  employmentType:
    | "contract"
    | "fixedTermContract"
    | "fullTime"
    | "interimOrTemporary"
    | "internship"
    | "partTime"
    | "permanent"
    | "temporary"
    | null;
  endAt: string | null;
  location: unknown | null;
  locationType: "hybrid" | "onsite" | "remote" | null;
  name: string;
  salaryRange: unknown | null;
  stageId: string;
  startAt: string | null;
  targetCompanyId: string | null;
  teamUserIds: string[];
}

export interface SpottCreateVacancyResponse {
  id: string;
}
