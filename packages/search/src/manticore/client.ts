import { publicatiedatumTotExclusiveUtc } from "../filter-match";
import type { SearchFilters, SearchMode, SearchSort } from "../types";
import { emptySearchFacets, SEARCH_WINDOW_LIMIT } from "../types";
import { hashDocumentId } from "./id-hash";
import type {
  ManticoreBulkPayload,
  ManticoreDeleteBody,
  ManticoreFilterClause,
  ManticoreIndexedDocument,
  ManticoreQueryBody,
  ManticoreReplaceBody,
  ManticoreSearchPayload,
  ManticoreSearchRequestBody,
  ManticoreSortDirection,
} from "./json";
import { tableExistsInShowTables } from "./show-tables";
import { ManticoreTimeoutError } from "./timeout-error";

export { ManticoreTimeoutError } from "./timeout-error";

export interface ManticoreSearchHit {
  id: string;
  weight: number;
}

export interface ManticoreSearchResponse {
  emptyReason?: string;
  facets: ReturnType<typeof emptySearchFacets>;
  hits: ManticoreSearchHit[];
  incomplete: boolean;
  total: number;
}

export interface ManticoreRequestOptions {
  /** Transport budget for this one request; defaults to the client's own timeout. */
  readonly timeoutMs?: number;
}

export interface ManticoreHttpClient {
  /** POST /bulk with one serialized ManticoreBulkLine per entry. */
  bulk: (lines: readonly string[]) => Promise<ManticoreBulkPayload>;
  request: (
    path: string,
    body:
      | ManticoreDeleteBody
      | ManticoreReplaceBody
      | ManticoreSearchRequestBody,
    options?: ManticoreRequestOptions
  ) => Promise<ManticoreSearchPayload>;
}

/**
 * Upper bound on candidate matches Manticore ranks and holds in memory per
 * query, independent of the request's limit/offset (RJC-380). A page whose
 * offset + limit exceeds it gets fewer (or zero) hits back rather than an
 * error — Manticore truncates silently. Since RJC-378 the client paginates
 * server-side, so this is also the deepest navigable position: every engine
 * reports it as `windowLimit` and the API rejects offset + limit beyond it
 * (searchAanvragenInputSchema). `track_total_hits` keeps `total` exact.
 */
const DEFAULT_MAX_MATCHES = SEARCH_WINDOW_LIMIT;

/**
 * Wall-clock query execution budget in milliseconds (RJC-380). Unlike a
 * transport timeout, exceeding this makes Manticore return whatever matches
 * it found within budget as a normal (partial) result — not an error — so a
 * slow full-text scan degrades to a smaller result set instead of hanging
 * the request. 5000ms comfortably clears a healthy query (typically low
 * tens of ms even under this app's real fixtures) while still bounding the
 * worst case for an overloaded or cold index, in line with search speed
 * being the product's most important property.
 */
const DEFAULT_MAX_QUERY_TIME_MS = 5000;

/**
 * Budget for the RJC-383 archive count that accompanies an active-scope
 * search. The count is decoration next to the search, so it gets a smaller
 * query budget and a smaller transport budget than the search itself, and
 * the engine degrades it to `null` instead of failing the search when either
 * is exceeded.
 */
export const ARCHIVE_COUNT_MAX_QUERY_TIME_MS = 1500;
export const ARCHIVE_COUNT_TIMEOUT_MS = 2000;

const bucketValue = (
  key: string | number | readonly (string | number)[] | null | undefined
): string | null => {
  if (key === undefined || key === null || Array.isArray(key)) {
    return null;
  }

  return String(key);
};

const parseFacetBuckets = (
  payload: ManticoreSearchPayload,
  field:
    | "bron_id"
    | "contracttype"
    | "locatie"
    | "locatie_land"
    | "provincie"
    | "skills"
    | "status"
) => {
  const facet =
    payload.aggregations?.[field]?.buckets ??
    payload.aggs?.[field]?.buckets ??
    [];
  return facet
    .map((bucket) => {
      const value = bucketValue(bucket.key ?? bucket.value);
      const count = bucket.doc_count ?? bucket.count ?? null;
      if (value === null || count === null) {
        return null;
      }

      return { count, value };
    })
    .filter(
      (bucket): bucket is { count: number; value: string } => bucket !== null
    );
};

const isWrappedTotal = (
  value: number | { value: number }
): value is { value: number } => !Number.isFinite(value);

