import type { SearchFilters } from "../contracts";
import {
  DEFAULT_JOB_QUERY_SCOPE,
  DEFAULT_JOB_SEARCH_STATE,
  ENRICHED_SEARCH_DATA_AVAILABLE,
  JOB_WERKVORMEN,
} from "../types";
import type {
  FacetCount,
  FreshnessFilter,
  JobContractType,
  JobSearchFacets,
  JobSearchFilters,
  JobSearchScope,
  JobSearchStatus,
  JobSort,
  JobSource,
  JobWerkvorm,
} from "../types";
import { bronNameToSource } from "./bron-catalog";
import type { BronCatalogEntry } from "./bron-catalog";
import type { CapabilityJsonObject } from "./capability-client";

/** Wire search filters — SoT registry searchFiltersSchema / web-contracts (CTP-475). */
export type ApiSearchFilters = SearchFilters;

export interface ApiFacetBucket {
  readonly count: number;
  readonly value: string;
}

export interface ApiSearchFacets {
  readonly bron_id: readonly ApiFacetBucket[];
  readonly contracttype: readonly ApiFacetBucket[];
  readonly locatie: readonly ApiFacetBucket[];
  readonly locatie_land: readonly ApiFacetBucket[];
  readonly provincie: readonly ApiFacetBucket[];
  readonly skills: readonly ApiFacetBucket[];
  readonly status: readonly ApiFacetBucket[];
}

// RJC-394/RJC-449: the loader indexes the published `locatie_tekst` value.
// An explicit unknown location stays absent from both location attributes, so
// the UI switches to location filtering/faceting only when enrichment is on;
// the flag remains a single kill switch for the country-only attribute.
const locationFilterKey = (
  enrichedDataAvailable: boolean
): "locatie" | "locatieLand" =>
  enrichedDataAvailable ? "locatie" : "locatieLand";
const locationFacetKey = (
  enrichedDataAvailable: boolean
): "locatie" | "locatie_land" =>
  enrichedDataAvailable ? "locatie" : "locatie_land";

// The index stores the curated location value when a bron publishes one; an
// explicit unknown has no location bucket. The UI shows a label, and the
// filter must send back the indexed value or it never matches (RJC-378).
const LOCATION_LABELS = [["NL", "Nederland"]] as const;

export const locationLabel = (value: string): string =>
  LOCATION_LABELS.find(([known]) => known === value)?.[1] ?? value;

const locationValue = (label: string): string =>
  LOCATION_LABELS.find(([, known]) => known === label)?.[0] ?? label;

const freshnessToDays = (freshness: FreshnessFilter): number | undefined => {
  switch (freshness) {
    case "24h": {
      return 1;
    }
    case "7d": {
      return 7;
    }
    case "30d": {
      return 30;
    }
    default: {
      return undefined;
    }
  }
};

const resolveBronIds = (
  sources: readonly JobSource[],
  bronCatalog: ReadonlyMap<string, BronCatalogEntry>
): string[] => {
  const ids = new Set<string>();
  for (const source of sources) {
    for (const bron of bronCatalog.values()) {
      if (bronNameToSource(bron.naam) === source) {
        ids.add(bron.bronId);
      }
    }
  }
  return [...ids];
};

