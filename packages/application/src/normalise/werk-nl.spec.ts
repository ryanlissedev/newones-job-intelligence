import { describe, expect, it } from "bun:test";

import type { WerkNlFetchedPayload } from "@ji/connectors/werk-nl";
import { UNKNOWN } from "@ji/domain";

import {
  decodeWerkNlPayload,
  normaliseWerkNlObservation,
  parseWerkNlPayload,
} from "./werk-nl";

/** Built from the real capture in
 * fixtures/connectors/werk-nl/detail-56790376.json (referenceNumber
 * 56790376, "Verzorgende Thuiszorg" / Ovus Thuiszorg B.V., captured
 * 2026-09-18). */
const buildPayload = (
  detailOverrides: Partial<WerkNlFetchedPayload["detail"]> = {}
): WerkNlFetchedPayload => ({
  detail: {
    applicationMethods: [{ sollicitatieWijze: 3, urlApplicationForm: "" }],
    contactPerson: {
      department: null,
      email: "recruiter@example.invalid",
      name: "R. Cruiter",
      phoneNumber: "+31000000000",
    },
    createdDate: "2024-04-25T00:00:00",
    cvOffer: {
      driversLicenses: [3],
      educationLevel: null,
      otherRequirements: "Inlevingsvermogen.",
    },
    description: "Ben jij een gepassioneerde zorgprofessional?",
    employer: {
      addressNetherlands: {
        city: "ALMERE",
        houseNumber: "15",
        postcode: "1328LK",
        streetName: "Giacomettistraat",
      },
      organizationName: "Ovus Thuiszorg B.V.",
    },
    expirationDate: "2999-10-02T00:00:00",
    isAcquisitionNotAppreciated: false,
    isEuresPriority: true,
    modifiedDate: "2026-09-18T00:00:00",
    proposition: {
      contract: { endDate: null, startDate: "2024-04-25T00:00:00", type: 2 },
      function: {
        code: "14304",
        customDescription: "Verzorgende IG",
        description: "Werken bij Ovus Thuiszorg.",
        name: "Verzorgende thuiszorg",
      },
      salary: { amountIndication: "2500-3000", type: 4 },
      termsOfEmploymentDescription: "FWG 35-40 CAO VVT.",
      workLocation: {
        city: null,
        countryCode: null,
        employerLocationDistance: 0,
        postcode: null,
        type: 3,
      },
      workhours: { maximumHours: 40, minimumHours: 16, werktijden: 2 },
    },
    referenceNumber: 56_790_376,
    source: "WNL",
    title: "Verzorgende Thuiszorg",
    ...detailOverrides,
  },
  listing: {
    contractType: "Mogelijk vast",
    key: "2001:L:56790376",
    leerbaan: false,
    maxHours: 40,
    minHours: 16,
    modified: "2026-09-18 00:00:00",
    organisation: "Ovus Thuiszorg B.V.",
    profession: "Verzorgende thuiszorg",
    referenceNumber: 56_790_376,
    stageplaats: false,
    studyLevel: "HBO/bachelor",
    vacatureTitle: "Verzorgende Thuiszorg",
    workLocationCity: null,
    workLocationForeignCity: null,
    workLocationForeignCountry: null,
    workLocationType: "Wisselende werklocatie",
  },
  referenceNumber: "56790376",
});

