import type { AanvraagRecord } from "../registry/stores/types";
import type { SpottCreateVacancyRequest } from "./spott/types";

const SPOTT_FIXTURE_COMPANY_ID = "company-fixture-001";
const SPOTT_FIXTURE_STAGE_ID = "stage-fixture-001";

/** CTP-610: the owner's decision is that contact data travels with the
 * customer export. `SpottCreateVacancyRequest` has no dedicated contact field
 * (`clientContactIds` holds Spott-internal contact ids, not source-published
 * contactpersonen), so the contacts ride along as a labelled block in the
 * vacancy description. */
const contactpersonenBlock = (aanvraag: AanvraagRecord): string => {
  const lines = (aanvraag.contactpersonen ?? []).map((contact) => {
    const parts = [
      contact.naam,
      contact.rol ? `(${contact.rol})` : null,
      contact.email,
      contact.telefoon,
    ].filter((part): part is string => Boolean(part));
    return `- ${parts.join(" — ")}`;
  });
  return lines.length > 0
    ? `\n\nContactpersonen bij bron:\n${lines.join("\n")}`
    : "";
};

export const mapAanvraagToSpottCreateRequest = (
  aanvraag: AanvraagRecord
): SpottCreateVacancyRequest => ({
  clientContactIds: [],
  companyId: SPOTT_FIXTURE_COMPANY_ID,
  description: `${aanvraag.beschrijving}${contactpersonenBlock(aanvraag)}`,
  employmentType: "contract",
  endAt: null,
  location: null,
  locationType: "remote",
  name: aanvraag.titel,
  salaryRange: null,
  stageId: SPOTT_FIXTURE_STAGE_ID,
  startAt: null,
  targetCompanyId: null,
  teamUserIds: [],
});
