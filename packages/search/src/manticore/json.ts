import { z } from "zod";

export const manticoreFacetBucketSchema = z.object({
  count: z.number().optional(),
  doc_count: z.number().optional(),
  key: z
    .union([
      z.number(),
      z.string(),
      z.array(z.union([z.number(), z.string()])),
      z.null(),
    ])
    .optional(),
  value: z.union([z.number(), z.string()]).optional(),
});

export const manticoreFacetSchema = z.object({
  buckets: z.array(manticoreFacetBucketSchema).optional(),
});

export const manticoreHitSchema = z.object({
  // Manticore's own doc id is numeric (a hashDocumentId hash); coerced to a
  // string here since ManticoreSearchHit.id is a string. The real
  // SearchDocument.id lives in _source.document_id and is preferred when
  // present — see parseManticoreSearchResponse.
  _hybrid_score: z.number().optional(),
  _id: z.union([z.string(), z.number()]).optional(),
  _score: z.number().optional(),
  _source: z.object({ document_id: z.string().optional() }).optional(),
});

const manticoreErrorSchema = z.union([
  z.string(),
  z
    .object({
      index: z.string().optional(),
      type: z.string(),
    })
    .transform(({ index, type }) =>
      index && !type.includes(index) ? `${type} (table ${index})` : type
    ),
]);

export const manticoreSearchPayloadSchema = z.object({
  aggregations: z
    .object({
      bron_id: manticoreFacetSchema.optional(),
      contracttype: manticoreFacetSchema.optional(),
      locatie: manticoreFacetSchema.optional(),
      locatie_land: manticoreFacetSchema.optional(),
      provincie: manticoreFacetSchema.optional(),
      skills: manticoreFacetSchema.optional(),
      status: manticoreFacetSchema.optional(),
    })
    .optional(),
  aggs: z
    .object({
      bron_id: manticoreFacetSchema.optional(),
      contracttype: manticoreFacetSchema.optional(),
      locatie: manticoreFacetSchema.optional(),
      locatie_land: manticoreFacetSchema.optional(),
      provincie: manticoreFacetSchema.optional(),
      skills: manticoreFacetSchema.optional(),
      status: manticoreFacetSchema.optional(),
    })
    .optional(),
  error: manticoreErrorSchema.optional(),
  hits: z
    .object({
      hits: z.array(manticoreHitSchema).optional(),
      total: z.union([z.number(), z.object({ value: z.number() })]).optional(),
    })
    .optional(),
  // Set by Manticore when max_query_time (RJC-380) cuts a query short: the
  // response is still 200 OK with whatever matches were found so far, not
  // an error — so this is the only signal that hits/total are partial.
  timed_out: z.boolean().optional(),
});

export type ManticoreSearchPayload = z.infer<
  typeof manticoreSearchPayloadSchema
>;

export const parseManticoreSearchPayload = (
  raw: string
): ManticoreSearchPayload => {
  const parsed: unknown = JSON.parse(raw);
  return manticoreSearchPayloadSchema.parse(parsed);
};

export interface ManticoreReplaceBody {
  doc: ManticoreIndexedDocument;
  id: number;
  index: string;
}

export interface ManticoreDeleteBody {
  id: number;
  index: string;
}

/** One NDJSON line of a POST /bulk body. */
export type ManticoreBulkLine =
  | { delete: ManticoreDeleteBody }
  | { replace: ManticoreReplaceBody };

/**
 * POST /bulk response on 6.3.8 (verified live, RJC-389). There are NO
 * per-line outcomes: `items` holds one aggregated entry per consecutive
 * same-table run, and on any error the whole run is discarded (nothing
 * before the failing line lands either), `current_line` names the 1-based
 * failing line, `error` carries the message, and later lines are not
 * attempted. Error responses are HTTP 500/400 with this same JSON body.
 */
export const manticoreBulkPayloadSchema = z.object({
  current_line: z.number().optional(),
  error: z.string().optional(),
  errors: z.boolean().optional(),
  items: z.array(z.unknown()).optional(),
  skipped_lines: z.number().optional(),
});

export type ManticoreBulkPayload = z.infer<typeof manticoreBulkPayloadSchema>;

export const parseManticoreBulkPayload = (
  raw: string
): ManticoreBulkPayload => {
  const parsed: unknown = JSON.parse(raw);
  return manticoreBulkPayloadSchema.parse(parsed);
};

