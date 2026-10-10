import { z } from "zod";

import { SEARCH_SCOPES } from "../partition";
import type { ResultCacheEntry, SearchFacets, SearchHit } from "../types";

const searchHitSchema = z.object({
  id: z.string(),
  weight: z.number(),
});

const searchFacetBucketSchema = z.object({
  count: z.number(),
  value: z.string(),
});

const searchFacetsSchema = z.object({
  bron_id: z.array(searchFacetBucketSchema),
  contracttype: z.array(searchFacetBucketSchema),
  locatie: z.array(searchFacetBucketSchema),
  locatie_land: z.array(searchFacetBucketSchema),
  provincie: z.array(searchFacetBucketSchema),
  skills: z.array(searchFacetBucketSchema),
  status: z.array(searchFacetBucketSchema),
});

const resultCacheEntrySchema = z.object({
  archiveTotal: z.number().nullable().optional(),
  astHash: z.string(),
  emptyReason: z.string().optional(),
  facets: searchFacetsSchema,
  filters: z.object({
    bronIds: z.array(z.string()).optional(),
    contracttype: z.array(z.string()).optional(),
    freshnessDays: z.number().optional(),
    locatie: z.array(z.string()).optional(),
    locatieLand: z.array(z.string()).optional(),
    status: z
      .array(z.enum(["active", "closed", "stale", "unknown"]))
      .optional(),
    tariefMax: z.number().optional(),
    tariefMin: z.number().optional(),
  }),
  hits: z.array(searchHitSchema),
  indexVersion: z.number(),
  scope: z.enum(SEARCH_SCOPES),
  total: z.number(),
  windowLimit: z.number(),
});

export const parseResultCacheEntry = (raw: string): ResultCacheEntry => {
  const parsed: unknown = JSON.parse(raw);
  return resultCacheEntrySchema.parse(parsed);
};

export type ParsedSearchHit = SearchHit;
export type ParsedSearchFacets = SearchFacets;
