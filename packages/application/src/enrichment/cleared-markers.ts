import { CLEARED, CLEARED_BRON_MARKER_KEY } from "@ji/domain";
import { z } from "zod";

const markerRecordSchema = z.record(z.string(), z.literal(true));

const bronSpecifiekObjectSchema = z
  .object({
    [CLEARED_BRON_MARKER_KEY]: markerRecordSchema.optional(),
    contract_type: z.string().nullable().optional(),
    contracttype: z.string().nullable().optional(),
    education_level: z.string().nullable().optional(),
    eindDatum: z.string().nullable().optional(),
    eind_datum: z.string().nullable().optional(),
    locatie: z.string().nullable().optional(),
    locatieTekst: z.string().nullable().optional(),
    locatie_tekst: z.string().nullable().optional(),
    opdrachtgever: z.string().nullable().optional(),
    opdrachtgeverNaam: z.string().nullable().optional(),
    opdrachtgever_naam: z.string().nullable().optional(),
    opleiding: z.string().nullable().optional(),
    opleidingsniveau: z.string().nullable().optional(),
    organisatie: z.string().nullable().optional(),
    sluitings_datum: z.string().nullable().optional(),
    sluitingsdatum: z.string().nullable().optional(),
    startDatum: z.string().nullable().optional(),
    start_datum: z.string().nullable().optional(),
    tarief: z.string().nullable().optional(),
    tariefEenheid: z.string().nullable().optional(),
    tariefMax: z.string().nullable().optional(),
    tariefMin: z.string().nullable().optional(),
    tarief_eenheid: z.string().nullable().optional(),
    tarief_max: z.string().nullable().optional(),
    tarief_min: z.string().nullable().optional(),
    uren: z.string().nullable().optional(),
    urenPerWeek: z.string().nullable().optional(),
    uren_per_week: z.string().nullable().optional(),
    valid_through: z.string().nullable().optional(),
    werkvorm: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Read durable CLEARED markers (#213 strip + Slice 4) plus any transient
 * CLEARED string values still present before strip. Markers never store the
 * CLEARED sentinel itself — only which commercial keys stay tombstoned.
 */
export const readDurableClearedKeys = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- curated JSON I/O boundary; parsed by bronSpecifiekObjectSchema
  bronSpecifiek: unknown
): ReadonlySet<string> => {
  const cleared = new Set<string>();
  const parsed = bronSpecifiekObjectSchema.safeParse(bronSpecifiek);
  if (!parsed.success) {
    return cleared;
  }
  const markers = parsed.data[CLEARED_BRON_MARKER_KEY];
  if (markers) {
    for (const key of Object.keys(markers)) {
      cleared.add(key);
    }
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === CLEARED_BRON_MARKER_KEY) {
      continue;
    }
    if (value === CLEARED) {
      cleared.add(key);
    }
  }
  return cleared;
};

export const durableClearedIntersects = (
  bronCleared: ReadonlySet<string>,
  keys: readonly string[]
): boolean => keys.some((key) => bronCleared.has(key));
