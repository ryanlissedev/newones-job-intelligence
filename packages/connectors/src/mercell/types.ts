/**
 * Mercell s2c (ex-Negometrix) public tender API — types.
 *
 * Verified live 2026-09-18 against the unauthenticated JSON API the Angular
 * portal at `https://s2c.mercell.com/today` itself calls:
 *
 * - Listing: `POST https://api.s2c.mercell.com/api/v1/PublishedTender/GetPublishedTendersBySpecified`
 *   body `{SearchParameters: {...}}` → `{ResultsCount, CurrentPageResults[]}`.
 *   `StartIndex`/`EndIndex` are 1-based inclusive row bounds (verified:
 *   `1..100` and `101..110` return disjoint windows of the same 20 105-row
 *   result set).
 * - Detail: `GET https://api.s2c.mercell.com/api/v1/PublishedTender/GetPublishedTenderDetails?tenderId=<id>`.
 *
 * Enum names below were recovered from the portal's own published frontend
 * bundle (`main.*.js` on s2c.mercell.com) — source-published semantics, not
 * guesses.
 */

/** `SearchParameters` exactly as the portal posts it (field names verbatim). */
export interface MercellSearchParameters {
  StartIndex: number;
  EndIndex: number;
  PropertyFilters: unknown[];
  SearchText: string | null;
  SearchProperty: {
    PropertyDisplayName?: string;
    PropertyName: string;
    PropertyValue: string;
  } | null;
  OrderAscending: boolean;
  OrderColumn: string;
  Keywords: string[];
  UserId: null;
}

/** The portal's `/today` page search property: currently-open tenders. */
export const MERCELL_TODAY_SEARCH_PROPERTY = {
  PropertyDisplayName: "str_Today_opened",
  PropertyName: "str_Today_status",
  PropertyValue: "1",
} as const;

/**
 * DEC-008 whitelist for one `CurrentPageResults` row. The live row carries 25
 * keys (`EntityMnemonic*`, `Version`, `CreatedById`, `OrganizationImageUrl`,
 * `ContactPersonIanaTimeZone`, …); only the fields below may leave the client.
 * PascalCase kept verbatim — they are the source's own field names.
 */
export interface MercellListingItem {
  TenderId: number;
  TenderName: string;
  TenderDescription?: string | null;
  /** PublishedTenderParticipationStatus enum: 1 Open, 2 Closed. */
  Status?: number | null;
  OrganizationName?: string | null;
  OrganizationId?: number | null;
  /** ISO-8601 with explicit `Z`; absent on some amendment notices. */
  Deadline?: string | null;
  PublicationDate?: string | null;
  ProcedureType?: number | null;
  SpecialNumber?: string | null;
  Guid?: string | null;
  CreatedDate?: string | null;
  /** Bumps on any upstream edit — included so the listing hash notices. */
  ModifiedDate?: string | null;
  ShowOnToday?: boolean | null;
}

export interface MercellListingPage {
  results: MercellListingItem[];
  resultsCount: number;
  /** Echo of the requested bounds, for checkpoint math. */
  startIndex: number;
  endIndex: number;
}

/**
 * DEC-008 whitelist for `GetPublishedTenderDetails`. The live record carries
 * ~40 keys; `RequirementBoxes`, `TenderPublicationDetails`,
 * `PublicAwardStatements`, `LinkedTenders`, `TenderDescriptionDocuments` and
 * `OrganizationImageUrl` are deliberately not modelled (bulk content / blobs
 * the normaliser never reads).
 *
 * `Deadline` is absent from the detail response — it is a listing-only field,
 * which is why `MercellFetchedPayload` keeps the listing row.
 */
export interface MercellDetail {
  TenderId: number;
  TenderName: string;
  TenderDescription?: string | null;
  TenderGuid?: string | null;
  OrganizationName?: string | null;
  OrganizationId?: number | null;
  /** Published for suppliers submitting questions/bids (aanbieder doel). */
  ContactPersonDisplayName?: string | null;
  ContactPersonEmail?: string | null;
  ContactPersonPhone?: string | null;
  PublicationDate?: string | null;
  ProcedureType?: number | null;
  TypeOfContract?: number | null;
  /** EstimatedValueType enum: 0 None, 1 Value, 2 Range. */
  EstimatedValueType?: number | null;
  EstimatedValue?: number | null;
  EstimatedValueMin?: number | null;
  EstimatedValueMax?: number | null;
  CurrencyType?: number | null;
  /** PublishedTenderStatus enum: 1 Published, 2 Unpublished. */
  PublishedTenderStatus?: number | null;
  /** PublishedTenderParticipationStatus enum: 1 Open, 2 Closed. */
  PublishedTenderParticipationStatus?: number | null;
  /** ExplicitTenderStatus enum: 3 Canceled / 7 Removed are close signals. */
  ExplicitTenderStatus?: number | null;
  DisplayNumber?: string | null;
  SpecialNumber?: string | null;
  IsFrameworkAgreement?: boolean | null;
  HasContinuousEvaluation?: boolean | null;
  PbpUrl?: string | null;
  /** `PublicationAuthorities[].Mnemonic` — where the notice was published. */
  publicationAuthorities: string[];
}

