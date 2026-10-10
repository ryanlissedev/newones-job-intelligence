import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";

import { loadConnectorFixture } from "@ji/connectors";
import type {
  MercellDetail,
  MercellFetchedPayload,
  MercellListingItem,
} from "@ji/connectors/mercell";
import { UNKNOWN } from "@ji/domain";

import { decodeMercellPayload, parseMercellPayload } from "./mercell";

/** Built from the real captures in fixtures/connectors/mercell/ (detail
 * 228236 "Aanschaf zero emissie motorfietsen", Gemeente Amsterdam). */
const buildPayload = (
  detailOverrides: Partial<MercellDetail> = {},
  listingOverrides: Partial<MercellListingItem> = {}
): MercellFetchedPayload => ({
  detail: {
    DisplayNumber: "T228236",
    OrganizationName: "Gemeente Amsterdam",
    ProcedureType: 13,
    PublicationDate: "2026-09-18T14:44:46.553Z",
    PublishedTenderParticipationStatus: 1,
    TenderId: 228_236,
    TenderName:
      "Vrijwillige transparantie door voorafgaande aankondiging: Aanschaf zero emissie motorfietsen voor THOR",
    publicationAuthorities: ["MeFormsAuthority"],
    ...detailOverrides,
  },
  listing: {
    Deadline: "2026-10-09T22:00:00Z",
    OrganizationName: "Gemeente Amsterdam",
    Status: 1,
    TenderId: 228_236,
    TenderName:
      "Vrijwillige transparantie door voorafgaande aankondiging: Aanschaf zero emissie motorfietsen voor THOR",
    ...listingOverrides,
  },
  tenderId: "228236",
});

/** A moment inside the fixture's capture window (published 2026-09-18,
 * deadline 2026-10-09). */
const MERCELL_FIXTURE_NOW = new Date("2026-09-20T12:00:00.000Z");

describe("parseMercellPayload", () => {
  // Pin the clock to the capture window so the fixture's 2026-10-09 deadline
  // stays in the future; the passed-deadline case below uses a 2020 date.
  beforeEach(() => {
    setSystemTime(MERCELL_FIXTURE_NOW);
  });
  afterEach(() => {
    setSystemTime();
  });

  it("maps the real detail fixture into the normalised draft", async () => {
    const fixture = await loadConnectorFixture<MercellDetail>(
      "mercell/detail-228236.json"
    );
    const draft = parseMercellPayload(
      buildPayload(fixture.payload, { Deadline: "2026-10-09T22:00:00Z" }),
      "hash-1"
    );

    expect(draft.titel.value).toContain("zero emissie motorfietsen");
    expect(draft.opdrachtgeverNaam.value).toBe("Gemeente Amsterdam");
    expect(draft.bronReferentie.value).toBe("228236");
    expect(draft.bronUrl.value).toBe("https://s2c.mercell.com/tender/228236");
    expect(draft.extractieMethode).toBe("api");
    expect(draft.status).toBe("active");
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2026-10-09T22:00:00.000Z"
    );
  });

  it("keeps absent-at-source fields honestly UNKNOWN", () => {
    const draft = parseMercellPayload(buildPayload(), "hash-2");

    expect(draft.locatieLand.value).toBe(UNKNOWN);
    expect(draft.locatieTekst.value).toBe(UNKNOWN);
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.max).toBe(UNKNOWN);
  });

  it("lands procedure and contract codes in bronSpecifiek", () => {
    const draft = parseMercellPayload(
      buildPayload({ ProcedureType: 16, TypeOfContract: 1 }),
      "hash-3"
    );
    // SAFETY: the normaliser builds bronSpecifiek as the literal shape below;
    // naming the asserted keys keeps the check concrete.
    const specifiek = draft.bronSpecifiek.value as {
      display_number: string;
      procedure_type: number;
      procedure_type_name: string;
      type_of_contract_name: string;
    };

    expect(specifiek.procedure_type).toBe(16);
    expect(specifiek.procedure_type_name).toBe("MiniCompetitionWithinFA");
    expect(specifiek.type_of_contract_name).toBe("Services");
    expect(specifiek.display_number).toBe("T228236");
  });

  it("reads a Closed participation status as closed", () => {
    const draft = parseMercellPayload(
      buildPayload({ PublishedTenderParticipationStatus: 2 }),
      "hash-4"
    );
    expect(draft.status).toBe("closed");
  });

  it("reads ExplicitTenderStatus Canceled as closed even while open", () => {
    const draft = parseMercellPayload(
      buildPayload({
        ExplicitTenderStatus: 3,
        PublishedTenderParticipationStatus: 1,
      }),
      "hash-5"
    );
    expect(draft.status).toBe("closed");
  });

  it("reads a passed listing Deadline as closed", () => {
    const draft = parseMercellPayload(
      buildPayload({}, { Deadline: "2020-01-01T00:00:00Z" }),
      "hash-6"
    );
    expect(draft.status).toBe("closed");
  });

  it("decodes a serialised observation body", () => {
    const body = new TextEncoder().encode(JSON.stringify(buildPayload()));
    const decoded = decodeMercellPayload(body);
    expect(decoded.tenderId).toBe("228236");
  });
});
