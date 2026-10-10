import type { AanvraagVersieView, MarkeringReadback } from "../contracts";
import { isSafeHref, stripHtmlToText } from "../sanitize-job-html";
import type {
  JobContractType,
  JobLifecycleStatus,
  JobListing,
  JobMarkering,
  JobRatePeriod,
  JobSource,
  JobSourceRecord,
} from "../types";
import { bronNameToSource } from "./bron-catalog";
import type { BronCatalogEntry } from "./bron-catalog";

/**
 * Preview shape returned inside get/batch aanvraag envelopes.
 * Wire envelope SoT: getAanvraagOutputSchema / batchGetAanvragenOutputSchema
 * (`aanvraag` is UnknownRecord on the wire; this is the curated preview the
 * handlers put there).
 */
export interface AanvraagPreview {
  readonly beschrijving: string;
  readonly bronId: string;
  readonly bronReferentie: string;
  readonly bronUrl?: string | null;
  /** CTP-610: contactpersonen the source published (full mode only). */
  readonly contactpersonen?: readonly {
    readonly email: string | null;
    readonly naam: string | null;
    readonly rol: string | null;
    readonly telefoon: string | null;
  }[];
  readonly contracttype?: string | null;
  /** CTP-610: dedup-group identity — present in preview so list rows can
   * badge duplicates without recruiter detail. */
  readonly dedupGroepId?: string | null;
  readonly duur?: string | null;
  readonly enrichedFields?: readonly {
    readonly confidence: number;
    readonly field:
      | "beschrijving"
      | "contract"
      | "einddatum"
      | "locatie"
      | "opleiding"
      | "organisatie"
      | "publicatiedatum"
      | "remote"
      | "sluitingsdatum"
      | "startdatum"
      | "tarief"
      | "uren";
    readonly source: "deterministic" | "llm";
  }[];
  readonly eindDatum?: string | null;
  readonly id: string;
  readonly locatie?: string | null;
  readonly locatieLand?: string | null;
  readonly opdrachtgeverNaam?: string | null;
  readonly opleidingsniveau?: string | null;
  readonly provincie?: string | null;
  readonly publicatiedatum?: string | null;
  readonly rawPayloadRef: string;
  readonly scrapeRunId: string;
  readonly skills?: readonly string[];
  readonly sluitingsdatum?: string | null;
  readonly startDatum?: string | null;
  readonly status: string;
  readonly tariefEenheid?: string | null;
  readonly tariefMax?: number | null;
  readonly tariefMin?: number | null;
  readonly tariefValuta?: string | null;
  readonly titel: string;
  readonly urenPerWeek?: string | null;
  readonly werkvorm?: string | null;
}

/** Wire markering readback — SoT markeringReadbackSchema (CTP-475). */
export type AanvraagMarkeringView = MarkeringReadback;

const mapApiStatus = (status: string): JobLifecycleStatus => {
  switch (status) {
    case "stale": {
      return "closing-soon";
    }
    case "closed": {
      return "closed";
    }
    default: {
      return "open";
    }
  }
};

// RJC-368: previously fell back to the literal "tenderned" whenever the bron
// naam didn't match one of 4 hardcoded brand names — silently mislabeling
// every other registered source. bronNameToSource is now a total slugifier,
// so the only remaining fallback is an unknown bronId itself (never a
// specific other bron's name).
const resolveSource = (
  bronId: string,
  bronCatalog: ReadonlyMap<string, BronCatalogEntry>
): { readonly displayName: string; readonly name: JobSource } => {
  const bron = bronCatalog.get(bronId);
  return bron
    ? { displayName: bron.naam, name: bronNameToSource(bron.naam) }
    : { displayName: bronId, name: bronId };
};

const latestVersie = (
  versies: readonly AanvraagVersieView[]
): AanvraagVersieView | null =>
  versies.length === 0
    ? null
    : ([...versies].toSorted(
        (left, right) =>
          Date.parse(right.geldigVan) - Date.parse(left.geldigVan)
      )[0] ?? null);

const previewSummary = (value: string): string => {
  const plain = stripHtmlToText(value) || value.trim();
  return plain.length <= 220 ? plain : `${plain.slice(0, 217)}…`;
};

const optionalText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
};

const mapContractType = (value: string | null): JobContractType | null => {
  switch (value) {
    case "detachering":
    case "freelance":
    case "interim":
    case "vast": {
      return value;
    }
    default: {
      return null;
    }
  }
};

const mapRatePeriod = (value: string | null | undefined): JobRatePeriod => {
  switch (value?.trim().toLocaleLowerCase("nl-NL")) {
    case "uur": {
      return "hour";
    }
    case "dag": {
      return "day";
    }
    case "maand": {
      return "month";
    }
    case "jaar": {
      return "year";
    }
    default: {
      return "unknown";
    }
  }
};

const normalizeRateBound = (
  value: number | null | undefined
): number | null | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const mapRate = (aanvraag: AanvraagPreview): JobListing["rate"] => {
  const { tariefEenheid, tariefMax, tariefMin, tariefValuta } = aanvraag;
  if (tariefValuta !== "EUR") {
    return null;
  }

  const min = normalizeRateBound(tariefMin);
  const max = normalizeRateBound(tariefMax);
  if (
    min === null ||
    max === null ||
    (min === undefined && max === undefined) ||
    (min !== undefined && max !== undefined && min > max)
  ) {
    return null;
  }

  const period = mapRatePeriod(tariefEenheid);
  if (min !== undefined && max !== undefined) {
    return { currency: "EUR", max, min, period };
  }
  if (min !== undefined) {
    return { currency: "EUR", max: null, min, period };
  }
  if (max !== undefined) {
    return { currency: "EUR", max, min: null, period };
  }
  return null;
};

