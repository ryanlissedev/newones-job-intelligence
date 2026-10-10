import type {
  MercellDetail,
  MercellFetchedPayload,
  MercellListingItem,
} from "@ji/connectors/mercell";
import {
  MERCELL_EXPLICIT_CLOSED_STATUSES,
  MERCELL_PARSER_VERSION,
  MERCELL_PARTICIPATION_STATUS,
  mercellCurrencyName,
  mercellProcedureTypeName,
  mercellTenderUrl,
  mercellTypeOfContractName,
} from "@ji/connectors/mercell";
import type { AanvraagLifecycle } from "@ji/domain";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { toDraftContactpersonen } from "./contactpersonen";
import {
  closingMomentInstant,
  field,
  hasClosingMomentPassed,
  stripHtml,
} from "./types";
import type {
  JsonValue,
  NormaliseContext,
  NormalisedAanvraagDraft,
} from "./types";

/** Participation status is published twice: `PublishedTenderParticipationStatus`
 * on the detail (enum verified in the portal bundle: 1 Open / 2 Closed) and
 * `Status` on the listing row. Prefer the detail; fall back to the listing. */
const participationStatus = (
  detail: MercellDetail,
  listing: MercellListingItem
): number | null =>
  detail.PublishedTenderParticipationStatus ?? listing.Status ?? null;

const resolveMercellLifecycle = (
  participation: number | null,
  explicitTenderStatus: number | null | undefined,
  deadline: string | null
): AanvraagLifecycle => {
  // ExplicitTenderStatus 3 Canceled / 7 Removed are verified enum values from
  // the portal bundle — both mean the tender can no longer be bid on.
  const bronSaysClosed =
    participation === MERCELL_PARTICIPATION_STATUS.closed ||
    (explicitTenderStatus !== null &&
      explicitTenderStatus !== undefined &&
      MERCELL_EXPLICIT_CLOSED_STATUSES.has(explicitTenderStatus));
  return resolveLifecycleStatus({
    bronSaysClosed,
    current: "unknown",
    missedPolls: 0,
    seenOpen: participation === MERCELL_PARTICIPATION_STATUS.open,
    sluitingsdatumPassed: hasClosingMomentPassed(deadline),
  });
};

const bronSpecifiekIdentity = (
  detail: MercellDetail,
  listing: MercellListingItem,
  participation: number | null
) => ({
  display_number: detail.DisplayNumber ?? null,
  organization_id: detail.OrganizationId ?? listing.OrganizationId ?? null,
  participation_status: participation,
  publication_authorities: detail.publicationAuthorities,
  publication_date: detail.PublicationDate ?? listing.PublicationDate ?? null,
  special_number: detail.SpecialNumber ?? listing.SpecialNumber ?? null,
  status: listing.Status ?? null,
  tender_guid: detail.TenderGuid ?? listing.Guid ?? null,
});

const bronSpecifiekClassification = (
  detail: MercellDetail,
  listing: MercellListingItem
) => {
  const procedureType = detail.ProcedureType ?? listing.ProcedureType ?? null;
  return {
    estimated_value: detail.EstimatedValue ?? null,
    estimated_value_max: detail.EstimatedValueMax ?? null,
    estimated_value_min: detail.EstimatedValueMin ?? null,
    estimated_value_type: detail.EstimatedValueType ?? null,
    framework: detail.IsFrameworkAgreement ?? null,
    has_continuous_evaluation: detail.HasContinuousEvaluation ?? null,
    procedure_type: procedureType,
    procedure_type_name: mercellProcedureTypeName(procedureType),
    type_of_contract: detail.TypeOfContract ?? null,
    type_of_contract_name: mercellTypeOfContractName(
      detail.TypeOfContract ?? null
    ),
    valuta: mercellCurrencyName(detail.CurrencyType ?? null),
  };
};

