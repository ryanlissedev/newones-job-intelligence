import { createHash } from "node:crypto";

export interface SearchResultDigestInput {
  emptyReason?: string;
  facets: {
    bron_id: readonly { count: number }[];
    contracttype: readonly { count: number }[];
    locatie_land: readonly { count: number }[];
    status: readonly { count: number }[];
  };
  indexVersion: number;
  total: number;
}

export type QuerysetFilterValue =
  | boolean
  | number
  | readonly string[]
  | string
  | undefined;

/** Stable digest for a search workload without storing query text. */
export const digestQueryset = (input: {
  filters?: Readonly<Record<string, QuerysetFilterValue>>;
  limit?: number;
  offset?: number;
  query: string;
}): string => {
  const canonical = JSON.stringify({
    filters: input.filters ?? {},
    limit: input.limit ?? 20,
    offset: input.offset ?? 0,
    query: input.query,
  });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
};

/** Result identity without vacancy IDs — counts and facet totals only. */
export const digestSearchResult = (input: SearchResultDigestInput): string => {
  const facetCounts = {
    bron_id: input.facets.bron_id.map((bucket) => bucket.count),
    contracttype: input.facets.contracttype.map((bucket) => bucket.count),
    locatie_land: input.facets.locatie_land.map((bucket) => bucket.count),
    status: input.facets.status.map((bucket) => bucket.count),
  };
  const canonical = JSON.stringify({
    emptyReason: input.emptyReason ?? null,
    facetCounts,
    indexVersion: input.indexVersion,
    total: input.total,
  });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
};

/** Privacy-safe pg_stat_statements identity — never raw SQL text. */
export const digestQueryIdentity = (queryid: string | number): string => {
  const hash = createHash("sha256").update(String(queryid)).digest("hex");
  return `pg-queryid:${hash.slice(0, 32)}`;
};

export const digestDataset = (algorithm: string, payload: string): string =>
  `${algorithm}:${payload}`;
