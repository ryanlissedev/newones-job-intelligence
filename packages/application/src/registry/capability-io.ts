/**
 * Capability wire I/O schemas (Effect Schema SoT).
 *
 * Browser-safe: no `@ji/search`, `@ji/performance`, or handler runtime.
 * Handlers and `web-contracts` both consume this module (CTP-475).
 */

import { DEFAULT_SEARCH_PAGE_SIZE } from "@ji/domain";
import { Schema } from "effect";

import {
  FiniteNumber,
  IsoDateTimeString,
  NonNegativeInteger,
  optionalField,
  PositiveInteger,
  toCapabilitySchema,
  UnknownRecord,
  UuidString,
} from "./schema-helpers";
import {
  MarkeringStatusSchema,
  markeringReadbackSchema,
  SEARCH_SCOPES,
  SEARCH_SORT_OPTIONS,
  SEARCH_WINDOW_LIMIT,
  searchFiltersSchema,
} from "./schemas";

const facetBuckets = Schema.Array(
  Schema.Struct({ count: FiniteNumber, value: Schema.String })
);

// Aanvraag envelopes deliberately remain open records: full detail can carry
// source-specific fields. These typed optional keys keep the curated contract
// visible and validate the period fields shared by preview and full reads.
const aanvraagWireRecord = Schema.StructWithRest(
  Schema.Struct({
    eindDatum: optionalField(Schema.NullOr(Schema.String)),
    startDatum: optionalField(Schema.NullOr(Schema.String)),
    urenPerWeek: optionalField(Schema.NullOr(Schema.String)),
  }),
  [UnknownRecord]
);

/** Max search page size (CTP-509). Window remains SEARCH_WINDOW_LIMIT; over-limit is a validation error (never silent truncate). */
export const SEARCH_MAX_LIMIT = 1000;

export const searchAanvragenInputSchema = toCapabilitySchema(
  Schema.Struct({
    filters: optionalField(searchFiltersSchema.effect),
    limit: optionalField(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(SEARCH_MAX_LIMIT))
    ),
    offset: optionalField(
      NonNegativeInteger.check(
        Schema.isLessThanOrEqualTo(SEARCH_WINDOW_LIMIT - 1)
      )
    ),
    query: Schema.String,
    /**
     * Partitions to read (RJC-383). Default "active": the placeable stock.
     * "all" also searches the archive (closed / stale / expired work) —
     * the "ook in archief zoeken" toggle.
     */
    scope: optionalField(Schema.Literals(SEARCH_SCOPES)),
    sort: optionalField(Schema.Literals(SEARCH_SORT_OPTIONS)),
  }).check(
    // offset + limit must stay inside Manticore's max_matches window (RJC-380,
    // SEARCH_WINDOW_LIMIT): past it a request silently comes back with fewer or
    // no hits while `total` still reports the true count. Rejecting here keeps
    // the last navigable page exactly floor(windowLimit / pageSize) for every
    // page size, which is what the web derives `totalPages` from (RJC-378).
    Schema.makeFilter((input) =>
      (input.offset ?? 0) + (input.limit ?? DEFAULT_SEARCH_PAGE_SIZE) >
      SEARCH_WINDOW_LIMIT
        ? `offset + limit must not exceed ${SEARCH_WINDOW_LIMIT}`
        : undefined
    )
  )
);

export const searchAanvragenOutputSchema = toCapabilitySchema(
  Schema.Struct({
    /** Matches the same search has in the archive; present for scope "active" only (RJC-383), null when the count failed. */
    archiveTotal: optionalField(Schema.NullOr(NonNegativeInteger)),
    emptyReason: optionalField(Schema.String),
    facets: Schema.Struct({
      bron_id: facetBuckets,
      contracttype: facetBuckets,
      locatie: facetBuckets,
      locatie_land: facetBuckets,
      provincie: facetBuckets,
      skills: facetBuckets,
      status: facetBuckets,
    }),
    hits: Schema.Array(
      Schema.Struct({ id: Schema.String, weight: FiniteNumber })
    ),
    ids: Schema.Array(Schema.String),
    incomplete: Schema.Boolean,
    indexVersion: FiniteNumber,
    parserVersion: FiniteNumber,
    /** Partitions this result was read from (RJC-383). */
    scope: Schema.Literals(SEARCH_SCOPES),
    /** True hit count — may exceed what is retrievable (see windowLimit). */
    total: FiniteNumber,
    /** Deepest reachable offset + limit; pages beyond it cannot be requested. */
    windowLimit: PositiveInteger,
  })
);

export const getAanvraagInputSchema = toCapabilitySchema(
  Schema.Struct({
    full: optionalField(Schema.Boolean),
    id: UuidString,
  })
);

export const getAanvraagOutputSchema = toCapabilitySchema(
  Schema.Struct({
    aanvraag: aanvraagWireRecord,
    markering: Schema.NullOr(markeringReadbackSchema.effect),
  })
);

export const listVersiesInputSchema = toCapabilitySchema(
  Schema.Struct({ aanvraagId: UuidString })
);

const versieView = Schema.Struct({
  geldigTot: Schema.NullOr(Schema.String),
  geldigVan: Schema.String,
  id: Schema.String,
  normalisatieversie: Schema.String,
  scrapeRunId: Schema.String,
});

export const listVersiesOutputSchema = toCapabilitySchema(
  Schema.Array(versieView)
);

/** Batched search hydration cap (RJC-379) — matches SEARCH_MAX_LIMIT. */
export const BATCH_GET_AANVRAGEN_MAX_IDS = SEARCH_MAX_LIMIT;

export const batchGetAanvragenInputSchema = toCapabilitySchema(
  Schema.Struct({
    full: optionalField(Schema.Boolean),
    ids: Schema.Array(UuidString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(BATCH_GET_AANVRAGEN_MAX_IDS)
    ),
  })
);

export const batchGetAanvragenOutputSchema = toCapabilitySchema(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        aanvraag: aanvraagWireRecord,
        id: Schema.String,
        markering: Schema.NullOr(markeringReadbackSchema.effect),
        versies: Schema.Array(versieView),
      })
    ),
  })
);

export const markeerAanvraagInputSchema = toCapabilitySchema(
  Schema.Struct({
    aanvraagId: UuidString,
    reden: optionalField(Schema.NullOr(Schema.String)),
    status: MarkeringStatusSchema,
  })
);

const markeringViewFields = {
  aanvraagId: Schema.String,
  reden: Schema.NullOr(Schema.String),
  revision: PositiveInteger,
  status: MarkeringStatusSchema,
  updatedAt: IsoDateTimeString,
} as const;

export const markeerAanvraagOutputSchema = toCapabilitySchema(
  Schema.Struct({ ...markeringViewFields, auditEventId: Schema.String })
);

export const getMarkeringInputSchema = toCapabilitySchema(
  Schema.Struct({ aanvraagId: UuidString })
);

export const getMarkeringOutputSchema = toCapabilitySchema(
  Schema.Struct(markeringViewFields)
);
