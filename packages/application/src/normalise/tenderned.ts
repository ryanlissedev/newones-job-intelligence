import type { TenderNedFetchedPayload } from "@ji/connectors/tenderned";
import {
  asIdString,
  isTenderNedListingOpen,
  TENDER_NED_PARSER_VERSION,
} from "@ji/connectors/tenderned";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";
import { z } from "zod";

import { toCanonicalProvincie } from "./provincie";
import {
  nutsCodesToLocatieTekst,
  parseTenderNedNutsEntries,
} from "./tenderned-nuts";
import { field } from "./types";
import type { NormaliseContext, NormalisedAanvraagDraft } from "./types";

/** NUTS-2 -> canonical province name (CTP-525, F04). This *is* explicit
 * source data -- `nutsCodes` is a structured field the API publishes, not an
 * inference from a city name. Only the 12 NL provinces map; a non-NL or
 * unrecognised NUTS-2 prefix yields no provincie.
 *
 * Both code generations are accepted, because TenderNed emits both. Verified
 * against Eurostat's own NUTS 2021 level-2 map for NL
 * (https://ec.europa.eu/eurostat/documents/345175/17780005/2021-NUTS-2-map-NL.pdf),
 * whose legend is exactly NL11-NL13, NL21-NL23, NL31-NL34, NL41-NL42 --
 * i.e. Utrecht is NL31 and Zuid-Holland NL33 under NUTS 2016 *and* NUTS
 * 2021. The **NUTS 2024** revision re-coded those two: Utrecht NL31 -> NL35
 * and Zuid-Holland NL33 -> NL36 (with a NUTS-2 boundary shift between them).
 * `NL_NUTS_LABELS` in tenderned-nuts.ts already carries the 2024 codes, so
 * keep the two tables in step. */
const NUTS2_PROVINCIE = {
  NL11: "Groningen",
  NL12: "Friesland",
  NL13: "Drenthe",
  NL21: "Overijssel",
  NL22: "Gelderland",
  NL23: "Flevoland",
  NL31: "Utrecht",
  NL32: "Noord-Holland",
  NL33: "Zuid-Holland",
  NL34: "Zeeland",
  // NUTS 2024 re-codings of NL31 / NL33 (see docblock above).
  NL35: "Utrecht",
  NL36: "Zuid-Holland",
  NL41: "Noord-Brabant",
  NL42: "Limburg",
} satisfies Record<string, string>;

/** A whole NUTS code: ISO-3166-1 alpha-2 country prefix plus 0-3
 * level-1/2/3 characters (digits or letters, e.g. `NL`, `NL32B`). Anchored
 * on purpose -- matching only the prefix turned `XX999` into land `XX` and
 * `NOT-A-CODE` into land `NO`, fabricating country facets out of arbitrary
 * leading letters (CTP-525). Anything that is not a whole NUTS code yields
 * `UNKNOWN`, as the function contract says. */
const NUTS_CODE_PATTERN = /^(?<country>[A-Z]{2})[0-9A-Z]{0,3}$/u;

/** First recognised NUTS-2 prefix across `nutsCodes`, mapped to its
 * canonical province name via `toCanonicalProvincie` (never written
 * directly -- the addendum requires every provincie string to come out of
 * that helper). */
const provincieFromNutsCodes = (
  entries: { code: string }[]
): ReturnType<typeof toCanonicalProvincie> => {
  for (const entry of entries) {
    const nuts2 = entry.code.slice(0, 4);
    if (!Object.hasOwn(NUTS2_PROVINCIE, nuts2)) {
      continue;
    }
    // SAFETY: Object.hasOwn just confirmed nuts2 is one of
    // NUTS2_PROVINCIE's own keys.
    const name = NUTS2_PROVINCIE[nuts2 as keyof typeof NUTS2_PROVINCIE];
    if (name) {
      return toCanonicalProvincie(name);
    }
  }
  return null;
};

/** ISO-2 country prefix of the first well-formed `nutsCodes` entry, or
 * `UNKNOWN` when none is well-formed. NUTS codes always start with the ISO-3166-1 alpha-2
 * country code (CTP-525, F05) -- explicit source data, not a guess. */
const landFromNutsCodes = (
  entries: { code: string }[]
): string | typeof UNKNOWN => {
  for (const entry of entries) {
    const country = NUTS_CODE_PATTERN.exec(entry.code)?.groups?.country;
    if (country) {
      return country;
    }
  }
  return UNKNOWN;
};

type TenderNedDayCount = number | string | null | undefined;

const tenderNedDayCountSchema = z.union([
  z.number().finite(),
  z.string().trim().min(1).transform(Number).refine(Number.isFinite),
]);

const finiteDays = (value: TenderNedDayCount): number | undefined => {
  const parsed = tenderNedDayCountSchema.safeParse(value);
  return parsed.success ? Number(parsed.data) : undefined;
};

const tenderNedClosingDate = (
  daysValue: TenderNedDayCount,
  observedAt: Date | undefined
): Date | undefined => {
  const days = finiteDays(daysValue);
  const observedAtMs = observedAt?.getTime();
  if (
    days === undefined ||
    days <= 0 ||
    observedAtMs === undefined ||
    !Number.isFinite(observedAtMs)
  ) {
    return undefined;
  }
  const closingAtMs = observedAtMs + days * 86_400_000;
  return Number.isFinite(closingAtMs) ? new Date(closingAtMs) : undefined;
};