const REMOTE_WERKVORM = /\b(?<kind>remote|thuis|hybride|hybrid|telecommute)\b/u;
const ONSITE_WERKVORM = /\b(?<kind>op locatie|kantoor|onsite)\b/u;

const mapRemote = (werkvorm: string | null | undefined): boolean | null => {
  if (!werkvorm || werkvorm.trim() === "") {
    return null;
  }
  const lower = werkvorm.toLowerCase();
  if (REMOTE_WERKVORM.test(lower)) {
    return true;
  }
  if (ONSITE_WERKVORM.test(lower)) {
    return false;
  }
  return null;
};

const bronUrlOrFallback = (aanvraag: AanvraagPreview): string => {
  const candidate = aanvraag.bronUrl?.trim() ?? "";
  if (candidate.length > 0 && isSafeHref(candidate)) {
    return candidate;
  }
  return `#bron/${aanvraag.bronId}`;
};

const toSourceRecord = (input: {
  readonly aanvraag: AanvraagPreview;
  readonly source: { readonly displayName: string; readonly name: JobSource };
  readonly versie: AanvraagVersieView | null;
}): JobSourceRecord => ({
  displayName: input.source.displayName,
  firstSeenAt: null,
  id: `${input.source.name}-${input.aanvraag.bronReferentie}`,
  lastSeenAt: null,
  name: input.source.name,
  normalizationVersion: input.versie?.normalisatieversie ?? "onbekend",
  reference: input.aanvraag.bronReferentie,
  scrapeRunId: input.aanvraag.scrapeRunId,
  url: bronUrlOrFallback(input.aanvraag),
  validFrom: input.versie?.geldigVan ?? null,
  validTo: input.versie?.geldigTot ?? null,
});

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- these guards ARE the I/O boundary: the aanvraag envelope is UnknownRecord on the wire and `contactpersonen` gets its concrete shape established here before the renderer reads it. */
const isContactRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonBlankText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

/** The envelope is UnknownRecord on the wire — a non-array `contactpersonen`
 * or a null entry must not reach the renderer (.map would crash there). */
const toJobContactpersonen = (
  value: AanvraagPreview["contactpersonen"]
): JobListing["contactpersonen"] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isContactRecord(entry)) {
      return [];
    }
    const email = isNonBlankText(entry.email) ? entry.email : null;
    const naam = isNonBlankText(entry.naam) ? entry.naam : null;
    const telefoon = isNonBlankText(entry.telefoon) ? entry.telefoon : null;
    if (!(email || telefoon || naam)) {
      return [];
    }
    return [
      {
        email,
        naam,
        rol: isNonBlankText(entry.rol) ? entry.rol : null,
        telefoon,
      },
    ];
  });
};

export const mapAanvraagToJobListing = (input: {
  readonly aanvraag: AanvraagPreview;
  readonly bronCatalog: ReadonlyMap<string, BronCatalogEntry>;
  readonly markering?: JobMarkering | null;
  readonly rawPreview?: string;
  readonly versies: readonly AanvraagVersieView[];
}): JobListing => {
  const source = resolveSource(input.aanvraag.bronId, input.bronCatalog);
  const versie = latestVersie(input.versies);

  return {
    closingAt: input.aanvraag.sluitingsdatum ?? null,
    contactpersonen: toJobContactpersonen(input.aanvraag.contactpersonen),
    contractType: mapContractType(input.aanvraag.contracttype ?? null),
    country: input.aanvraag.locatieLand === "NL" ? "NL" : null,
    dedupGroepId: input.aanvraag.dedupGroepId ?? null,
    description: input.aanvraag.beschrijving,
    duration: optionalText(input.aanvraag.duur),
    educationLevel: optionalText(input.aanvraag.opleidingsniveau),
    endDate: optionalText(input.aanvraag.eindDatum),
    enrichedFields: input.aanvraag.enrichedFields ?? [],
    hoursPerWeek: optionalText(input.aanvraag.urenPerWeek),
    id: input.aanvraag.id,
    location: input.aanvraag.locatie ?? null,
    markering: input.markering ?? null,
    organization: input.aanvraag.opdrachtgeverNaam ?? null,
    provincie: input.aanvraag.provincie ?? null,
    publishedAt: input.aanvraag.publicatiedatum ?? null,
    rate: mapRate(input.aanvraag),
    rawPreview: input.rawPreview,
    remote: mapRemote(input.aanvraag.werkvorm),
    skills: input.aanvraag.skills ?? [],
    sourceRecords: [
      toSourceRecord({ aanvraag: input.aanvraag, source, versie }),
    ],
    startDate: optionalText(input.aanvraag.startDatum),
    status: mapApiStatus(input.aanvraag.status),
    summary: previewSummary(input.aanvraag.beschrijving),
    title: input.aanvraag.titel,
    workArrangement: input.aanvraag.werkvorm?.trim() || null,
  };
};
