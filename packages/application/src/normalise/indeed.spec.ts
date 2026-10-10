import { describe, expect, it } from "bun:test";

import {
  createIndeedClient,
  createIndeedConnector,
} from "@ji/connectors/indeed";
import type { IndeedFetchedPayload } from "@ji/connectors/indeed";
import { UNKNOWN } from "@ji/domain";

import { normaliseIndeedObservation, parseIndeedPayload } from "./indeed";

const BRON_ID = "00000000-0000-4000-8000-000000000044";

/** Built from the real capture in
 * fixtures/connectors/indeed/listing-page-0.json — jobkey 12c9e91e86a09037,
 * "Business Developer / Adviseur Energie" / CloudCrest B.V., captured
 * 2026-09-18 via headed Chrome (the only anonymously-published viewjob body
 * on the page). */
const buildPayload = (
  detailOverrides: Partial<IndeedFetchedPayload["detail"]> = {},
  cardOverrides: Partial<NonNullable<IndeedFetchedPayload["card"]>> = {}
): IndeedFetchedPayload => ({
  card: {
    company: "CloudCrest B.V.",
    companyRating: 0,
    companyReviewCount: 0,
    country: "NL",
    createDate: 1_782_204_876_228,
    displayTitle: "Business Developer / Adviseur Energie",
    expired: false,
    extractedSalary: { max: 7500, min: 5500, type: "MONTHLY" },
    formattedLocation: "Utrecht",
    formattedRelativeTime: "30+ dagen geleden",
    hiresNeededExact: "2",
    indeedApplyable: true,
    jobLocationCity: "Utrecht",
    jobLocationState: "UT",
    jobTypes: [],
    jobkey: "12c9e91e86a09037",
    newJob: false,
    normTitle: "Business Developer",
    pubDate: 1_782_190_800_000,
    redirectToThirdPartySite: false,
    remoteWorkModel: { text: "Hybride werken", type: "REMOTE_HYBRID" },
    requirementLabels: ["B2B", "Facilitair management", "Bachelor"],
    salarySnippet: {
      currency: "EUR",
      source: "EXTRACTION",
      text: "€ 5.500 - € 7.500 per maand",
    },
    snippet:
      '<ul><li style="margin-bottom:0px;">Salaris:* €5.500 – €7.500 bruto per maand.</li></ul>',
    sponsored: true,
    title: "Business Developer / Adviseur Energie",
    truncatedCompany: "CloudCrest B.V.",
    urgentlyHiring: false,
    viewJobLink: "/viewjob?jk=12c9e91e86a09037&from=vjs&tk=1k2r1ps1fhbbd800",
    ...cardOverrides,
  },
  detail: {
    advertiserName: "bij-jacob",
    age: "30+ dagen geleden",
    companyName: "CloudCrest B.V.",
    formattedLocation: "Utrecht",
    jobKey: "12c9e91e86a09037",
    jobLanguage: "nl",
    jobLocation: "Utrecht",
    jobOccupations: ["K7RMC", "KTKTG", "MGTWW"],
    jobTitle: "Business Developer / Adviseur Energie",
    remoteWorkModel: { text: "Hybride werken", type: "REMOTE_HYBRID" },
    salaryInfoModel: {
      salaryCurrency: "EUR",
      salaryMax: 7500,
      salaryMin: 5500,
      salarySource: "EXTRACTION",
      salaryText: "€ 5.500 - € 7.500 per maand",
      salaryType: "MONTHLY",
    },
    sanitizedJobDescription:
      "<p><b>Business Developer / Adviseur Energie</b></p>\n<p><b>Locatie:</b> Utrecht (hybride)<br><b>Dienstverband:</b> Fulltime<br><b>Salaris:</b> €5.500 – €7.500 bruto per maand</p>",
    ...detailOverrides,
  },
  jobkey: "12c9e91e86a09037",
});

