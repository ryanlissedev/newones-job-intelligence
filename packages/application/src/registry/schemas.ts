import { AanvraagLifecycleSchema } from "@ji/domain";
import { Schema } from "effect";

import type { SchemaType } from "./schema-helpers";
import {
  FiniteNumber,
  IsoDateTimeString,
  optionalField,
  PositiveInteger,
  toCapabilitySchema,
  UuidString,
} from "./schema-helpers";

/** Browser-safe lifecycle values shared by the search wire contract and web UI. */
export { AANVRAAG_LIFECYCLE } from "@ji/domain";
export type { AanvraagLifecycle } from "@ji/domain";

/**
 * Slice A capability contracts (ADR-0014 / CTP-469).
 *
 * Effect Schema is the hand-maintained source of truth; the exported
 * `*Schema` values are the derived adapters registry, `@ji/db` and the
 * MCP/REST descriptors consume. See `./schema-helpers.ts`.
 */

export const SLICE_A_SCHEMA_VERSION = "slice-a-v1" as const;

const searchFilters = Schema.Struct({
  bronIds: optionalField(Schema.Array(UuidString)),
  contracttype: optionalField(Schema.Array(Schema.String)),
  freshnessDays: optionalField(PositiveInteger),
  locatie: optionalField(Schema.Array(Schema.String)),
  locatieLand: optionalField(Schema.Array(Schema.String)),
  provincies: optionalField(Schema.Array(Schema.String)),
  publicatiedatumTot: optionalField(IsoDateTimeString),
  publicatiedatumVanaf: optionalField(IsoDateTimeString),
  queryScope: optionalField(Schema.Literals(["title", "all"] as const)),
  skills: optionalField(Schema.Array(Schema.String)),
  status: optionalField(Schema.Array(AanvraagLifecycleSchema)),
  tariefEenheid: optionalField(Schema.Array(Schema.String)),
  tariefMax: optionalField(FiniteNumber),
  tariefMin: optionalField(FiniteNumber),
  urenPerWeekMax: optionalField(FiniteNumber),
  urenPerWeekMin: optionalField(FiniteNumber),
  werkvormen: optionalField(Schema.Array(Schema.String)),
});

export const searchFiltersSchema = toCapabilitySchema(searchFilters);

/** Wire SearchFilters DTO — serialisable SoT for web + handlers (CTP-475). */
export type SearchFilters = SchemaType<typeof searchFiltersSchema>;

const sliceADomainFailure = Schema.Struct({
  code: Schema.Literals([
    "NOT_FOUND",
    "FORBIDDEN_FULL",
    "SYNTAX_ERROR",
    "VALIDATION_ERROR",
    "ALREADY_ACKED",
    "ALREADY_APPROVED",
    "APPROVAL_EXPIRED",
    "APPROVAL_MISMATCH",
    "APPROVAL_NOT_FOUND",
    "EXPORT_DISABLED",
  ]),
  details: optionalField(Schema.Unknown),
  message: Schema.String,
});

export const sliceADomainFailureSchema =
  toCapabilitySchema(sliceADomainFailure);

export type SliceADomainFailure = SchemaType<typeof sliceADomainFailureSchema>;

export const notFoundByIdDetailsSchema = toCapabilitySchema(
  Schema.Struct({ id: UuidString })
);

export const notFoundByRefDetailsSchema = toCapabilitySchema(
  Schema.Struct({ ref: Schema.String })
);

export const notFoundByBronIdDetailsSchema = toCapabilitySchema(
  Schema.Struct({ bronId: UuidString })
);

export const notFoundByAlertIdDetailsSchema = toCapabilitySchema(
  Schema.Struct({ alertId: UuidString })
);

export const syntaxErrorDetailsSchema = toCapabilitySchema(
  Schema.Struct({
    code: Schema.Literal("syntax_error"),
    message: Schema.String,
    offset: FiniteNumber,
  })
);

export const invalidSnapshotSelectionDetailsSchema = toCapabilitySchema(
  Schema.Struct({ unknownIds: Schema.Array(UuidString) })
);

export type SliceADomainFailureDetails =
  | SchemaType<typeof invalidSnapshotSelectionDetailsSchema>
  | SchemaType<typeof notFoundByAlertIdDetailsSchema>
  | SchemaType<typeof notFoundByBronIdDetailsSchema>
  | SchemaType<typeof notFoundByIdDetailsSchema>
  | SchemaType<typeof notFoundByRefDetailsSchema>
  | SchemaType<typeof syntaxErrorDetailsSchema>;

/** Markering status literals — shared SoT for handlers + web (CTP-475). */
export const MARKERING_STATUSES = [
  "relevant",
  "niet_relevant",
  "gevolgd",
] as const;

export const MarkeringStatusSchema = Schema.Literals(MARKERING_STATUSES);

export type MarkeringStatus = typeof MarkeringStatusSchema.Type;

/**
 * Search scope / sort literals — shared SoT for handlers + web (CTP-475).
 * Values must stay lockstep with `@ji/search` (partition.ts / types.ts);
 * web must not import `@ji/search` (pulls Node builtins via @ji/performance).
 */
export const SEARCH_SCOPES = ["active", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export const DEFAULT_SEARCH_SCOPE: SearchScope = "active";

export const SEARCH_SORT_OPTIONS = [
  "relevance",
  "newest",
  "oldest",
  "rate-high",
  "rate-low",
  "closing-soon",
  "title-asc",
  "company-asc",
] as const;
export type SearchSort = (typeof SEARCH_SORT_OPTIONS)[number];

/** Manticore max_matches window — lockstep with `@ji/search` SEARCH_WINDOW_LIMIT. */
export const SEARCH_WINDOW_LIMIT = 1000;

/** Markering readback fields returned by get/markeer capabilities. */
export const markeringReadbackSchema = toCapabilitySchema(
  Schema.Struct({
    reden: Schema.NullOr(Schema.String),
    revision: PositiveInteger,
    status: MarkeringStatusSchema,
    updatedAt: IsoDateTimeString,
  })
);

export type MarkeringReadback = SchemaType<typeof markeringReadbackSchema>;

/**
 * REST capability error envelope (`apps/server` transport).
 * Wider than {@link sliceADomainFailureSchema}: includes transport codes
 * (UNAUTHENTICATED, CSRF_REJECTED, …) as plain strings.
 */
export const restCapabilityFailureSchema = toCapabilitySchema(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.String,
      details: optionalField(Schema.Unknown),
      message: Schema.String,
      // The REST transport stamps every failure with its request id.
      requestId: optionalField(Schema.String),
    }),
    // Invocation failures serialize as `{ error, ok: false }`.
    ok: optionalField(Schema.Literal(false)),
  })
);

export type RestCapabilityFailure = SchemaType<
  typeof restCapabilityFailureSchema
>;

export const previewText = (value: string, maxLength = 500): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
