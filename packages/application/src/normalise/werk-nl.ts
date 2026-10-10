import type {
  WerkNlFetchedPayload,
  WerkNlSearchItem,
  WerkNlVacatureDetail,
} from "@ji/connectors/werk-nl";
import { WERK_NL_PARSER_VERSION } from "@ji/connectors/werk-nl";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { toDraftContactpersonen } from "./contactpersonen";
import { formatHoursPerWeek } from "./hours";
import { parseTariefFromText } from "./tarief";
import {
  closingMomentInstant,
  field,
  hasClosingMomentPassed,
  stripHtml,
} from "./types";
import type { NormaliseContext, NormalisedAanvraagDraft } from "./types";

const keep = <Value>(value: Value | null | undefined): Value | null =>
  value ?? null;

const referenceString = (value: number | string | null | undefined): string => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "";
};

const firstText = (
  ...candidates: (string | null | undefined)[]
): string | typeof UNKNOWN => {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return UNKNOWN;
};

/** `proposition.salary.amountIndication` is a bare range like "2500-3000"
 * with no unit or currency text; the "salaris" hint feeds the range branch
 * and manufactures eenheid "maand" (the jobboard-salaris rule). Whether that
 * manufactured unit is trustworthy depends on `salary.type` — the numeric
 * beloningsvorm code, positional in the live codelijst
 * `/mijn-werkmap/api/codelijsten/beloningsvorm` (2026-09-18):
 * 1 = "vast loon / uurloon" (a bare range can be hourly — "maand" would
 * corrupt it into €15/maand), 2 = "vrij ondernemerschap", 3 = "commissie",
 * 4 = "beloning conform CAO" (monthly gross). Only type 4 and an absent
 * code keep the manufactured "maand"; ambiguous codes keep min/max but
 * demote eenheid to UNKNOWN. A unit the range text carries itself
 * ("per uur") always wins — only the manufactured "maand" is demoted. */
const MONTHLY_SALARY_TYPE = 4;
const parseWerkNlSalary = (
  amountIndication: string | null | undefined,
  salaryType: number | null | undefined
) => {
  const trimmed = amountIndication?.trim();
  if (!trimmed) {
    return;
  }
  const parsed = parseTariefFromText(`salaris € ${trimmed}`);
  if (!parsed || parsed.eenheid !== "maand") {
    return parsed;
  }
  const monthlySafe =
    salaryType === null ||
    salaryType === undefined ||
    salaryType === MONTHLY_SALARY_TYPE;
  return monthlySafe ? parsed : { ...parsed, eenheid: UNKNOWN };
};

const DATE_PREFIX_PATTERN = /^(?<prefix>\d{4}-\d{2}-\d{2})/u;

const datePrefix = (value: string | null | undefined): string | undefined =>
  DATE_PREFIX_PATTERN.exec(value?.trim() ?? "")?.groups?.prefix;

/** "Wisselende werklocatie"/"wisselend door heel Nederland" is the source's
 * own location description when no city exists — kept rather than UNKNOWN. */
const locatieTekstOf = (
  detail: WerkNlVacatureDetail,
  listing: WerkNlSearchItem | null
): string | typeof UNKNOWN =>
  firstText(
    detail.proposition?.workLocation?.city,
    listing?.workLocationCity,
    listing?.workLocationForeignCity,
    detail.proposition?.workLocation?.postcode,
    listing?.workLocationType
  );

/** `workLocation.countryCode` is only populated for foreign listings; a
 * Dutch postcode in the same object is explicit NL data (same reasoning as
 * tenderned's NUTS prefix). Absent both -> UNKNOWN, never a default. */
const locatieLandOf = (
  detail: WerkNlVacatureDetail,
  listing: WerkNlSearchItem | null
): string | typeof UNKNOWN => {
  const explicit = firstText(
    detail.proposition?.workLocation?.countryCode,
    listing?.workLocationForeignCountry
  );
  if (explicit !== UNKNOWN) {
    return explicit;
  }
  return detail.proposition?.workLocation?.postcode?.trim() ? "NL" : UNKNOWN;
};

