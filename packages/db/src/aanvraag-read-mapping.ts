import {
  NL_PROVINCIES,
  normaliseSkills,
  toValidPublicationDate,
} from "@ji/application/normalise";
import { z } from "zod";

export interface AanvraagBronFacts {
  readonly contracttype: string | null;
  /** Duration text the source published when only a duration, not an end date, is given (CTP-514, F11). */
  readonly duur: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly opleidingsniveau: string | null;
  /** One of the 12 canonical NL province names, or null. Never derived here. */
  readonly provincie: string | null;
  readonly publicatiedatum: string | null;
  readonly skills: readonly string[];
  readonly startDatum: string | null;
  readonly werkvorm: string | null;
}

const sourceTextSchema = z
  .string()
  .refine((value) => value.trim() !== "")
  .nullable()
  .optional()
  // oxlint-disable-next-line promise/prefer-await-to-then -- Zod's synchronous fallback API, not Promise.catch
  .catch(null);

/**
 * A province is only honest when the normaliser wrote one of the 12 canonical
 * names. Anything else (a city, a region, a source spelling that was never
 * canonicalised) is rejected rather than shown: canonicalisation is the
 * normaliser's job, not the read path's.
 */
const provincieSchema = z
  .enum(NL_PROVINCIES)
  .nullable()
  .optional()
  // oxlint-disable-next-line promise/prefer-await-to-then -- Zod's synchronous fallback API, not Promise.catch
  .catch(null);

const bronFactsInputSchema = z.object({
  contract_type: sourceTextSchema,
  contracttype: sourceTextSchema,
  duration: sourceTextSchema,
  duur: sourceTextSchema,
  education_level: sourceTextSchema,
  gepubliceerd_op: sourceTextSchema,
  json_ld_date_posted: sourceTextSchema,
  looptijd_tekst: sourceTextSchema,
  opdrachtgeverNaam: sourceTextSchema,
  opdrachtgever_naam: sourceTextSchema,
  opleidingsniveau: sourceTextSchema,
  periode: sourceTextSchema,
  provincie: provincieSchema,
  publicatie_datum: sourceTextSchema,
  publicatiedatum: sourceTextSchema,
  skills: z.unknown().optional().transform(normaliseSkills),
  startDatum: sourceTextSchema,
  start_datum: sourceTextSchema,
  verwachte_duur: sourceTextSchema,
  werkvorm: sourceTextSchema,
});

/** bronSpecifiek keys the read path consumes into AanvraagBronFacts.
 * Keep this in sync with bronFactsInputSchema.shape above. */
export const AANVRAAG_BRON_FACT_KEYS: readonly string[] = Object.keys(
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `shape` is the Zod schema property that owns the field keys we export here.
  bronFactsInputSchema.shape
);

const firstSourceText = (
  ...values: readonly (null | string | undefined)[]
): string | null =>
  values.find((value) => value !== null && value !== undefined) ?? null;

const publicationDate = (
  values: z.output<typeof bronFactsInputSchema>
): string | null =>
  toValidPublicationDate(
    firstSourceText(
      values.publicatiedatum,
      values.gepubliceerd_op,
      values.publicatie_datum,
      values.json_ld_date_posted
    )
  );

export const readAanvraagBronFacts = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- curated JSON I/O boundary is parsed by bronFactsInputSchema before field access
  bronSpecifiek: unknown
): AanvraagBronFacts => {
  const parsed = bronFactsInputSchema.safeParse(bronSpecifiek);
  if (!parsed.success) {
    return {
      contracttype: null,
      duur: null,
      opdrachtgeverNaam: null,
      opleidingsniveau: null,
      provincie: null,
      publicatiedatum: null,
      skills: [],
      startDatum: null,
      werkvorm: null,
    };
  }
  const values = parsed.data;
  return {
    contracttype: firstSourceText(values.contracttype, values.contract_type),
    duur: firstSourceText(
      values.duur,
      values.duration,
      values.periode,
      values.looptijd_tekst,
      values.verwachte_duur
    ),
    opdrachtgeverNaam: firstSourceText(
      values.opdrachtgeverNaam,
      values.opdrachtgever_naam
    ),
    opleidingsniveau: firstSourceText(
      values.opleidingsniveau,
      values.education_level
    ),
    provincie: values.provincie ?? null,
    publicatiedatum: publicationDate(values),
    skills: values.skills,
    startDatum: firstSourceText(values.startDatum, values.start_datum),
    werkvorm: values.werkvorm ?? null,
  };
};