export interface ManticoreIndexedDocument {
  beschrijving: string;
  bron_id: string;
  /** Comparable rate for sorting; 0 when period unknown (desc unknowns last). */
  comparable_tarief: number;
  contracttype: string;
  // The original SearchDocument.id (a string, UUID in production). Manticore's
  // own reserved "id" attribute is the numeric ManticoreReplaceBody.id/
  // ManticoreDeleteBody.id above, computed via hashDocumentId — see id-hash.ts.
  document_id: string;
  index_version: number;
  laatst_gezien_op: number;
  // Display location the UI filters and facets on (RJC-378); see
  // documentLocatie in ../types.ts for how it is derived.
  /** Omitted when the curated source did not publish a location. */
  locatie?: string;
  /** Omitted when the curated source did not publish a location. */
  locatie_land?: string;
  opdrachtgever_naam: string;
  /** Keyword copy for company-asc sorts. */
  opdrachtgever_naam_keyword: string;
  provincie: string;
  /** Source skill names as a JSON array; Manticore's native MVA is integer-only. */
  skills: readonly string[];
  // Epoch seconds; PUBLICATIEDATUM_MISSING_SENTINEL when unknown.
  publicatiedatum: number;
  // Epoch seconds; SLUITINGSDATUM_MISSING_SENTINEL when the bron publishes no
  // deadline, so `sluitingsdatum asc` puts missing deadlines last natively.
  sluitingsdatum: number;
  status: string;
  tarief_eenheid: string;
  tarief_max: number;
  tarief_min: number;
  titel: string;
  /** Keyword copy for title-asc sorts. */
  titel_keyword: string;
  uren_per_week_max: number;
  uren_per_week_min: number;
  werkvorm: string;
  /** Canonical source projection hash; lets reconciliation inspect actual RT content. */
  projection_hash: string;
}

export interface ManticoreQueryBody {
  query_string: string;
}

/**
 * Manticore's JSON /search has no top-level `filter` key — it silently
 * ignores one (verified against 6.3.8: a top-level `filter` returned every
 * document). Attribute filters must travel inside `query.bool.filter`, with
 * the full-text clause under `must`.
 */
export interface ManticoreFilteredQueryBody {
  bool: {
    filter: ManticoreFilterClause[];
    must?: ManticoreQueryBody[];
  };
}

export type ManticoreSortDirection = "asc" | "desc";

export interface ManticoreSortEntry {
  "WEIGHT()": ManticoreSortDirection;
}

export interface ManticoreHybridSortEntry {
  "hybrid_score()": ManticoreSortDirection;
}

export interface ManticoreIdSortEntry {
  id: ManticoreSortDirection;
}

export interface ManticoreAttributeSortEntry {
  comparable_tarief?: ManticoreSortDirection;
  laatst_gezien_op?: ManticoreSortDirection;
  opdrachtgever_naam_keyword?: ManticoreSortDirection;
  publicatiedatum?: ManticoreSortDirection;
  sluitingsdatum?: ManticoreSortDirection;
  tarief_max?: ManticoreSortDirection;
  titel_keyword?: ManticoreSortDirection;
}

export interface ManticoreTermsAgg {
  field: string;
  size: number;
}

export type ManticoreFacetName =
  | "bron_id"
  | "contracttype"
  | "locatie"
  | "locatie_land"
  | "provincie"
  | "skills"
  | "status";

export type ManticoreTermsAggregations = Partial<
  Record<ManticoreFacetName, { terms: ManticoreTermsAgg }>
>;

export interface ManticoreSearchRequestBody {
  /** Hybrid requests select only display/sort metadata, never the embedding vector. */
  _source?: string[];
  /** Omitted on the RJC-383 archive count request, which only needs `total`. */
  aggs?: ManticoreTermsAggregations;
  index: string;
  knn?: {
    field: "embedding";
    query: string;
  };
  limit: number;
  // Upper bound on how many candidate matches Manticore ranks and holds in
  // memory for this query, independent of limit/offset (RJC-380). See the
  // docblock on DEFAULT_MAX_MATCHES in client.ts for the reasoning.
  max_matches: number;
  // Wall-clock query execution budget in milliseconds. Manticore returns a
  // partial result (not an error) if a query runs past this (RJC-380). See
  // the docblock on DEFAULT_MAX_QUERY_TIME_MS in client.ts.
  max_query_time: number;
  offset: number;
  options?: { fusion_method: "rrf" };
  query?: ManticoreFilteredQueryBody | ManticoreQueryBody;
  sort?: (
    | ManticoreAttributeSortEntry
    | ManticoreHybridSortEntry
    | ManticoreIdSortEntry
    | ManticoreSortEntry
  )[];
  track_total_hits: boolean;
}

export interface ManticoreInFilter {
  in: {
    bron_id?: string[];
    contracttype?: string[];
    locatie?: string[];
    locatie_land?: string[];
    provincie?: string[];
    skills?: string[];
    status?: string[];
    tarief_eenheid?: string[];
    werkvorm?: string[];
  };
}

export interface ManticoreRangeFilter {
  range: {
    laatst_gezien_op?: { gte: number };
    publicatiedatum?: { gte?: number; lt?: number };
    tarief_max?: { gte: number };
    tarief_min?: { lte: number };
    uren_per_week_max?: { gte: number };
    uren_per_week_min?: { lte: number };
  };
}

export type ManticoreFilterClause = ManticoreInFilter | ManticoreRangeFilter;

export type ManticoreRequestBody =
  | ManticoreDeleteBody
  | ManticoreReplaceBody
  | ManticoreSearchRequestBody;