export const mapUiFiltersToApi = (
  filters: JobSearchFilters,
  bronCatalog: ReadonlyMap<string, BronCatalogEntry>,
  enrichedDataAvailable: boolean = ENRICHED_SEARCH_DATA_AVAILABLE
): ApiSearchFilters => {
  const bronIds = resolveBronIds(filters.sources, bronCatalog);
  const freshnessDays = freshnessToDays(filters.freshness);
  const mapped: {
    -readonly [K in keyof ApiSearchFilters]?: ApiSearchFilters[K];
  } = {};

  if (bronIds.length > 0) {
    mapped.bronIds = bronIds;
  }
  if (filters.contractTypes.length > 0) {
    mapped.contracttype = [...filters.contractTypes];
  }
  if (filters.locations.length > 0) {
    mapped[locationFilterKey(enrichedDataAvailable)] =
      filters.locations.map(locationValue);
  }
  if (filters.status.length > 0) {
    mapped.status = [...filters.status];
  }
  if (filters.minRate === null) {
    // no rate filter
  } else {
    mapped.tariefMin = filters.minRate;
  }
  if (filters.maxRate === null) {
    // no max rate
  } else {
    mapped.tariefMax = filters.maxRate;
  }
  if (filters.werkvormen.length > 0) {
    mapped.werkvormen = [...filters.werkvormen];
  }
  if (filters.provincies.length > 0) {
    mapped.provincies = [...filters.provincies];
  }
  if (filters.skills.length > 0) {
    mapped.skills = [...filters.skills];
  }
  if (filters.urenPerWeekMin === null) {
    // no hours min
  } else {
    mapped.urenPerWeekMin = filters.urenPerWeekMin;
  }
  if (filters.urenPerWeekMax === null) {
    // no hours max
  } else {
    mapped.urenPerWeekMax = filters.urenPerWeekMax;
  }
  if (filters.publicatiedatumVanaf) {
    mapped.publicatiedatumVanaf = filters.publicatiedatumVanaf;
  }
  if (filters.publicatiedatumTot) {
    mapped.publicatiedatumTot = filters.publicatiedatumTot;
  }
  // queryScope defaults to all (CTP-508 full vacature); only send when non-default.
  if (filters.queryScope !== DEFAULT_JOB_QUERY_SCOPE) {
    mapped.queryScope = filters.queryScope;
  }
  if (freshnessDays === undefined) {
    // no freshness filter
  } else {
    mapped.freshnessDays = freshnessDays;
  }

  return mapped;
};

const isJobContractType = (value: string): value is JobContractType =>
  value === "interim" ||
  value === "detachering" ||
  value === "vast" ||
  value === "freelance";

const isJobSearchStatus = (value: string): value is JobSearchStatus =>
  value === "active" ||
  value === "stale" ||
  value === "closed" ||
  value === "unknown";

const mapSourceFacet = (
  bucket: ApiFacetBucket,
  bronCatalog: ReadonlyMap<string, BronCatalogEntry>
): FacetCount<JobSource> | null => {
  const bron = bronCatalog.get(bucket.value);
  // RJC-368: bronNameToSource is a total slugifier now, so any bron present
  // in the catalog produces a facet count — not just the 4 previously
  // hardcoded names.
  return bron
    ? { count: bucket.count, value: bronNameToSource(bron.naam) }
    : null;
};

export const mapApiFacetsToUi = (
  facets: ApiSearchFacets,
  bronCatalog: ReadonlyMap<string, BronCatalogEntry>,
  enrichedDataAvailable: boolean = ENRICHED_SEARCH_DATA_AVAILABLE
): JobSearchFacets => ({
  contractTypes: facets.contracttype.flatMap((bucket) =>
    isJobContractType(bucket.value)
      ? [{ count: bucket.count, value: bucket.value }]
      : []
  ),
  locations: facets[locationFacetKey(enrichedDataAvailable)].map((bucket) => ({
    count: bucket.count,
    value: locationLabel(bucket.value),
  })),
  provincies: facets.provincie.map((bucket) => ({
    count: bucket.count,
    value: bucket.value,
  })),
  skills: facets.skills.map((bucket) => ({
    count: bucket.count,
    value: bucket.value,
  })),
  sources: facets.bron_id.flatMap((bucket) => {
    const mapped = mapSourceFacet(bucket, bronCatalog);
    return mapped ? [mapped] : [];
  }),
  status: facets.status.flatMap((bucket) =>
    isJobSearchStatus(bucket.value)
      ? [{ count: bucket.count, value: bucket.value }]
      : []
  ),
  werkvormen: [],
});

const daysToFreshness = (days: number | undefined): FreshnessFilter => {
  if (days === 1) {
    return "24h";
  }
  if (days === 7) {
    return "7d";
  }
  if (days === 30) {
    return "30d";
  }
  return "all";
};

const isJobWerkvorm = (value: string): value is JobWerkvorm =>
  JOB_WERKVORMEN.some((candidate) => candidate === value);