export const parseTenderNedPayload = (
  payload: TenderNedFetchedPayload,
  contentHash: string,
  context?: NormaliseContext
): NormalisedAanvraagDraft => {
  const { detail } = payload;
  // Live TenderNed JSON may carry numeric IDs; coerce again in case a number
  // slipped past the connector boundary (e.g. older stored observations).
  const kenmerk = asIdString(detail.kenmerk);
  const publicatieId = asIdString(detail.publicatieId);
  const parserVersion = TENDER_NED_PARSER_VERSION;
  const seenOpen = isTenderNedListingOpen(detail);
  // TenderNed publishes no absolute closing date in the modelled API fields
  // (RJC-377): the detail carries only a relative day-count. The countdown is
  // relative to the fetch instant, so CTP-531 derives a date only from the
  // observation instant and a positive finite day-count. `publicatieDatum`
  // must not be used as a substitute. `sluitingsdatumPassed` stays hard
  // `false`; `isTenderNedListingOpen` independently closes the listing when
  // the announcement code or day-count says it is closed.
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: !seenOpen,
    current: "unknown",
    missedPolls: 0,
    seenOpen,
    sluitingsdatumPassed: false,
  });
  const cpv = detail.cpvCodes?.map((entry) => ({
    code: entry.code,
    hoofd: entry.isHoofdOpdracht ?? false,
    omschrijving: entry.omschrijving ?? null,
  }));
  const nutsEntries = parseTenderNedNutsEntries(detail.nutsCodes);
  const provincie = provincieFromNutsCodes(nutsEntries);
  const locatieLand = landFromNutsCodes(nutsEntries);

  return {
    beschrijving: field(
      detail.opdrachtBeschrijving?.trim() || detail.aanbestedingNaam,
      parserVersion,
      "detail.opdrachtBeschrijving"
    ),
    bronReferentie: field(kenmerk, parserVersion, "detail.kenmerk"),
    bronSpecifiek: field(
      {
        aankondiging: detail.aankondigingCode?.code ?? null,
        cpv: cpv ?? [],
        // Normalise to plain JSON (string | {code,omschrijving}) for JsonValue.
        nuts_codes: parseTenderNedNutsEntries(detail.nutsCodes).map((entry) =>
          entry.omschrijving
            ? { code: entry.code, omschrijving: entry.omschrijving }
            : entry.code
        ),
        opdracht_aard: detail.opdrachtAardCode?.code ?? null,
        procedure: detail.procedureCode?.code ?? null,
        provincie,
        publicatie_id: publicatieId,
        publicatiedatum: detail.publicatieDatum ?? null,
      },
      parserVersion,
      "detail"
    ),
    bronUrl: field(
      `https://www.tenderned.nl/aankondigingen/overzicht/${publicatieId}`,
      parserVersion,
      "detail.publicatieId"
    ),
    contentHash,
    extractieMethode: "api",
    lifecycle,
    // CTP-525 F05: NUTS codes always begin with the ISO-3166-1 alpha-2
    // country code -- explicit source data. "NL" is no longer a hardcoded
    // default; an absent/unrecognised nutsCodes prefix reads UNKNOWN.
    locatieLand: field(locatieLand, parserVersion, "detail.nutsCodes"),
    locatieTekst: field(
      nutsCodesToLocatieTekst(detail.nutsCodes),
      parserVersion,
      "detail.nutsCodes"
    ),
    opdrachtgeverNaam: field(
      detail.opdrachtgeverNaam?.trim() || UNKNOWN,
      parserVersion,
      "detail.opdrachtgeverNaam"
    ),
    parserVersion,
    // CTP-531: the source publishes a countdown, not an absolute date. A
    // positive finite count is anchored to ConnectorObservation.observedAt;
    // all other cases remain absent. In particular, publicatieDatum is not a
    // valid anchor and must never invent a past deadline.
    sluitingsdatum: tenderNedClosingDate(
      detail.numberOfDaysBeforeAanmeldenInschrijven,
      context?.observedAt
    ),
    // TenderNed's modelled API has no contract-start field. Its
    // `publicatieDatum` is retained above as source-specific publication
    // metadata and must not influence canonical contract-start identity.
    startDatum: field(UNKNOWN, parserVersion, "n/a (not published by source)"),
    status: lifecycle,
    tarief: {
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    },
    titel: field(
      detail.aanbestedingNaam,
      parserVersion,
      "detail.aanbestedingNaam"
    ),
  };
};

export const decodeTenderNedPayload = (
  body: Uint8Array
): TenderNedFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from TenderNed fetch.
  JSON.parse(new TextDecoder().decode(body)) as TenderNedFetchedPayload;

export const normaliseTenderNedObservation = (
  body: Uint8Array,
  contentHash: string,
  context?: NormaliseContext
): NormalisedAanvraagDraft =>
  parseTenderNedPayload(decodeTenderNedPayload(body), contentHash, context);