export interface MercellFetchedPayload {
  detail: MercellDetail;
  listing: MercellListingItem;
  tenderId: string;
}

/** ProcedureType enum, recovered verbatim from the portal frontend bundle. */
export const MERCELL_PROCEDURE_TYPE_NAMES = {
  0: "None",
  1: "Private",
  10: "AcceleratedNegotiated",
  11: "DesignContest",
  12: "PublicCompetition",
  13: "DirectNegotiation",
  14: "CollectingOffersWithNotice",
  15: "InvitationToSpecificEconomicOperators",
  16: "MiniCompetitionWithinFA",
  17: "QualificationSystem",
  18: "DynamicPurchasingSystem",
  19: "MarketResearch",
  2: "OpenProcedure",
  20: "RestrictedProcedureUnderQS",
  21: "RestrictedProcedureUnderDps",
  22: "NegotiatedWithPriorInvitationForParticipationUnderQS",
  23: "OpenTenderBelowThreshold",
  24: "RestrictedTenderWithContractNoticeBelowThreshold",
  25: "RestrictedTenderWithoutContractNoticeBelowThreshold",
  26: "NegotiatedAwardWithContractNoticeBelowThreshold",
  27: "NegotiatedAwardWithoutContractNoticeBelowThreshold",
  3: "RestrictedProcedure",
  4: "CompetitiveProcedureWithNegotiation",
  5: "NegotiatedProcedureWithPriorCallForCompetition",
  6: "CompetitiveDialogue",
  7: "InnovationPartnership",
  8: "AcceleratedRestricted",
  9: "NegotiatedProcedure",
} as const satisfies Record<number, string>;

/** TypeOfContract enum, recovered verbatim from the portal frontend bundle. */
export const MERCELL_TYPE_OF_CONTRACT_NAMES = {
  0: "None",
  1: "Services",
  2: "Supplies",
  3: "Works",
} as const satisfies Record<number, string>;

/**
 * CurrencyType codes seen on the NL s2c instance and verified against the
 * ISO map in the frontend bundle (1 EUR … 189 XCG). A code outside this table
 * still lands numerically in `bronSpecifiek.currency_type`; the name lookup
 * just yields null.
 */
export const MERCELL_CURRENCY_NAMES = {
  1: "EUR",
  10: "JPY",
  122: "NZD",
  16: "RON",
  17: "CZK",
  18: "DKK",
  19: "PLN",
  2: "USD",
  20: "HUF",
  22: "TRY",
  3: "BGN",
  30: "AUD",
  4: "NOK",
  49: "CAD",
  5: "GBP",
  6: "ISK",
  8: "CHF",
  9: "SEK",
} as const satisfies Record<number, string>;

/** PublishedTenderParticipationStatus enum, from the frontend bundle. */
export const MERCELL_PARTICIPATION_STATUS = {
  closed: 2,
  none: 0,
  open: 1,
} as const;

/** ExplicitTenderStatus values that mean the tender can no longer be bid on. */
export const MERCELL_EXPLICIT_CLOSED_STATUSES = new Set([3, 7]);

export const mercellProcedureTypeName = (
  code: number | null | undefined
): string | null => {
  if (code === null || code === undefined) {
    return null;
  }
  // SAFETY: a key outside the table yields undefined, which `?? null` handles;
  // the assertion only narrows `code` to the table's literal keys.
  return (
    MERCELL_PROCEDURE_TYPE_NAMES[
      code as keyof typeof MERCELL_PROCEDURE_TYPE_NAMES
    ] ?? null
  );
};

export const mercellTypeOfContractName = (
  code: number | null | undefined
): string | null => {
  if (code === null || code === undefined) {
    return null;
  }
  // SAFETY: a key outside the table yields undefined, which `?? null` handles;
  // the assertion only narrows `code` to the table's literal keys.
  return (
    MERCELL_TYPE_OF_CONTRACT_NAMES[
      code as keyof typeof MERCELL_TYPE_OF_CONTRACT_NAMES
    ] ?? null
  );
};

export const mercellCurrencyName = (
  code: number | null | undefined
): string | null => {
  if (code === null || code === undefined) {
    return null;
  }
  // SAFETY: a key outside the table yields undefined, which `?? null` handles;
  // the assertion only narrows `code` to the table's literal keys.
  return (
    MERCELL_CURRENCY_NAMES[code as keyof typeof MERCELL_CURRENCY_NAMES] ?? null
  );
};

/** Listing `Status` is the participation status: 1 = open for bids. */
export const isMercellListingOpen = (
  item: Pick<MercellListingItem, "Status">
): boolean => item.Status === MERCELL_PARTICIPATION_STATUS.open;

export const MERCELL_PARSER_VERSION = "mercell/v1" as const;

/** Verified 2026-09-18: `EndIndex 100` returns 100 rows; larger untested. */
export const MERCELL_PAGE_SIZE = 100;

/** Public detail page on the portal SPA. */
export const mercellTenderUrl = (tenderId: string): string =>
  `https://s2c.mercell.com/tender/${tenderId}`;