export const parseManticoreSearchResponse = (
  payload: ManticoreSearchPayload
): ManticoreSearchResponse => {
  const hitsBlock = payload.hits;
  const totalValue = hitsBlock?.total;
  let total = 0;
  if (totalValue !== undefined) {
    total = isWrappedTotal(totalValue) ? totalValue.value : totalValue;
  }

  const rawHits = hitsBlock?.hits ?? [];
  const hits = rawHits
    .map((entry) => {
      // _id is Manticore's numeric document id (a hash, see id-hash.ts) —
      // the original SearchDocument.id lives in _source.document_id.
      const id =
        entry._source?.document_id ??
        (entry._id === undefined ? null : String(entry._id));
      const weight = entry._hybrid_score ?? entry._score ?? 0;
      if (id === null) {
        return null;
      }

      return { id, weight };
    })
    .filter((hit): hit is ManticoreSearchHit => hit !== null);

  const facets = emptySearchFacets();
  facets.bron_id = parseFacetBuckets(payload, "bron_id");
  facets.status = parseFacetBuckets(payload, "status");
  facets.locatie = parseFacetBuckets(payload, "locatie").filter(
    (bucket) => bucket.value !== ""
  );
  facets.locatie_land = parseFacetBuckets(payload, "locatie_land").filter(
    (bucket) => bucket.value !== ""
  );
  facets.provincie = parseFacetBuckets(payload, "provincie").filter(
    (bucket) => bucket.value !== ""
  );
  facets.skills = parseFacetBuckets(payload, "skills").filter(
    (bucket) => bucket.value !== ""
  );
  facets.contracttype = parseFacetBuckets(payload, "contracttype");

  return {
    // RJC-380: a timed-out query (max_query_time cut it short) must never
    // read as an ordinary "no results" — flag it distinctly so it isn't
    // mistaken for empty_index or a real zero-match query, and so callers
    // know hits/total are partial rather than exact.
    emptyReason: payload.timed_out === true ? "query_timeout" : undefined,
    facets,
    hits,
    incomplete: payload.timed_out === true,
    total,
  };
};