/** Reverse of mapUiFiltersToUi for applying saved searches (CTP-510). */
export const mapApiFiltersToUi = (
  api: ApiSearchFilters | null | undefined,
  bronCatalog: ReadonlyMap<string, BronCatalogEntry>,
  enrichedDataAvailable: boolean = ENRICHED_SEARCH_DATA_AVAILABLE
): JobSearchFilters => {
  const base = {
    ...DEFAULT_JOB_SEARCH_STATE.filters,
  };
  if (!api) {
    return base;
  }

  const sources: JobSource[] = [];
  for (const bronId of api.bronIds ?? []) {
    const bron = bronCatalog.get(bronId);
    if (bron) {
      sources.push(bronNameToSource(bron.naam));
    }
  }

  const contractTypes = (api.contracttype ?? []).filter(isJobContractType);
  const locationKey = locationFilterKey(enrichedDataAvailable);
  const rawLocations = api[locationKey] ?? [];
  const locations = rawLocations.map(locationLabel);
  const status = (api.status ?? []).filter(isJobSearchStatus);
  const werkvormen = (api.werkvormen ?? []).filter(isJobWerkvorm);

  return {
    ...base,
    contractTypes,
    freshness: daysToFreshness(api.freshnessDays),
    locations,
    maxRate: api.tariefMax ?? null,
    minRate: api.tariefMin ?? null,
    provincies: [...(api.provincies ?? [])],
    publicatiedatumTot: api.publicatiedatumTot ?? null,
    publicatiedatumVanaf: api.publicatiedatumVanaf ?? null,
    queryScope: api.queryScope ?? DEFAULT_JOB_QUERY_SCOPE,
    skills: [...(api.skills ?? [])],
    sources: [...new Set(sources)],
    status,
    urenPerWeekMax: api.urenPerWeekMax ?? null,
    urenPerWeekMin: api.urenPerWeekMin ?? null,
    werkvormen,
  };
};

export const buildSearchRequestBody = (input: {
  readonly filters: JobSearchFilters;
  readonly limit: number;
  readonly offset: number;
  readonly query: string;
  readonly scope?: JobSearchScope;
  readonly sort: JobSort;
  readonly bronCatalog: ReadonlyMap<string, BronCatalogEntry>;
}): CapabilityJsonObject => {
  const filters = mapUiFiltersToApi(input.filters, input.bronCatalog);
  // RJC-383: the API defaults to the active partition; only the archive
  // opt-in travels on the wire.
  const scope = input.scope === "all" ? { scope: "all" } : undefined;
  const base = {
    limit: input.limit,
    offset: input.offset,
    query: input.query,
    ...scope,
    sort: input.sort,
  };
  if (Object.keys(filters).length > 0) {
    return { ...base, filters: { ...filters } };
  }
  return base;
};

const filtersBody = (
  filters: JobSearchFilters,
  bronCatalog: ReadonlyMap<string, BronCatalogEntry>
): CapabilityJsonObject | undefined => {
  const mapped = mapUiFiltersToApi(filters, bronCatalog);
  return Object.keys(mapped).length > 0 ? { ...mapped } : undefined;
};

export const buildSavedSearchBody = (input: {
  readonly filters: JobSearchFilters;
  readonly naam: string;
  readonly query: string;
  readonly bronCatalog: ReadonlyMap<string, BronCatalogEntry>;
}): CapabilityJsonObject => ({
  filters: filtersBody(input.filters, input.bronCatalog),
  naam: input.naam,
  query: input.query,
});

export const buildSnapshotBody = (input: {
  readonly filters: JobSearchFilters;
  readonly query: string;
  readonly scope: JobSearchScope;
  readonly selectedIds: readonly string[];
  readonly bronCatalog: ReadonlyMap<string, BronCatalogEntry>;
}): CapabilityJsonObject => ({
  filters: filtersBody(input.filters, input.bronCatalog),
  query: input.query,
  // RJC-383: the snapshot records the scope the selection was made under.
  scope: input.scope,
  // RJC-385: a snapshot is bound to an explicit selection; the query and
  // filters above travel along as context only.
  selectedIds: [...input.selectedIds],
});
