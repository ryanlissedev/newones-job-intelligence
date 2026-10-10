/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- TenderNed nutsCodes I/O boundary: live API returns objects, fixtures/stored observations may still be string codes; narrowing happens here before locatie_tekst is set. */
/**
 * TenderNed NUTS → locatie_tekst (CTP-506).
 *
 * Live detail payloads emit `nutsCodes` as `{code, omschrijving}[]`; fixtures
 * and some stored observations still carry plain strings. Prefer omschrijving
 * when present, else a curated NL label map (Eurostat + TenderNed 2025 remap).
 * Multi-code rows take the most specific code (longest NL* id).
 */
import { UNKNOWN } from "@ji/domain";

/** Eurostat / TenderNed NL NUTS labels. Old+new codes share the same name. */
export const NL_NUTS_LABELS = {
  NL: "Nederland",
  NL1: "Noord-Nederland",
  NL11: "Groningen",
  NL111: "Oost-Groningen",
  NL112: "Delfzijl en omgeving",
  NL113: "Overig Groningen",
  NL114: "Oost-Groningen",
  NL115: "Overig Groningen",
  NL12: "Friesland",
  NL121: "Noord-Friesland",
  NL122: "Zuidwest-Friesland",
  NL123: "Zuidoost-Friesland",
  NL124: "Noord-Friesland",
  NL125: "Zuidwest-Friesland",
  NL126: "Zuidoost-Friesland",
  NL127: "Noord-Friesland",
  NL128: "Zuidwest-Friesland",
  NL13: "Drenthe",
  NL131: "Noord-Drenthe",
  NL132: "Zuidoost-Drenthe",
  NL133: "Zuidwest-Drenthe",
  NL2: "Oost-Nederland",
  NL21: "Overijssel",
  NL211: "Noord-Overijssel",
  NL212: "Zuidwest-Overijssel",
  NL213: "Twente",
  NL22: "Gelderland",
  NL221: "Veluwe",
  NL224: "Zuidwest-Gelderland",
  NL225: "Achterhoek",
  NL226: "Arnhem/Nijmegen",
  NL23: "Flevoland",
  NL230: "Flevoland",
  NL3: "West-Nederland",
  NL31: "Utrecht",
  NL310: "Utrecht",
  NL32: "Noord-Holland",
  NL321: "Kop van Noord-Holland",
  NL322: "Alkmaar en omgeving",
  NL323: "IJmond",
  NL324: "Agglomeratie Haarlem",
  NL325: "Zaanstreek",
  NL326: "Groot-Amsterdam",
  NL327: "Het Gooi en Vechtstreek",
  NL328: "Alkmaar en omgeving",
  NL329: "Groot-Amsterdam",
  NL32A: "Agglomeratie Haarlem",
  NL32B: "Groot-Amsterdam",
  NL33: "Zuid-Holland",
  NL331: "Agglomeratie Leiden en Bollenstreek",
  NL332: "Agglomeratie 's-Gravenhage",
  NL333: "Delft en Westland",
  NL337: "Agglomeratie Leiden en Bollenstreek",
  NL338: "Oost-Zuid-Holland",
  NL339: "Groot-Rijnmond",
  NL33A: "Zuidoost-Zuid-Holland",
  NL33B: "Oost-Zuid-Holland",
  NL33C: "Groot-Rijnmond",
  NL34: "Zeeland",
  NL341: "Zeeuwsch-Vlaanderen",
  NL342: "Overig Zeeland",
  NL35: "Utrecht",
  NL350: "Utrecht",
  NL36: "Zuid-Holland",
  NL361: "Agglomeratie 's-Gravenhage",
  NL362: "Delft en Westland",
  NL363: "Agglomeratie Leiden en Bollenstreek",
  NL364: "Zuidoost-Zuid-Holland",
  NL365: "Oost-Zuid-Holland",
  NL366: "Groot-Rijnmond",
  NL4: "Zuid-Nederland",
  NL41: "Noord-Brabant",
  NL411: "West-Noord-Brabant",
  NL412: "Midden-Noord-Brabant",
  NL413: "Noordoost-Noord-Brabant",
  NL414: "Zuidoost-Noord-Brabant",
  NL415: "Midden-Noord-Brabant",
  NL416: "Noordoost-Noord-Brabant",
  NL42: "Limburg",
  NL421: "Noord-Limburg",
  NL422: "Midden-Limburg",
  NL423: "Zuid-Limburg",
} satisfies Record<string, string>;

