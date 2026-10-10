import { describe, expect, it } from "bun:test";

import type { NeedstaffingFetchedPayload } from "@ji/connectors/needstaffing";
import { UNKNOWN } from "@ji/domain";

import { needstaffing } from "../sources/needstaffing";
import {
  normaliseNeedstaffingObservation,
  parseNeedstaffingPayload,
} from "./needstaffing";

/** Built from the real detail-page capture in
 * fixtures/connectors/needstaffing/detail-15520.json (id 15520,
 * "Operationeel Database Ontwikkelaar 2026-BZB-0457", captured
 * 2026-08-31). The fixture's `vacancy-text` body is deliberately
 * truncated ("verkort t.b.v. fixture") -- werkvorm/niveau/skills are not
 * present in THIS record, so this default builder omits them (honesty
 * case). The 2026-09-16 capture (joborder 15599, see the "live
 * capture" describe block below) proves the mapping when those
 * fields ARE published. Niveau is not covered by either fixture: it only
 * ever appears embedded in an "Eisen" prose sentence ("Minimaal een
 * afgeronde HBO-opleiding."), not as a structured field -- extracting it
 * would be free-text mining (GAP_ENRICH, out of scope), see the lane
 * report. */
const buildPayload = (
  overrides: Partial<NeedstaffingFetchedPayload["detail"]> = {}
): NeedstaffingFetchedPayload => ({
  detail: {
    deadline: "1788778800000",
    id: "15520",
    locatie: "Den Haag",
    periode: "4 maanden",
    referentie: "2026-BZB-0457",
    start: "1790380800000",
    tarief: "€98-102",
    tariefMax: "102",
    tariefMin: "98",
    titel: "Operationeel Database Ontwikkelaar 2026-BZB-0457",
    uren: "36",
    ...overrides,
  },
  listing: {
    deadline: "1788778800000",
    id: "15520",
    locatie: "Den Haag",
    opdrachtgeverNaam: "Belastingdienst",
    periode: "4 maanden",
    start: "1790380800000",
    tarief: "€98-102",
    titel: "Operationeel Database Ontwikkelaar 2026-BZB-0457",
    uren: "36",
  },
  raw: {
    html: "FIN  (Belastingdienst) / ZZP is NIET toegestaan / CV 5 Pagina's<br><p><b>Opdrachtomschrijving</b></p>In algemene zin kunnen de werkzaamheden als volgt worden beschreven.",
  },
});

describe("parseNeedstaffingPayload", () => {
  it("maps the .vacancy-contact-info contactpersonen into the draft (CTP-610)", () => {
    const draft = parseNeedstaffingPayload(
      buildPayload({
        contactpersonen: [
          {
            email: "recruiter@example.invalid",
            naam: "Test Recruiter",
            telefoon: null,
          },
        ],
      }),
      "hash-contact"
    );
    expect(draft.contactpersonen?.value).toEqual([
      {
        email: "recruiter@example.invalid",
        geinformeerdOp: null,
        naam: "Test Recruiter",
        notificatieKanaal: null,
        rol: null,
        telefoon: null,
      },
    ]);
    expect(draft.contactpersonen?.provenance.sourcePath).toBe(
      "detail.contactpersonen"
    );
  });

  it("omits contactpersonen when the detail carries none", () => {
    const draft = parseNeedstaffingPayload(buildPayload(), "hash-none");
    expect(draft.contactpersonen).toBeUndefined();
  });

  it("maps the real Operationeel Database Ontwikkelaar record end-to-end", () => {
    const draft = parseNeedstaffingPayload(buildPayload(), "hash-1");
    expect(draft.bronReferentie.value).toBe("15520");
    expect(draft.bronUrl.value).toBe(
      "https://www.needstaffing.nl/Opdrachten/15520"
    );
    expect(draft.titel.value).toBe(
      "Operationeel Database Ontwikkelaar 2026-BZB-0457"
    );
    expect(draft.locatieTekst.value).toBe("Den Haag");
    expect(draft.locatieLand.value).toBe("NL");
    // 1790380800000ms is the site's own displayed "26-09-2026" short date
    // (data-date-style="short"), confirmed matching UTC-sliced ISO for
    // this record -- unlike Onefellow, no local-timezone shift observed
    // here (both fixture timestamps land on a UTC day boundary).
    expect(draft.startDatum.value).toBe("2026-09-26");
    expect(draft.tarief).toEqual({
      eenheid: UNKNOWN,
      max: "102",
      min: "98",
      valuta: "EUR",
    });
    expect(draft.bronSpecifiek.value).toMatchObject({
      deadline: "2026-09-07",
      duur: "4 maanden",
      periode: "4 maanden",
      referentie: "2026-BZB-0457",
      skills: null,
      uren: "36",
      uren_per_week: "36",
      werkvorm: null,
    });
  });

  it("omits duur when periode is absent instead of guessing", () => {
    const draft = parseNeedstaffingPayload(
      buildPayload({ periode: undefined }),
      "hash-2"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: null,
      periode: null,
    });
  });

  it("returns UNKNOWN startdatum when start is absent instead of guessing", () => {
    const draft = parseNeedstaffingPayload(
      buildPayload({ start: undefined }),
      "hash-3"
    );
    expect(draft.startDatum.value).toBe(UNKNOWN);
  });
});