const asPublicationFilterDate = (value: Date | string): Date | null => {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** AND-ed attribute filters; an empty list means "no filter". */
// oxlint-disable-next-line eslint/complexity -- one clause per SearchFilters key
export const buildFilterClauses = (
  filters: SearchFilters
): ManticoreFilterClause[] => {
  const must: ManticoreFilterClause[] = [];

  if (filters.bronIds && filters.bronIds.length > 0) {
    must.push({ in: { bron_id: [...filters.bronIds] } });
  }

  if (filters.status && filters.status.length > 0) {
    must.push({ in: { status: [...filters.status] } });
  }

  if (filters.locatieLand && filters.locatieLand.length > 0) {
    must.push({ in: { locatie_land: [...filters.locatieLand] } });
  }

  if (filters.locatie && filters.locatie.length > 0) {
    must.push({ in: { locatie: [...filters.locatie] } });
  }

  if (filters.contracttype && filters.contracttype.length > 0) {
    must.push({ in: { contracttype: [...filters.contracttype] } });
  }

  if (filters.tariefMin !== undefined) {
    must.push({ range: { tarief_max: { gte: filters.tariefMin } } });
  }

  if (filters.tariefMax !== undefined) {
    must.push({ range: { tarief_min: { lte: filters.tariefMax } } });
  }

  if (filters.provincies && filters.provincies.length > 0) {
    must.push({ in: { provincie: [...filters.provincies] } });
  }

  if (filters.skills && filters.skills.length > 0) {
    for (const skill of filters.skills) {
      must.push({ in: { skills: [skill] } });
    }
  }

  if (filters.werkvormen && filters.werkvormen.length > 0) {
    must.push({ in: { werkvorm: [...filters.werkvormen] } });
  }

  if (filters.tariefEenheid && filters.tariefEenheid.length > 0) {
    must.push({ in: { tarief_eenheid: [...filters.tariefEenheid] } });
  }

  if (filters.urenPerWeekMin !== undefined) {
    must.push({
      range: { uren_per_week_max: { gte: filters.urenPerWeekMin } },
    });
  }

  if (filters.urenPerWeekMax !== undefined) {
    must.push({
      range: { uren_per_week_min: { lte: filters.urenPerWeekMax } },
    });
  }

  if (filters.publicatiedatumVanaf !== undefined) {
    const from = asPublicationFilterDate(filters.publicatiedatumVanaf);
    if (from !== null) {
      must.push({
        range: {
          publicatiedatum: {
            gte: Math.floor(from.getTime() / 1000),
          },
        },
      });
    }
  }

  if (filters.publicatiedatumTot !== undefined) {
    const to = asPublicationFilterDate(filters.publicatiedatumTot);
    if (to !== null) {
      must.push({
        range: {
          publicatiedatum: {
            lt: Math.floor(publicatiedatumTotExclusiveUtc(to).getTime() / 1000),
          },
        },
      });
    }
  }

  if (filters.freshnessDays !== undefined) {
    const cutoff =
      Math.floor(Date.now() / 1000) - filters.freshnessDays * 86_400;
    must.push({ range: { laatst_gezien_op: { gte: cutoff } } });
  }

  return must;
};

const ASC: ManticoreSortDirection = "asc";
const DESC: ManticoreSortDirection = "desc";

/**
 * Sort clauses per SearchSort (RJC-378 / CTP-493). `id` (Manticore's numeric
 * doc id) is always the final tiebreak so a page boundary never shifts between
 * requests. Missing publication dates and deadlines use far-future/past
 * sentinels; comparable rates use 0 when the period is unknown so desc sorts
 * put unknowns last (asc rate-low still surfaces 0 first — see engine docs).
 */
export const buildManticoreSort = (
  sort: SearchSort,
  mode: SearchMode = "lexical"
): ManticoreSearchRequestBody["sort"] => {
  switch (sort) {
    case "relevance": {
      return mode === "hybrid"
        ? [{ "hybrid_score()": DESC }, { id: ASC }]
        : [{ "WEIGHT()": DESC }, { id: ASC }];
    }
    case "newest": {
      return [{ publicatiedatum: DESC }, { id: ASC }];
    }
    case "oldest": {
      return [{ publicatiedatum: ASC }, { id: ASC }];
    }
    case "rate-high": {
      return [{ comparable_tarief: DESC }, { id: ASC }];
    }
    case "rate-low": {
      return [{ comparable_tarief: ASC }, { id: ASC }];
    }
    case "closing-soon": {
      return [{ sluitingsdatum: ASC }, { id: ASC }];
    }
    case "title-asc": {
      return [{ titel_keyword: ASC }, { id: ASC }];
    }
    case "company-asc": {
      return [{ opdrachtgever_naam_keyword: ASC }, { id: ASC }];
    }
    default: {
      const _exhaustive: never = sort;
      throw new Error(`Unsupported sort: ${String(_exhaustive)}`);
    }
  }
};

const applyHybrid = (
  request: ManticoreSearchRequestBody,
  knnQueryText: string | undefined
): void => {
  if (!knnQueryText) {
    throw new Error("Hybrid search requires positive KNN query text");
  }
  request.knn = { field: "embedding", query: knnQueryText };
  request.options = { fusion_method: "rrf" };
  request._source = ["document_id"];
};

const applyFilterQuery = (
  request: ManticoreSearchRequestBody,
  query: ManticoreQueryBody | null,
  filters: SearchFilters
): void => {
  const filter = buildFilterClauses(filters);
  if (filter.length > 0) {
    // Filters only apply inside query.bool (see ManticoreFilteredQueryBody).
    request.query =
      query === null
        ? { bool: { filter } }
        : { bool: { filter, must: [query] } };
  } else if (query !== null) {
    request.query = query;
  }
};

export const buildManticoreSearchRequest = (
  index: string,
  query: ManticoreQueryBody | null,
  filters: SearchFilters,
  limit: number,
  offset: number,
  sort: SearchSort = "relevance",
  mode: SearchMode = "lexical",
  knnQueryText?: string
): ManticoreSearchRequestBody => {
  const request: ManticoreSearchRequestBody = {
    aggs: {
      bron_id: { terms: { field: "bron_id", size: 100 } },
      contracttype: { terms: { field: "contracttype", size: 50 } },
      locatie: { terms: { field: "locatie", size: 50 } },
      locatie_land: { terms: { field: "locatie_land", size: 50 } },
      provincie: { terms: { field: "provincie", size: 50 } },
      // A top-level JSON array aggregates as the whole array on Manticore
      // 6.3.8; the wildcard property path unwinds it into one bucket per
      // skill while retaining the document count for each value.
      skills: { terms: { field: "skills.*", size: 100 } },
      status: { terms: { field: "status", size: 20 } },
    },
    index,
    limit,
    max_matches: DEFAULT_MAX_MATCHES,
    max_query_time: DEFAULT_MAX_QUERY_TIME_MS,
    offset,
    sort: buildManticoreSort(sort, mode),
    // Exact totals are what the UI's page count is built on (RJC-378).
    track_total_hits: true,
  };

  if (mode === "hybrid") {
    applyHybrid(request, knnQueryText);
  }
  applyFilterQuery(request, query, filters);
  return request;
};

/**
 * Aggregation-free `limit: 0` request that only asks for `total` (RJC-383:
 * the "N in archief" count next to an active-scope search). Same query and
 * filters as the search it accompanies; no facets, no hits, no sort work.
 */
export const buildManticoreCountRequest = (
  index: string,
  query: ManticoreQueryBody | null,
  filters: SearchFilters,
  mode: SearchMode = "lexical",
  knnQueryText?: string
): ManticoreSearchRequestBody => {
  const request: ManticoreSearchRequestBody = {
    index,
    limit: 0,
    max_matches: 1,
    max_query_time: ARCHIVE_COUNT_MAX_QUERY_TIME_MS,
    offset: 0,
    sort: [{ id: ASC }],
    track_total_hits: true,
  };
  if (mode === "hybrid") {
    applyHybrid(request, knnQueryText);
    request.max_matches = DEFAULT_MAX_MATCHES;
    delete request.sort;
  }
  applyFilterQuery(request, query, filters);
  return request;
};

export const searchManticore = async (
  client: ManticoreHttpClient,
  request: ManticoreSearchRequestBody,
  options?: ManticoreRequestOptions
): Promise<ManticoreSearchResponse> => {
  const payload = await client.request("/search", request, options);
  return parseManticoreSearchResponse(payload);
};

export const replaceManticoreDocument = async (
  client: ManticoreHttpClient,
  index: string,
  document: ManticoreIndexedDocument
): Promise<void> => {
  await client.request("/replace", {
    doc: document,
    id: hashDocumentId(document.document_id),
    index,
  });
};

export type ManticoreBulkOutcome =
  | { readonly ok: true }
  | {
      readonly error: string;
      /** 0-based index into the submitted lines, or null when Manticore did not name one. */
      readonly failingLine: number | null;
      readonly ok: false;
    };

/**
 * Interprets a /bulk response under the 6.3.8 semantics documented on
 * manticoreBulkPayloadSchema: success means every line applied; failure
 * means NO line applied and `failingLine` is the one Manticore rejected.
 */
export const bulkManticore = async (
  client: ManticoreHttpClient,
  lines: readonly string[]
): Promise<ManticoreBulkOutcome> => {
  const payload = await client.bulk(lines);
  const error = payload.error ?? "";
  if (payload.errors !== true && error === "") {
    return { ok: true };
  }
  const line = payload.current_line;
  const failingLine =
    line !== undefined && line >= 1 && line <= lines.length ? line - 1 : null;
  return {
    error: error === "" ? "Manticore bulk request failed" : error,
    failingLine,
    ok: false,
  };
};

export const deleteManticoreDocument = async (
  client: ManticoreHttpClient,
  index: string,
  id: string
): Promise<void> => {
  await client.request("/delete", {
    id: hashDocumentId(id),
    index,
  });
};

/** Default bound for {@link describeManticoreTable} when the caller doesn't
 * pick a tighter one (e.g. readiness's own READINESS_CHECK_TIMEOUT_MS). */
export const DEFAULT_DESCRIBE_TABLE_TIMEOUT_MS = 1500;

export interface ManticoreTableInfo {
  /** True when `SHOW TABLES` lists `tableName` (any table type). */
  readonly exists: boolean;
}

/**
 * Cheap Manticore reachability + table-existence probe for readiness
 * (RJC-391) — no query engine, no bulk write, just `SHOW TABLES` over
 * `/sql?mode=raw` (the same endpoint `tools/manticore/probe-manticore29.sh`
 * uses for SELECTs; `docker-compose.yml`'s own healthcheck greps the
 * equivalent `SHOW TABLES` output for this project's table name over the
 * MySQL port). Bounded by an AbortSignal timeout so a hung Manticore never
 * hangs the caller — pass `signal` to have the caller's own timer abort the
 * fetch (readiness does this so a timed-out check stops instead of
 * lingering); omit it to fall back to a self-contained `timeoutMs` timer.
 */
export const describeManticoreTable = async (
  baseUrl: string,
  tableName: string,
  timeoutMs: number = DEFAULT_DESCRIBE_TABLE_TIMEOUT_MS,
  signal: AbortSignal = AbortSignal.timeout(timeoutMs)
): Promise<ManticoreTableInfo> => {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/sql?mode=raw`, {
      body: `query=${encodeURIComponent("SHOW TABLES")}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal,
    });
  } catch (error) {
    const isAbortTimeout =
      error instanceof DOMException && error.name === "TimeoutError";
    if (isAbortTimeout) {
      throw new ManticoreTimeoutError(`${baseUrl}/sql?mode=raw`, timeoutMs);
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(
      `Manticore SHOW TABLES failed (${response.status}): ${response.statusText}`
    );
  }

  const raw = await response.text();
  return { exists: tableExistsInShowTables(raw, tableName) };
};