const sollicitatieUrlsOf = (detail: WerkNlVacatureDetail): string[] => {
  const urls: string[] = [];
  for (const method of detail.applicationMethods ?? []) {
    const url = method.urlApplicationForm?.trim();
    if (url) {
      urls.push(url);
    }
  }
  return urls;
};

const employerAdresOf = (detail: WerkNlVacatureDetail) => {
  const address = detail.employer?.addressNetherlands;
  if (!address) {
    return null;
  }
  return {
    city: keep(address.city),
    houseNumber: keep(address.houseNumber),
    postcode: keep(address.postcode),
    streetName: keep(address.streetName),
  };
};

const detailSpecifiekOf = (detail: WerkNlVacatureDetail) => ({
  beroep_code: keep(detail.proposition?.function?.code),
  beroep_naam: keep(detail.proposition?.function?.name),
  beroep_omschrijving_eigen: keep(
    detail.proposition?.function?.customDescription
  ),
  contract_type_code: keep(detail.proposition?.contract?.type),
  employer_adres: employerAdresOf(detail),
  is_acquisition_not_appreciated: detail.isAcquisitionNotAppreciated ?? false,
  is_eures_priority: detail.isEuresPriority ?? false,
  publicatiedatum: keep(detail.createdDate),
  sollicitatie_urls: sollicitatieUrlsOf(detail),
  source: keep(detail.source),
});

/** Arbeidsvoorwaarden- en cv-eisenvelden uit `proposition`/`cvOffer`. */
const voorwaardenSpecifiekOf = (detail: WerkNlVacatureDetail) => ({
  drivers_licenses: detail.cvOffer?.driversLicenses ?? [],
  education_level_code: keep(detail.cvOffer?.educationLevel),
  eind_datum: datePrefix(detail.proposition?.contract?.endDate) ?? null,
  salary_type_code: keep(detail.proposition?.salary?.type),
  werklocatie_type_code: keep(detail.proposition?.workLocation?.type),
  werktijden_code: keep(detail.proposition?.workhours?.werktijden),
});

const urenSpecifiekOf = (
  detail: WerkNlVacatureDetail,
  listing: WerkNlSearchItem | null
) => {
  const min =
    detail.proposition?.workhours?.minimumHours ?? listing?.minHours ?? null;
  const max =
    detail.proposition?.workhours?.maximumHours ?? listing?.maxHours ?? null;
  return {
    uren_max: max,
    uren_min: min,
    uren_per_week: formatHoursPerWeek(min, max),
  };
};

const listingSpecifiekOf = (
  detail: WerkNlVacatureDetail,
  listing: WerkNlSearchItem | null
) => ({
  contract_type: keep(listing?.contractType),
  key: keep(listing?.key),
  leerbaan: listing?.leerbaan ?? false,
  modified: listing?.modified ?? detail.modifiedDate ?? null,
  opleidingsniveau: keep(listing?.studyLevel),
  stageplaats: listing?.stageplaats ?? false,
  werklocatie_type: keep(listing?.workLocationType),
  // `workLocationType` is the source's own work-arrangement label ("Vaste
  // werklocatie"/"Wisselende werklocatie") — canonical `werkvorm` takes it
  // verbatim. The numeric `proposition.workLocation.type` stays raw in
  // `werklocatie_type_code`; no verified codelijst maps it to a label.
  werkvorm: keep(listing?.workLocationType),
});

const bronSpecifiekOf = (
  detail: WerkNlVacatureDetail,
  listing: WerkNlSearchItem | null
) => ({
  ...detailSpecifiekOf(detail),
  ...voorwaardenSpecifiekOf(detail),
  ...urenSpecifiekOf(detail, listing),
  ...listingSpecifiekOf(detail, listing),
});