/** Mirrors what `parseNeedstaffingDetail` produces from
 * fixtures/connectors/needstaffing/detail-15599.json (see
 * packages/connectors/src/needstaffing/needstaffing.spec.ts for the
 * HTML-parsing assertions this shape is built from): the "Locatie" icon
 * field ("Den Haag/Hybride") splits into locatie + werkvorm, "Verwacht
 * aantal uren per week" carries a "u" unit suffix, and the vacancy
 * body's Competenties list is captured as competenties. */
const buildFullerPayload = (
  overrides: Partial<NeedstaffingFetchedPayload["detail"]> = {}
): NeedstaffingFetchedPayload => ({
  detail: {
    competenties: [
      "Eigenaarschap",
      "Overtuigingskracht",
      "Inhoudelijke scherpte",
      "Analytisch sterk",
    ],
    deadline: "1789740000000",
    id: "15599",
    locatie: "Den Haag",
    periode: "12 maanden",
    start: "1790640000000",
    tarief: "\u20AC90 - \u20AC100",
    tariefMax: "100",
    tariefMin: "90",
    titel: "Business Analist 202606A432 (vervanging)",
    uren: "36u",
    werkvorm: "Hybride",
    ...overrides,
  },
  listing: {
    deadline: "1789740000000",
    id: "15599",
    locatie: "Den Haag",
    opdrachtgeverNaam: "Nederlandse Emissieautoriteit",
    periode: "12 maanden",
    start: "1790640000000",
    tarief: "\u20AC90 - \u20AC100",
    titel: "Business Analist 202606A432 (vervanging)",
    uren: "36u",
    werkvorm: "Hybride",
  },
  raw: {
    html: "<p><strong>Let op! Het gaat om een vrije vervanging aanvraag!</strong></p><h1>Senior Business Analist (Vervanging) </h1><h2>OVER DE ORGANISATIE</h2>",
  },
});

describe("parseNeedstaffingPayload \u2014 live capture (2026-09-16, joborder 15599)", () => {
  it("maps werkvorm, skills, and unit-suffixed uren from structured fields", () => {
    const draft = parseNeedstaffingPayload(buildFullerPayload(), "hash-5");
    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: "12 maanden",
      skills: [
        "Eigenaarschap",
        "Overtuigingskracht",
        "Inhoudelijke scherpte",
        "Analytisch sterk",
      ],
      uren: "36",
      uren_per_week: "36",
      werkvorm: "Hybride",
    });
    // 1790640000000ms is UTC-midnight of the site's own displayed
    // "29-09-2026" -- confirmed matching UTC-sliced ISO on this second
    // real record too, same as the 15520 case above: no local-timezone
    // shift bug reproduced for Need Staffing (unlike Onefellow).
    expect(draft.startDatum.value).toBe("2026-09-29");
  });

  it("omits skills when competenties is absent instead of guessing", () => {
    const draft = parseNeedstaffingPayload(
      buildFullerPayload({ competenties: undefined }),
      "hash-6"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ skills: null });
  });

  it("omits werkvorm when the Locatie field has no split marker", () => {
    const draft = parseNeedstaffingPayload(
      buildFullerPayload({ werkvorm: undefined }),
      "hash-7"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ werkvorm: null });
  });
});

describe("normaliseNeedstaffingObservation", () => {
  it("round-trips a serialised payload", () => {
    const payload = buildPayload();
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const draft = normaliseNeedstaffingObservation(body, "hash-4");
    expect(draft.bronReferentie.value).toBe("15520");
    expect(draft.contentHash).toBe("hash-4");
  });
});

describe("needstaffing pipeline (live listing recording -> connector -> normalise)", () => {
  it("carries joborder 15599's werkvorm, competenties and uren through the connector", async () => {
    const connector = needstaffing.createConnector({
      bronId: needstaffing.bronId,
      listingFixturePath: "needstaffing/listing-live-2026-09-16.json",
      live: false,
      runKind: "test",
    });
    const discovery = await connector.discover(null);
    const item = discovery.items.find(
      (candidate) => candidate.bronReferentie === "15599"
    );
    if (!item) {
      throw new Error("expected 15599 in the 2026-09-16 listing recording");
    }
    const fetched = await connector.fetch(item);
    if (fetched?.status !== "fetched") {
      throw new Error("expected a fetched observation");
    }
    const draft = normaliseNeedstaffingObservation(
      fetched.body,
      item.contentHash
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: "12 maanden",
      uren_per_week: "36",
      werkvorm: "Hybride",
    });
    expect(draft.bronSpecifiek.value).toMatchObject({
      skills: expect.arrayContaining(["Eigenaarschap", "Analytisch sterk"]),
    });
  });
});
