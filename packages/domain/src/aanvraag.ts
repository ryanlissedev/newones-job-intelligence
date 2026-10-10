import { Schema } from "./schema-helpers";
import { UNKNOWN } from "./unknown";

/**
 * Public aanvraag / bron taxonomy schemas (ADR-0014 Slice 5 / CTP-470).
 *
 * Effect Schema is the hand-maintained SoT; TypeScript types are derived.
 * Const tuples remain for iteration and message formatting.
 */

export const AANVRAAG_LIFECYCLE = [
  "active",
  "stale",
  "closed",
  "unknown",
] as const;

/** Effect Schema SoT for aanvraag lifecycle status. */
export const AanvraagLifecycleSchema = Schema.Literals(AANVRAAG_LIFECYCLE);

export type AanvraagLifecycle = typeof AanvraagLifecycleSchema.Type;

export const BRON_CATEGORIEEN = [
  "msp_broker",
  "global_msp",
  "das_tender",
  "overheidsportaal",
  "jobboard",
  "werkenbij",
] as const;

/** Effect Schema SoT for bron categorie. */
export const BronCategorieSchema = Schema.Literals(BRON_CATEGORIEEN);

export type BronCategorie = typeof BronCategorieSchema.Type;

export const EXTRACTIE_METHODEN = [
  "api",
  "jsonld",
  "html_parser",
  "llm",
] as const;

/** Effect Schema SoT for extractie methode. */
export const ExtractieMethodeSchema = Schema.Literals(EXTRACTIE_METHODEN);

export type ExtractieMethode = typeof ExtractieMethodeSchema.Type;

export const TARIEF_EENHEDEN = ["uur", "dag", "maand"] as const;

/**
 * CTP-610: one contactpersoon as published on a vacancy by a source. The
 * `geinformeerd*`/`notificatie*` fields are pipeline-owned (the art. 14
 * disclosure trail) — a source payload never sets them; they start null.
 */
export const ContactpersoonSchema = Schema.Struct({
  email: Schema.NullOr(Schema.String),
  geinformeerdOp: Schema.NullOr(Schema.String),
  naam: Schema.NullOr(Schema.String),
  notificatieKanaal: Schema.NullOr(Schema.String),
  rol: Schema.NullOr(Schema.String),
  telefoon: Schema.NullOr(Schema.String),
});

export type Contactpersoon = typeof ContactpersoonSchema.Type;

/** Effect Schema SoT for tarief eenheid. */
export const TariefEenheidSchema = Schema.Literals(TARIEF_EENHEDEN);

export type TariefEenheid = typeof TariefEenheidSchema.Type;

/** Effect Schema SoT for money fields on aanvragen. */
export const MoneyFieldsSchema = Schema.Struct({
  amount: Schema.NullOr(Schema.String),
  currency: Schema.String,
});

export type MoneyFields = typeof MoneyFieldsSchema.Type;

export const defaultMoneyCurrency = "EUR";

export const isUnknownLifecycle = (value: string): value is typeof UNKNOWN =>
  value === UNKNOWN;