export interface TenderNedNutsEntry {
  readonly code: string;
  readonly omschrijving: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Title-case ALL-CAPS / noisy TenderNed omschrijving text. */
export const normaliseNutsOmschrijving = (raw: string): string => {
  const trimmed = raw.trim().replaceAll(/\s+/gu, " ");
  if (!trimmed) {
    return trimmed;
  }
  // Already mixed-case (e.g. "Agglomeratie Haarlem") — keep as-is.
  const hasLower = trimmed !== trimmed.toLocaleUpperCase("nl-NL");
  const hasUpper = trimmed !== trimmed.toLocaleLowerCase("nl-NL");
  if (hasLower && hasUpper) {
    return trimmed;
  }
  return trimmed
    .toLocaleLowerCase("nl-NL")
    .split(/(?<sep>[\s/-])/u)
    .map((part) => {
      if (part === "" || /^[\s/-]$/u.test(part)) {
        return part;
      }
      // Preserve leading apostrophe forms like "'s-gravenhage".
      if (part.startsWith("'") && part.length > 1) {
        return `'${part.charAt(1).toLocaleLowerCase("nl-NL")}${part.slice(2)}`;
      }
      return `${part.charAt(0).toLocaleUpperCase("nl-NL")}${part.slice(1)}`;
    })
    .join("");
};

export const parseTenderNedNutsEntries = (
  nutsCodes?: unknown
): TenderNedNutsEntry[] => {
  if (!Array.isArray(nutsCodes)) {
    return [];
  }
  const entries: TenderNedNutsEntry[] = [];
  for (const item of nutsCodes) {
    if (typeof item === "string") {
      const code = item.trim().toUpperCase();
      if (code) {
        entries.push({ code, omschrijving: null });
      }
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const codeRaw = item.code;
    if (typeof codeRaw !== "string") {
      continue;
    }
    const code = codeRaw.trim().toUpperCase();
    if (!code) {
      continue;
    }
    const omschrijvingRaw = item.omschrijving;
    const omschrijving =
      typeof omschrijvingRaw === "string" && omschrijvingRaw.trim()
        ? normaliseNutsOmschrijving(omschrijvingRaw)
        : null;
    entries.push({ code, omschrijving });
  }
  return entries;
};

const labelForCode = (code: string): string | null => {
  if (!Object.hasOwn(NL_NUTS_LABELS, code)) {
    return null;
  }
  // SAFETY: Object.hasOwn just confirmed code is one of NL_NUTS_LABELS's own keys.
  return NL_NUTS_LABELS[code as keyof typeof NL_NUTS_LABELS];
};

const labelForEntry = (entry: TenderNedNutsEntry): string | null => {
  if (entry.omschrijving) {
    return entry.omschrijving;
  }
  return labelForCode(entry.code);
};

/** Longer NL* codes are more specific (NUTS3 > NUTS2 > NUTS1). */
const specificity = (code: string): number => code.length;

/**
 * Map TenderNed `nutsCodes` to a curated locatie_tekst, or UNKNOWN when empty
 * / unlabelled.
 */
export const nutsCodesToLocatieTekst = (
  nutsCodes?: unknown
): string | typeof UNKNOWN => {
  const entries = parseTenderNedNutsEntries(nutsCodes);
  if (entries.length === 0) {
    return UNKNOWN;
  }
  let best: { entry: TenderNedNutsEntry; label: string } | null = null;
  for (const entry of entries) {
    const label = labelForEntry(entry);
    if (!label) {
      continue;
    }
    if (
      best === null ||
      specificity(entry.code) > specificity(best.entry.code) ||
      (specificity(entry.code) === specificity(best.entry.code) &&
        entry.omschrijving !== null &&
        best.entry.omschrijving === null)
    ) {
      best = { entry, label };
    }
  }
  return best?.label ?? UNKNOWN;
};
