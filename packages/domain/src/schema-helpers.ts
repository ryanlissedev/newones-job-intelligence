/**
 * Shared Effect Schema helpers for `@ji/domain`.
 *
 * ADR-0014 / Slice 5 (CTP-470): Effect Schema is the hand-maintained source of
 * truth for public domain models (`aanvraag`, ids, lifecycle, bron-config).
 * Pure functions and the Boolean parser stay Effect-free.
 *
 * Production Effect *runtime* activation elsewhere stays OFF. Motian
 * rematch/backfill paths are untouched. There is deliberately **no** second
 * hand-written Zod canonical for the same domain contracts.
 */

import { Schema } from "effect";

/** Non-empty string (min length 1). */
export const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Trimmed non-empty string. */
export const TrimmedNonEmptyString = Schema.Trim.check(Schema.isMinLength(1));

/** Finite JSON number. */
export const FiniteNumber = Schema.Finite;

/** Integer. */
export const IntegerNumber = Schema.Number.check(Schema.isInt());

/** Positive integer (> 0). */
export const PositiveInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

/** Non-negative integer (≥ 0). */
export const NonNegativeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);

/** Opaque domain id string (not UUID-validated — callers may use non-UUID refs). */
export const DomainIdString = Schema.String;

/**
 * CTP-500: `bron_referentie` sits in two unique btree indexes
 * (`source_record_bron_referentie_uidx`, `aanvraag_bron_referentie_uidx`)
 * and comes straight from source input (an id for most connectors, a URL
 * path for json-ld, an href slug for Flinter). A btree v4 entry caps at
 * 2704 bytes, so an oversized value would fail the insert. This is the same
 * cap `dedup_key` uses (CTP-499). Counted in UTF-8 bytes where the value is
 * produced; the schema check here counts code units, which a value at or
 * under the byte cap always satisfies too.
 */
export const BRON_REFERENTIE_MAX_LENGTH = 2000;

/** Non-empty `bron_referentie` at or under {@link BRON_REFERENTIE_MAX_LENGTH}. */
export const BronReferentieSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BRON_REFERENTIE_MAX_LENGTH)
);

/**
 * CTP-500: `bron.naam` is free operator input under
 * `bron_naam_lower_uidx`, whose `lower()` expression carries the whole
 * string into the btree. A plain maximum is enough here (no digest): a
 * name is shown, not matched by content.
 */
export const BRON_NAAM_MAX_LENGTH = 200;

/** Non-empty `bron.naam` at or under {@link BRON_NAAM_MAX_LENGTH}. */
export const BronNaamSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BRON_NAAM_MAX_LENGTH)
);

export { Schema } from "effect";
