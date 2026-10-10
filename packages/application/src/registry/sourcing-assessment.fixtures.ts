import type {
  SourcingAssessmentInput,
  TrustedSourcingAttestation,
} from "./sourcing-assessment";
import { digestSourcingSelection } from "./sourcing-assessment";

export const SOURCING_VACANCY_ID = "00000000-0000-4000-8000-000000000101";
export const SOURCING_QUERY_DIGEST = `sha256:${"1".repeat(64)}`;
const selection = {
  queryDigest: SOURCING_QUERY_DIGEST,
  selectedIds: [SOURCING_VACANCY_ID],
};
const withSelectionDigest = (
  input: Omit<SourcingAssessmentInput, "selectionDigest">
): SourcingAssessmentInput => ({
  ...input,
  selectionDigest: digestSourcingSelection(input),
});
export const emptySourcingFixture = withSelectionDigest({
  claims: [],
  queryDigest: SOURCING_QUERY_DIGEST,
  selectedIds: [],
});
export const partialSourcingFixture = withSelectionDigest({
  claims: [
    {
      field: "deadline",
      sourceReferenceIds: ["detail-1"],
      status: "known",
      vacancyId: SOURCING_VACANCY_ID,
      value: "2026-09-12",
    },
    {
      field: "rate",
      sourceReferenceIds: [],
      status: "unknown",
      vacancyId: SOURCING_VACANCY_ID,
      value: "unknown",
    },
  ],
  ...selection,
});
export const contradictorySourcingFixture = withSelectionDigest({
  claims: [
    {
      field: "deadline",
      sourceReferenceIds: ["detail-1"],
      status: "known",
      vacancyId: SOURCING_VACANCY_ID,
      value: "2026-09-12",
    },
    {
      field: "deadline",
      sourceReferenceIds: ["raw-1"],
      status: "known",
      vacancyId: SOURCING_VACANCY_ID,
      value: "2026-09-15",
    },
    {
      field: "rate",
      sourceReferenceIds: [],
      status: "uncertain",
      vacancyId: SOURCING_VACANCY_ID,
      value: "EUR 90-110 per hour",
    },
    {
      field: "location",
      sourceReferenceIds: [],
      status: "unknown",
      vacancyId: SOURCING_VACANCY_ID,
      value: "unknown",
    },
    {
      field: "contract_type",
      sourceReferenceIds: [],
      status: "unknown",
      vacancyId: SOURCING_VACANCY_ID,
      value: "unknown",
    },
  ],
  ...selection,
});
export const completeSourcingFixture = withSelectionDigest({
  claims: [
    {
      field: "deadline",
      sourceReferenceIds: ["detail-1"],
      status: "known",
      vacancyId: SOURCING_VACANCY_ID,
      value: "2026-09-12",
    },
    {
      field: "rate",
      sourceReferenceIds: [],
      status: "unknown",
      vacancyId: SOURCING_VACANCY_ID,
      value: "unknown",
    },
    {
      field: "location",
      sourceReferenceIds: ["detail-1"],
      status: "known",
      vacancyId: SOURCING_VACANCY_ID,
      value: "Amsterdam",
    },
    {
      field: "contract_type",
      sourceReferenceIds: [],
      status: "uncertain",
      vacancyId: SOURCING_VACANCY_ID,
      value: "temporary",
    },
  ],
  ...selection,
});
export const completeSearchReference: TrustedSourcingAttestation["sourceReferences"][number] =
  {
    capabilityId: "search_aanvragen",
    id: "search-1",
    maxAgeSeconds: 3600,
    observedAt: "2026-09-05T09:25:00.000Z",
    reference: "query-snapshot:fixture",
  };
export const completeTrustedAttestation: TrustedSourcingAttestation = {
  ...selection,
  claims: completeSourcingFixture.claims,
  searchStatus: "complete",
  sourceReferences: [
    completeSearchReference,
    {
      capabilityId: "get_aanvraag",
      id: "detail-1",
      maxAgeSeconds: 3600,
      observedAt: "2026-09-05T09:30:00.000Z",
      reference: `aanvraag:${SOURCING_VACANCY_ID}`,
    },
  ],
  usedCapabilities: ["search_aanvragen", "get_aanvraag"],
};
export const emptyTrustedAttestation: TrustedSourcingAttestation = {
  claims: [],
  queryDigest: SOURCING_QUERY_DIGEST,
  searchStatus: "complete",
  selectedIds: [],
  sourceReferences: [completeSearchReference],
  usedCapabilities: ["search_aanvragen"],
};
export const contradictoryTrustedAttestation: TrustedSourcingAttestation = {
  ...completeTrustedAttestation,
  claims: contradictorySourcingFixture.claims,
  sourceReferences: [
    ...completeTrustedAttestation.sourceReferences,
    {
      capabilityId: "read_raw",
      id: "raw-1",
      maxAgeSeconds: 3600,
      observedAt: "2026-09-05T09:45:00.000Z",
      reference: "raw/fixture.json",
    },
  ],
  usedCapabilities: [
    ...completeTrustedAttestation.usedCapabilities,
    "read_raw",
  ],
};
