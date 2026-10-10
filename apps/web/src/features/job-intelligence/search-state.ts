import { parseBooleanQuery } from "@ji/domain";
import type { BooleanNode } from "@ji/domain";

import {
  DEFAULT_JOB_QUERY_SCOPE,
  DEFAULT_JOB_SEARCH_STATE,
  ENRICHED_SEARCH_DATA_AVAILABLE,
  FRESHNESS_FILTERS,
  JOB_CONTRACT_TYPES,
  JOB_PAGE_SIZE,
  JOB_PAGE_SIZE_OPTIONS,
  JOB_QUERY_SCOPES,
  JOB_SEARCH_STATUS_VALUES,
  JOB_WERKVORMEN,
  PREVIEW_STATUSES,
  selectableJobSortOptions,
} from "./types";
import type {
  FacetCount,
  FreshnessFilter,
  JobListing,
  JobPageSize,
  JobQueryScope,
  JobSearchRequest,
  JobSearchResponse,
  JobSearchState,
  JobSearchStatus,
  JobSort,
  JobWerkvorm,
  PreviewStatus,
} from "./types";

export type SearchParamInput =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/** Fixture/client clamp — lockstep with SEARCH_MAX_LIMIT (CTP-509). */
const MAX_PAGE_SIZE = 1000;
const FIXTURE_NOW = Date.parse("2026-08-30T12:00:00.000Z");

const isOneOf = <T extends string>(
  value: string | null,
  allowed: readonly T[]
): value is T => value !== null && allowed.some((item) => item === value);

const readValues = (input: SearchParamInput, key: string): string[] => {
  const rawValues =
    input instanceof URLSearchParams
      ? input.getAll(key)
      : [input[key]].flatMap((value) => value ?? []);

  return rawValues.map((value) => value.trim()).filter(Boolean);
};

const readLegacyEnumValues = (input: SearchParamInput, key: string): string[] =>
  readValues(input, key).flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );

const readFirst = (input: SearchParamInput, key: string): string | null =>
  readValues(input, key)[0] ?? null;

const uniqueAllowedValues = <T extends string>(
  values: readonly string[],
  allowed: readonly T[]
): T[] => [
  ...new Set(values.filter((value): value is T => isOneOf(value, allowed))),
];

const parsePositiveInteger = (
  value: string | null,
  fallback: number
): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isJobPageSize = (value: number): value is JobPageSize =>
  JOB_PAGE_SIZE_OPTIONS.some((option) => option === value);

/** Allowlist only CTP-509 sizes; unknown values fall back to default (no silent oversize). */
export const parseJobPageSize = (value: string | null): JobPageSize => {
  const parsed = parsePositiveInteger(value, JOB_PAGE_SIZE);
  return isJobPageSize(parsed) ? parsed : JOB_PAGE_SIZE;
};