describe("normaliseIndeedObservation", () => {
  it("maps the real captured payload onto the draft", () => {
    const draft = parseIndeedPayload(buildPayload(), "hash-1");
    expect(draft.titel.value).toBe("Business Developer / Adviseur Energie");
    expect(draft.beschrijving.value).toContain(
      "Salaris: €5.500 – €7.500 bruto per maand"
    );
    expect(draft.beschrijving.value).not.toContain("<b>");
    expect(draft.bronReferentie.value).toBe("12c9e91e86a09037");
    expect(draft.bronUrl.value).toBe(
      "https://nl.indeed.com/viewjob?jk=12c9e91e86a09037"
    );
    expect(draft.opdrachtgeverNaam.value).toBe("CloudCrest B.V.");
    expect(draft.locatieTekst.value).toBe("Utrecht");
    expect(draft.locatieLand.value).toBe("NL");
    expect(draft.tarief).toEqual({
      eenheid: "maand",
      max: "7500",
      min: "5500",
      valuta: "EUR",
    });
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.sluitingsdatum).toBeUndefined();
    expect(draft.lifecycle).toBe("active");
    expect(draft.extractieMethode).toBe("html_parser");
    expect(draft.parserVersion).toBe("indeed/v1");
  });

  it("keeps a yearly salary honest UNKNOWN (never converts to maand)", () => {
    const draft = parseIndeedPayload(
      buildPayload({
        salaryInfoModel: {
          salaryCurrency: "EUR",
          salaryMax: 110_000,
          salaryMin: 80_000,
          salarySource: "EXTRACTION",
          salaryText: "€ 80.000 - € 110.000 per jaar",
          salaryType: "YEARLY",
        },
      }),
      "hash-2"
    );
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
    expect(draft.tarief.min).toBe(UNKNOWN);
    // SAFETY: bronSpecifiek is the connector-owned object built above;
    // only the salaris_* keys are asserted here.
    const specifiek = draft.bronSpecifiek.value as {
      salaris_min?: number | null;
      salaris_tekst?: string | null;
      salaris_type?: string | null;
    };
    expect(specifiek.salaris_tekst).toBe("€ 80.000 - € 110.000 per jaar");
    expect(specifiek.salaris_type).toBe("YEARLY");
    expect(specifiek.salaris_min).toBe(80_000);
  });

  it("reads an expired card as closed", () => {
    const draft = parseIndeedPayload(
      buildPayload({}, { expired: true }),
      "hash-3"
    );
    expect(draft.lifecycle).toBe("closed");
  });

  it("falls back to card fields when the detail carries less", () => {
    const draft = parseIndeedPayload(
      buildPayload({
        companyName: null,
        formattedLocation: null,
        jobTitle: null,
        salaryInfoModel: null,
        sanitizedJobDescription: null,
      }),
      "hash-4"
    );
    expect(draft.titel.value).toBe("Business Developer / Adviseur Energie");
    expect(draft.opdrachtgeverNaam.value).toBe("CloudCrest B.V.");
    expect(draft.locatieTekst.value).toBe("Utrecht");
    // card.extractedSalary still lands the maand tarief.
    expect(draft.tarief.eenheid).toBe("maand");
    expect(draft.tarief.min).toBe("5500");
    // beschrijving degrades to the card snippet text, never empty.
    expect(draft.beschrijving.value.length).toBeGreaterThan(0);
  });

  it("normalises the body the fixture connector actually emits", async () => {
    const connector = createIndeedConnector({
      bronId: BRON_ID,
      client: createIndeedClient({ liveEnabled: false }),
    });
    const discovery = await connector.discover(null);
    const [first] = discovery.items;
    if (!first) {
      throw new Error("expected fixture items");
    }
    const result = await connector.fetch(first);
    if (result?.status !== "fetched") {
      throw new Error("expected a fetched result");
    }
    const draft = normaliseIndeedObservation(result.body, result.contentHash);
    expect(draft.titel.value).toBe("Business Developer / Adviseur Energie");
    expect(draft.beschrijving.value).toContain("CloudCrest");
    expect(draft.tarief.eenheid).toBe("maand");
  });
});