const bronSpecifiekValue = (
  detail: MercellDetail,
  listing: MercellListingItem,
  participation: number | null
): JsonValue => ({
  ...bronSpecifiekIdentity(detail, listing, participation),
  ...bronSpecifiekClassification(detail, listing),
});

const beschrijvingValue = (
  detail: MercellDetail,
  listing: MercellListingItem
): string =>
  stripHtml(detail.TenderDescription ?? listing.TenderDescription ?? "") ||
  detail.TenderName;

export const parseMercellPayload = (
  payload: MercellFetchedPayload,
  contentHash: string,
  _context?: NormaliseContext
): NormalisedAanvraagDraft => {
  const { detail, listing } = payload;
  const parserVersion = MERCELL_PARSER_VERSION;

  const participation = participationStatus(detail, listing);
  // `Deadline` is a listing-only field (absent from the detail response) and
  // carries an explicit `Z`, so it is honoured as a true UTC instant.
  const deadline = listing.Deadline ?? null;
  const lifecycle = resolveMercellLifecycle(
    participation,
    detail.ExplicitTenderStatus,
    deadline
  );

  const contactpersonen = toDraftContactpersonen(
    "mercell",
    [
      {
        email: detail.ContactPersonEmail,
        naam: detail.ContactPersonDisplayName,
        telefoon: detail.ContactPersonPhone,
      },
    ],
    parserVersion,
    "detail.ContactPerson*"
  );

  const draft: NormalisedAanvraagDraft = {
    beschrijving: field(
      beschrijvingValue(detail, listing),
      parserVersion,
      "detail.TenderDescription"
    ),
    bronReferentie: field(payload.tenderId, parserVersion, "tenderId"),
    bronSpecifiek: field(
      bronSpecifiekValue(detail, listing, participation),
      parserVersion,
      "detail"
    ),
    bronUrl: field(
      mercellTenderUrl(payload.tenderId),
      parserVersion,
      "tenderId"
    ),
    contentHash,
    extractieMethode: "api",
    lifecycle,
    // The s2c listing/detail payloads carry no structured location field at
    // all — no country, NUTS or city (OrganizationName is a free-text buyer
    // name and the NL instance also hosts non-NL buyers, e.g. Jülicher Ent-
    // sorgung). Country/place are honestly UNKNOWN, never inferred from the
    // organisation's name or the portal's own country.
    locatieLand: field(UNKNOWN, parserVersion, "n/a (not published by source)"),
    locatieTekst: field(
      UNKNOWN,
      parserVersion,
      "n/a (not published by source)"
    ),
    opdrachtgeverNaam: field(
      (detail.OrganizationName ?? listing.OrganizationName)?.trim() || UNKNOWN,
      parserVersion,
      "detail.OrganizationName"
    ),
    parserVersion,
    sluitingsdatum: closingMomentInstant(deadline),
    // Mercell publishes no contract-start field on either endpoint.
    startDatum: field(UNKNOWN, parserVersion, "n/a (not published by source)"),
    status: lifecycle,
    tarief: {
      eenheid: UNKNOWN,
      // EstimatedValue*/CurrencyType is a total contract value, not an hourly
      // or monthly tarief — kept verbatim in bronSpecifiek, never mapped onto
      // tarief (absent stays absent).
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: mercellCurrencyName(detail.CurrencyType ?? null) ?? "EUR",
    },
    titel: field(detail.TenderName, parserVersion, "detail.TenderName"),
  };
  if (contactpersonen) {
    draft.contactpersonen = contactpersonen;
  }
  return draft;
};

export const decodeMercellPayload = (body: Uint8Array): MercellFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Mercell fetch.
  JSON.parse(new TextDecoder().decode(body)) as MercellFetchedPayload;

export const normaliseMercellObservation = (
  body: Uint8Array,
  contentHash: string,
  context?: NormaliseContext
): NormalisedAanvraagDraft =>
  parseMercellPayload(decodeMercellPayload(body), contentHash, context);