const parseMinRate = (value: string | null): number | null => {
  if (value === null || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseOptionalNonNegNumber = (value: string | null): number | null =>
  parseMinRate(value);

/** Accept YYYY-MM-DD only; reject garbage so URL state stays shareable. */
const parseIsoDate = (value: string | null): string | null => {
  if (value === null || value.trim() === "") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return null;
  }
  const parsed = Date.parse(`${trimmed}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? trimmed : null;
};

const isJobQueryScope = (value: string | null): value is JobQueryScope =>
  value !== null && JOB_QUERY_SCOPES.some((item) => item === value);

const isJobWerkvorm = (value: string): value is JobWerkvorm =>
  JOB_WERKVORMEN.some((item) => item === value);

export const parseJobSearchState = (
  input: SearchParamInput,
  enrichedDataAvailable: boolean = ENRICHED_SEARCH_DATA_AVAILABLE
): JobSearchState => {
  const freshness = readFirst(input, "freshness");
  const sort = readFirst(input, "sort");
  const previewStatus = readFirst(input, "preview");

  const queryScopeRaw = readFirst(input, "queryScope");

  return {
    filters: {
      contractTypes: uniqueAllowedValues(
        readLegacyEnumValues(input, "contract"),
        JOB_CONTRACT_TYPES
      ),
      freshness: isOneOf(freshness, FRESHNESS_FILTERS) ? freshness : "all",
      locations: [...new Set(readValues(input, "location"))],
      maxRate: parseOptionalNonNegNumber(readFirst(input, "maxRate")),
      minRate: parseMinRate(readFirst(input, "minRate")),
      provincies: [...new Set(readValues(input, "province"))],
      publicatiedatumTot: parseIsoDate(readFirst(input, "to")),
      publicatiedatumVanaf: parseIsoDate(readFirst(input, "from")),
      queryScope: isJobQueryScope(queryScopeRaw)
        ? queryScopeRaw
        : DEFAULT_JOB_QUERY_SCOPE,
      skills: [...new Set(readValues(input, "skill"))],
      // RJC-368: sources are opaque bron slugs from the live register, not a
      // fixed enum, so any provided value passes through (deduped); an
      // unrecognized slug simply matches zero bronnen/facets downstream.
      sources: [...new Set(readValues(input, "source"))],
      status: uniqueAllowedValues(
        readValues(input, "status"),
        JOB_SEARCH_STATUS_VALUES
      ),
      urenPerWeekMax: parseOptionalNonNegNumber(readFirst(input, "hoursMax")),
      urenPerWeekMin: parseOptionalNonNegNumber(readFirst(input, "hoursMin")),
      werkvormen: [
        ...new Set(readValues(input, "arrangement").filter(isJobWerkvorm)),
      ],
    },
    page: parsePositiveInteger(readFirst(input, "page"), 1),
    // Motian uses `perPage`; accept `pageSize` as alias.
    pageSize: parseJobPageSize(
      readFirst(input, "perPage") ?? readFirst(input, "pageSize")
    ),
    previewStatus: isOneOf(previewStatus, PREVIEW_STATUSES)
      ? previewStatus
      : "ready",
    query: readFirst(input, "q")?.trim() ?? "",
    // RJC-383: `archief=1` opts a shareable URL into the archive partition.
    scope: readFirst(input, "archief") === "1" ? "all" : "active",
    selectedJobId: readFirst(input, "job"),
    sort: isOneOf(sort, selectableJobSortOptions(enrichedDataAvailable))
      ? sort
      : "relevance",
  };
};

const appendMotianParityFilters = (
  params: URLSearchParams,
  filters: JobSearchState["filters"]
): void => {
  if (filters.maxRate !== null) {
    params.set("maxRate", String(filters.maxRate));
  }
  for (const werkvorm of filters.werkvormen) {
    params.append("arrangement", werkvorm);
  }
  for (const province of filters.provincies) {
    params.append("province", province);
  }
  for (const skill of filters.skills) {
    params.append("skill", skill);
  }
  if (filters.urenPerWeekMin !== null) {
    params.set("hoursMin", String(filters.urenPerWeekMin));
  }
  if (filters.urenPerWeekMax !== null) {
    params.set("hoursMax", String(filters.urenPerWeekMax));
  }
  if (filters.publicatiedatumVanaf) {
    params.set("from", filters.publicatiedatumVanaf);
  }
  if (filters.publicatiedatumTot) {
    params.set("to", filters.publicatiedatumTot);
  }
  if (filters.queryScope !== DEFAULT_JOB_QUERY_SCOPE) {
    params.set("queryScope", filters.queryScope);
  }
};

export const serializeJobSearchState = (
  state: JobSearchState
): URLSearchParams => {
  const params = new URLSearchParams();

  if (state.query) {
    params.set("q", state.query);
  }
  for (const source of state.filters.sources) {
    params.append("source", source);
  }
  for (const contractType of state.filters.contractTypes) {
    params.append("contract", contractType);
  }
  for (const location of state.filters.locations) {
    params.append("location", location);
  }
  for (const status of state.filters.status) {
    params.append("status", status);
  }
  if (state.filters.freshness !== "all") {
    params.set("freshness", state.filters.freshness);
  }
  if (state.filters.minRate !== null) {
    params.set("minRate", String(state.filters.minRate));
  }
  appendMotianParityFilters(params, state.filters);
  if (state.scope === "all") {
    params.set("archief", "1");
  }
  if (state.sort !== "relevance") {
    params.set("sort", state.sort);
  }
  if (state.page > 1) {
    params.set("page", String(state.page));
  }
  if (state.pageSize !== JOB_PAGE_SIZE) {
    params.set("perPage", String(state.pageSize));
  }
  if (state.selectedJobId) {
    params.set("job", state.selectedJobId);
  }
  if (state.previewStatus !== "ready") {
    params.set("preview", state.previewStatus);
  }

  return params;
};

export const toggleSearchFilter = <T extends string>(
  values: readonly T[],
  value: T
): T[] =>
  values.includes(value)
    ? values.filter((existing) => existing !== value)
    : [...values, value];

export const withResetPage = (
  state: JobSearchState,
  patch: Partial<Omit<JobSearchState, "page">>
): JobSearchState => ({ ...state, ...patch, page: 1 });

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036F]/gu, "")
    .toLocaleLowerCase("nl-NL");

const searchableText = (job: JobListing): string =>
  normalizeSearchText(
    [
      job.title,
      job.organization,
      job.location,
      job.summary,
      job.description,
      ...job.skills,
    ]
      .filter((value): value is string => value !== null)
      .join(" ")
  );

const parseBooleanExpression = (query: string): BooleanNode | null => {
  const result = parseBooleanQuery(query);
  return result.ok ? result.ast : null;
};

const evaluateBooleanExpression = (
  expression: BooleanNode,
  text: string
): boolean => {
  if (expression.kind === "term" || expression.kind === "phrase") {
    return text.includes(normalizeSearchText(expression.value));
  }
  if (expression.kind === "not") {
    return !evaluateBooleanExpression(expression.operand, text);
  }
  if (expression.kind === "and") {
    return expression.operands.every((operand) =>
      evaluateBooleanExpression(operand, text)
    );
  }
  return expression.operands.some((operand) =>
    evaluateBooleanExpression(operand, text)
  );
};

const positiveQueryValues = (
  expression: BooleanNode,
  negated = false
): string[] => {
  if (expression.kind === "term" || expression.kind === "phrase") {
    return negated ? [] : [normalizeSearchText(expression.value)];
  }
  if (expression.kind === "not") {
    return positiveQueryValues(expression.operand, true);
  }
  return expression.operands.flatMap((operand) =>
    positiveQueryValues(operand, negated)
  );
};

const queryTokens = (query: string): string[] => {
  const expression = parseBooleanExpression(query);
  return expression ? positiveQueryValues(expression) : [];
};

const matchesQuery = (job: JobListing, query: string): boolean => {
  if (!query.trim()) {
    return true;
  }
  const expression = parseBooleanExpression(query);
  return expression
    ? evaluateBooleanExpression(expression, searchableText(job))
    : false;
};

const freshnessMilliseconds = {
  "24h": 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} satisfies Record<Exclude<FreshnessFilter, "all">, number>;

const RATE_PERIOD_RANK = {
  day: 1,
  hour: 0,
  month: 2,
  unknown: 4,
  year: 3,
} as const;

const ratePeriodRank = (job: JobListing): number =>
  job.rate ? RATE_PERIOD_RANK[job.rate.period] : 5;

const rateSortValue = (job: JobListing): number =>
  job.rate?.max ?? job.rate?.min ?? -1;

const compareRateHigh = (left: JobListing, right: JobListing): number => {
  const periodDifference = ratePeriodRank(left) - ratePeriodRank(right);
  if (periodDifference !== 0) {
    return periodDifference;
  }
  return rateSortValue(right) - rateSortValue(left);
};

const isFreshEnough = (
  publishedAt: string | null,
  freshness: FreshnessFilter
): boolean => {
  if (freshness === "all") {
    return true;
  }
  if (!publishedAt) {
    return false;
  }
  return (
    FIXTURE_NOW - Date.parse(publishedAt) <= freshnessMilliseconds[freshness]
  );
};

const matchesFilters = (
  job: JobListing,
  state: Pick<JobSearchState, "filters" | "scope">
): boolean => {
  const { filters } = state;
  const searchStatus =
    job.status === "closed" ? ("closed" as const) : ("active" as const);
  const statusMatches =
    filters.status.length === 0 || filters.status.includes(searchStatus);
  const sourceMatches =
    filters.sources.length === 0 ||
    job.sourceRecords.some((source) => filters.sources.includes(source.name));
  const contractMatches =
    filters.contractTypes.length === 0 ||
    (job.contractType !== null &&
      filters.contractTypes.includes(job.contractType));
  const locationMatches =
    filters.locations.length === 0 ||
    (job.location !== null && filters.locations.includes(job.location));
  const hourlyRate =
    job.rate?.period === "hour" ? (job.rate.max ?? job.rate.min) : null;
  const rateMatches =
    filters.minRate === null ||
    (hourlyRate !== null && hourlyRate >= filters.minRate);

  return (
    statusMatches &&
    sourceMatches &&
    contractMatches &&
    locationMatches &&
    rateMatches &&
    isFreshEnough(job.publishedAt, filters.freshness)
  );
};

const relevanceScore = (job: JobListing, query: string): number => {
  const tokens = queryTokens(query);
  const title = normalizeSearchText(job.title);
  const skills = normalizeSearchText(job.skills.join(" "));
  let score = 0;

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 3;
      continue;
    }
    if (skills.includes(token)) {
      score += 2;
      continue;
    }
    score += 1;
  }

  return score;
};

const compareJobs = (
  left: JobListing,
  right: JobListing,
  sort: JobSort,
  query: string
): number => {
  if (sort === "rate-high") {
    return compareRateHigh(left, right);
  }
  if (sort === "closing-soon") {
    return (
      (left.closingAt ? Date.parse(left.closingAt) : Number.POSITIVE_INFINITY) -
      (right.closingAt ? Date.parse(right.closingAt) : Number.POSITIVE_INFINITY)
    );
  }
  if (sort === "relevance" && query) {
    const scoreDifference =
      relevanceScore(right, query) - relevanceScore(left, query);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
  }
  return (
    (right.publishedAt ? Date.parse(right.publishedAt) : 0) -
    (left.publishedAt ? Date.parse(left.publishedAt) : 0)
  );
};

const countFacets = <T extends string>(values: readonly T[]): FacetCount<T>[] =>
  [...new Set(values)]
    .map((value) => ({
      count: values.filter((candidate) => candidate === value).length,
      value,
    }))
    .toSorted((left, right) =>
      right.count === left.count
        ? left.value.localeCompare(right.value, "nl-NL")
        : right.count - left.count
    );

const buildFacets = (jobs: readonly JobListing[]) => ({
  contractTypes: countFacets(
    jobs.flatMap(({ contractType }) => (contractType ? [contractType] : []))
  ),
  locations: countFacets(
    jobs.flatMap(({ location }) => (location ? [location] : []))
  ),
  // Fixture has no province/skills/werkvorm facet source — keep empty (sparse OK).
  provincies: [] as const,
  skills: [] as const,
  sources: countFacets(
    jobs.flatMap((job) => job.sourceRecords.map(({ name }) => name))
  ),
  status: countFacets(
    jobs.map((job): JobSearchStatus =>
      job.status === "closed" ? "closed" : "active"
    )
  ),
  werkvormen: [] as const,
});

const previewMessage = {
  "engine-error":
    "De zoekmachine reageert niet. Probeer het over een moment opnieuw.",
  loading: "Vacatures worden geladen…",
  "syntax-error":
    "Controleer de haakjes, operators en aanhalingstekens in je zoekopdracht.",
} satisfies Record<Exclude<PreviewStatus, "ready" | "empty">, string>;

export const searchJobs = (
  jobs: readonly JobListing[],
  request: JobSearchRequest
): JobSearchResponse => {
  const pageSize = Math.min(
    Math.max(1, Math.floor(request.pageSize ?? JOB_PAGE_SIZE)),
    MAX_PAGE_SIZE
  );
  const hasSyntaxError =
    request.query.trim() !== "" &&
    parseBooleanExpression(request.query) === null;
  // RJC-383: the fixture mirrors the partitions — closed listings are the
  // archive; the active scope skips them but counts them.
  const inScope = (job: JobListing): boolean =>
    request.scope === "all" || job.status !== "closed";
  const matchingAll = jobs
    .filter((job) => matchesQuery(job, request.query))
    .filter((job) => matchesFilters(job, request));
  const matchingJobs = matchingAll
    .filter(inScope)
    .toSorted((left, right) =>
      compareJobs(left, right, request.sort, request.query)
    );
  const archiveTotal =
    request.scope === "all" ? null : matchingAll.length - matchingJobs.length;
  const requestedStatus = hasSyntaxError
    ? "syntax-error"
    : request.previewStatus;
  const status =
    requestedStatus === "ready" && matchingJobs.length === 0
      ? "empty"
      : requestedStatus;
  const totalPages = Math.max(1, Math.ceil(matchingJobs.length / pageSize));
  const page = Math.min(request.page, totalPages);
  const start = (page - 1) * pageSize;
  const items =
    status === "empty" ? [] : matchingJobs.slice(start, start + pageSize);
  let message: string | null = null;

  if (status === "empty") {
    message =
      "Geen vacatures gevonden. Maak je zoekopdracht of filters ruimer.";
  } else if (status !== "ready") {
    message = previewMessage[status];
  }

  return {
    archiveTotal,
    complete: true,
    facets: buildFacets(jobs.filter(inScope)),
    items,
    message,
    page,
    pageSize,
    status,
    total: status === "empty" ? 0 : matchingJobs.length,
    totalPages,
  };
};

export const getJobById = (
  jobs: readonly JobListing[],
  id: string | null
): JobListing | null => jobs.find((job) => job.id === id) ?? null;

export const resetJobSearchState = (): JobSearchState => ({
  ...DEFAULT_JOB_SEARCH_STATE,
  filters: { ...DEFAULT_JOB_SEARCH_STATE.filters },
});