const tariefOf = (
  proposition: WerkNlVacatureDetail["proposition"]
): NormalisedAanvraagDraft["tarief"] =>
  parseWerkNlSalary(
    proposition?.salary?.amountIndication,
    proposition?.salary?.type
  ) ?? { eenheid: UNKNOWN, max: UNKNOWN, min: UNKNOWN, valuta: "EUR" };

/** Description text for the draft body: the HTML detail description wins,
 * then the function description, then the bare title (which stripHtml
 * passes through unchanged). */
const beschrijvingOf = (
  detail: WerkNlVacatureDetail,
  proposition: WerkNlVacatureDetail["proposition"]
): string => {
  const tekst = firstText(
    detail.description,
    proposition?.function?.description,
    detail.title
  );
  return stripHtml(tekst === UNKNOWN ? detail.title || "" : tekst);
};

const contactpersonenOf = (
  detail: WerkNlVacatureDetail,
  parserVersion: string
) => {
  const contact = detail.contactPerson;
  const contacts = contact
    ? [
        {
          email: contact.email,
          naam: contact.name,
          rol: contact.department,
          telefoon: contact.phoneNumber,
        },
      ]
    : null;
  return toDraftContactpersonen(
    "werk-nl",
    contacts,
    parserVersion,
    "detail.contactPerson"
  );
};

export const parseWerkNlPayload = (
  payload: WerkNlFetchedPayload,
  contentHash: string,
  _context?: NormaliseContext
): NormalisedAanvraagDraft => {
  const { detail, listing } = payload;
  const parserVersion = WERK_NL_PARSER_VERSION;
  const referenceNumber = referenceString(
    detail.referenceNumber ?? listing?.referenceNumber
  );
  const { proposition } = detail;
  const sluitingsdatumPassed = hasClosingMomentPassed(detail.expirationDate);
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: sluitingsdatumPassed,
    current: "unknown",
    missedPolls: 0,
    seenOpen: !sluitingsdatumPassed,
    sluitingsdatumPassed,
  });
  const draft: NormalisedAanvraagDraft = {
    beschrijving: field(
      beschrijvingOf(detail, proposition),
      parserVersion,
      "detail.description"
    ),
    bronReferentie: field(
      referenceNumber,
      parserVersion,
      "detail.referenceNumber"
    ),
    bronSpecifiek: field(
      bronSpecifiekOf(detail, listing),
      parserVersion,
      "detail"
    ),
    bronUrl: field(
      `https://www.werk.nl/nl/vacatures/${referenceNumber}`,
      parserVersion,
      "detail.referenceNumber"
    ),
    contentHash,
    extractieMethode: "api",
    lifecycle,
    locatieLand: field(
      locatieLandOf(detail, listing),
      parserVersion,
      "detail.proposition"
    ),
    locatieTekst: field(
      locatieTekstOf(detail, listing),
      parserVersion,
      "detail.proposition.workLocation"
    ),
    opdrachtgeverNaam: field(
      firstText(detail.employer?.organizationName, listing?.organisation),
      parserVersion,
      "detail.employer.organizationName"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(detail.expirationDate),
    startDatum: field(
      datePrefix(proposition?.contract?.startDate) ?? UNKNOWN,
      parserVersion,
      "detail.proposition.contract.startDate"
    ),
    status: lifecycle,
    tarief: tariefOf(proposition),
    titel: field(
      detail.title || listing?.vacatureTitle || referenceNumber,
      parserVersion,
      "detail.title"
    ),
  };
  const contactpersonen = contactpersonenOf(detail, parserVersion);
  if (contactpersonen) {
    draft.contactpersonen = contactpersonen;
  }
  return draft;
};

export const decodeWerkNlPayload = (body: Uint8Array): WerkNlFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from werk.nl fetch.
  JSON.parse(new TextDecoder().decode(body)) as WerkNlFetchedPayload;

export const normaliseWerkNlObservation = (
  body: Uint8Array,
  contentHash: string,
  context?: NormaliseContext
): NormalisedAanvraagDraft =>
  parseWerkNlPayload(decodeWerkNlPayload(body), contentHash, context);
