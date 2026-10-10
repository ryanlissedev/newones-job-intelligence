/**
 * Werk.nl (UWV) `zoekenvacatures` KIA API shapes, derived from live traffic
 * 2026-09-18 (docs/sources/inventory/browser-poc-wave.md): the public SPA at
 * https://www.werk.nl/nl/vacatures/ POSTs to
 * `/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api/search` and
 * reads detail via `GET .../api/vacature/<referenceNumber>`. Session = OAM
 * anonymous-auth cookies + `X-XSRF-TOKEN` header, bootstrapped by following
 * the `api/configuration` redirect chain.
 */
export const WERK_NL_PARSER_VERSION = "werk-nl/v1" as const;

/** Items per search page; fixed upstream (`maximumItemsPerPage` in
 * api/configuration, observed live). */
export const WERK_NL_PAGE_SIZE = 20;

/** Deep-paging ceiling from api/configuration `maxSearchCount`: page
 * 10.000 returns items 199.981-199.999, page 10.001 returns `items: null`.
 * A shard whose totalResults exceeds this must be split on another facet. */
export const WERK_NL_MAX_SEARCH_RESULTS = 199_999;

/** JOB_SHIFT_TYPE facet values (1 = Kantoortijden, 2 = Anders). Live counts
 * 2026-09-18: 149.269 + 91.161 = ~240k total, both under the search ceiling,
 * so two shards cover the full public catalog. */
export const WERK_NL_SHIFT_TYPE_SHARDS = ["1", "2"] as const;

export interface WerkNlSearchItem {
  key: string;
  referenceNumber: number;
  score?: number | null;
  resultDepth?: number | null;
  internalReferenceNumber?: string | null;
  profession: string;
  vacatureTitle: string;
  modified: string;
  organisation: string;
  workLocationCity: string | null;
  workLocationType: string;
  workLocationForeignCountry: string | null;
  workLocationForeignCity: string | null;
  minHours: number;
  maxHours: number;
  contractType: string;
  studyLevel: string;
  distance?: number | null;
  leerbaan: boolean;
  stageplaats: boolean;
}

export interface WerkNlSearchResponse {
  items: WerkNlSearchItem[] | null;
  facets: unknown[] | null;
  totalResults: number;
  sortOptions?: unknown;
  template?: string | null;
  totalResultsSuggestedSearch?: number | null;
}

export interface WerkNlWorkLocation {
  type?: number | null;
  countryCode?: string | null;
  postcode?: string | null;
  city?: string | null;
  employerLocationDistance?: number | null;
}

export interface WerkNlFunction {
  code?: string | null;
  name?: string | null;
  description?: string | null;
  customDescription?: string | null;
}

export interface WerkNlSalary {
  type?: number | null;
  amountIndication?: string | null;
}

export interface WerkNlContract {
  type?: number | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface WerkNlWorkhours {
  minimumHours?: number | null;
  maximumHours?: number | null;
  werktijden?: number | null;
}

export interface WerkNlProposition {
  termsOfEmploymentDescription?: string | null;
  workLocation?: WerkNlWorkLocation | null;
  function?: WerkNlFunction | null;
  salary?: WerkNlSalary | null;
  contract?: WerkNlContract | null;
  workhours?: WerkNlWorkhours | null;
}

export interface WerkNlContactPerson {
  name?: string | null;
  department?: string | null;
  phoneNumber?: string | null;
  email?: string | null;
}

export interface WerkNlEmployerAddress {
  postcode?: string | null;
  city?: string | null;
  streetName?: string | null;
  houseNumber?: string | null;
}

export interface WerkNlEmployer {
  organizationName?: string | null;
  addressNetherlands?: WerkNlEmployerAddress | null;
}

export interface WerkNlApplicationMethod {
  sollicitatieWijze?: number | null;
  urlApplicationForm?: string | null;
}

export interface WerkNlCvOffer {
  educationLevel?: number | null;
  otherRequirements?: string | null;
  driversLicenses?: number[] | null;
}

export interface WerkNlVacatureDetail {
  referenceNumber: number;
  title: string;
  expirationDate?: string | null;
  modifiedDate?: string | null;
  createdDate?: string | null;
  proposition?: WerkNlProposition | null;
  contactPerson?: WerkNlContactPerson | null;
  description?: string | null;
  isEuresPriority?: boolean;
  isAcquisitionNotAppreciated?: boolean;
  source?: string | null;
  cvOffer?: WerkNlCvOffer | null;
  applicationMethods?: WerkNlApplicationMethod[] | null;
  employer?: WerkNlEmployer | null;
}

export interface WerkNlFetchedPayload {
  detail: WerkNlVacatureDetail;
  listing: WerkNlSearchItem | null;
  referenceNumber: string;
}