describe("parseWerkNlPayload", () => {
  it("maps the real Verzorgende Thuiszorg detail into the normalised draft", () => {
    const draft = parseWerkNlPayload(buildPayload(), "hash-1");

    expect(draft.titel.value).toBe("Verzorgende Thuiszorg");
    expect(draft.opdrachtgeverNaam.value).toBe("Ovus Thuiszorg B.V.");
    expect(draft.bronReferentie.value).toBe("56790376");
    expect(draft.bronUrl.value).toBe(
      "https://www.werk.nl/nl/vacatures/56790376"
    );
    expect(draft.beschrijving.value).toBe(
      "Ben jij een gepassioneerde zorgprofessional?"
    );
    expect(draft.startDatum.value).toBe("2024-04-25");
    expect(draft.extractieMethode).toBe("api");
    expect(draft.status).toBe("active");
  });

  it("reads the source's own location description when no city exists", () => {
    const draft = parseWerkNlPayload(buildPayload(), "hash-1");
    expect(draft.locatieTekst.value).toBe("Wisselende werklocatie");
    expect(draft.locatieLand.value).toBe(UNKNOWN);
  });

  it("prefers an explicit workLocation city and postcode-derived land", () => {
    const payload = buildPayload();
    if (payload.detail.proposition?.workLocation) {
      payload.detail.proposition.workLocation.city = "SITTARD";
      payload.detail.proposition.workLocation.postcode = "6131AA";
    }
    const draft = parseWerkNlPayload(payload, "hash-1");
    expect(draft.locatieTekst.value).toBe("SITTARD");
    expect(draft.locatieLand.value).toBe("NL");
  });

  it("honours a foreign workLocation country code", () => {
    const payload = buildPayload();
    if (payload.detail.proposition?.workLocation) {
      payload.detail.proposition.workLocation.countryCode = "DE";
    }
    if (payload.listing) {
      payload.listing.workLocationForeignCity = "Aken";
    }
    const draft = parseWerkNlPayload(payload, "hash-1");
    expect(draft.locatieLand.value).toBe("DE");
    expect(draft.locatieTekst.value).toBe("Aken");
  });

  it("parses the salary amountIndication as a monthly jobboard range", () => {
    const draft = parseWerkNlPayload(buildPayload(), "hash-1");
    expect(draft.tarief.min).toBe("2500");
    expect(draft.tarief.max).toBe("3000");
    expect(draft.tarief.eenheid).toBe("maand");
    expect(draft.tarief.valuta).toBe("EUR");
    expect(draft.bronSpecifiek.value).toMatchObject({
      salary_type_code: 4,
    });
  });

  it("demotes eenheid to UNKNOWN for an ambiguous beloningsvorm code", () => {
    // salary.type 1 = "vast loon / uurloon" (live codelijst): a bare range
    // can be hourly, so the manufactured "maand" must not publish.
    const payload = buildPayload();
    if (payload.detail.proposition?.salary) {
      payload.detail.proposition.salary = {
        amountIndication: "15-18",
        type: 1,
      };
    }
    const draft = parseWerkNlPayload(payload, "hash-1");
    expect(draft.tarief.min).toBe("15");
    expect(draft.tarief.max).toBe("18");
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
    expect(draft.bronSpecifiek.value).toMatchObject({ salary_type_code: 1 });
  });

  it("publishes no tarief when amountIndication is absent", () => {
    const payload = buildPayload();
    if (payload.detail.proposition?.salary) {
      payload.detail.proposition.salary.amountIndication = null;
    }
    const draft = parseWerkNlPayload(payload, "hash-1");
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.max).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
  });

  it("maps contactPerson to draft contactpersonen", () => {
    const draft = parseWerkNlPayload(buildPayload(), "hash-1");
    expect(draft.contactpersonen?.value).toEqual([
      {
        email: "recruiter@example.invalid",
        geinformeerdOp: null,
        naam: "R. Cruiter",
        notificatieKanaal: null,
        rol: null,
        telefoon: "+31000000000",
      },
    ]);
    expect(draft.contactpersonen?.provenance.sourcePath).toBe(
      "detail.contactPerson"
    );
  });

  it("omits contactpersonen when the source publishes none", () => {
    const payload = buildPayload({ contactPerson: null });
    const draft = parseWerkNlPayload(payload, "hash-1");
    expect(draft.contactpersonen).toBeUndefined();
  });

  it("emits canonical uren/publicatiedatum/eind_datum keys the curated columns read (CTP-611)", () => {
    const draft = parseWerkNlPayload(buildPayload(), "hash-1");
    expect(draft.bronSpecifiek.value).toMatchObject({
      eind_datum: null,
      publicatiedatum: "2024-04-25T00:00:00",
      uren_max: 40,
      uren_min: 16,
      uren_per_week: "16–40",
    });
  });

  it("maps the source's own workLocationType label to canonical werkvorm (CTP-611)", () => {
    const draft = parseWerkNlPayload(buildPayload(), "hash-1");
    expect(draft.bronSpecifiek.value).toMatchObject({
      werklocatie_type: "Wisselende werklocatie",
      werkvorm: "Wisselende werklocatie",
    });
  });

  it("keeps werkvorm absent when the listing label is absent", () => {
    const draft = parseWerkNlPayload(
      { ...buildPayload(), listing: null },
      "hash-1"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      werklocatie_type: null,
      werkvorm: null,
    });
  });

  it("keeps a published contract endDate as eind_datum", () => {
    const payload = buildPayload();
    if (payload.detail.proposition?.contract) {
      payload.detail.proposition.contract.endDate = "2027-04-24T00:00:00";
    }
    const draft = parseWerkNlPayload(payload, "hash-1");
    expect(draft.bronSpecifiek.value).toMatchObject({
      eind_datum: "2027-04-24",
    });
  });

  it("resolves sluitingsdatum from expirationDate in Amsterdam wall clock", () => {
    const draft = parseWerkNlPayload(buildPayload(), "hash-1");
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2999-10-01T22:00:00.000Z"
    );
  });

  it("marks the aanvraag closed when expirationDate has passed", () => {
    const draft = parseWerkNlPayload(
      buildPayload({ expirationDate: "2020-01-01T00:00:00" }),
      "hash-1"
    );
    expect(draft.status).toBe("closed");
  });

  it("round-trips through the encoded observation body", () => {
    const payload = buildPayload();
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const draft = normaliseWerkNlObservation(body, "hash-1");
    expect(decodeWerkNlPayload(body).referenceNumber).toBe("56790376");
    expect(draft.titel.value).toBe("Verzorgende Thuiszorg");
  });
});
