import { describe, expect, it } from "bun:test";

import type { InhuurdeskFetchedPayload } from "@ji/connectors/inhuurdesk";
import { UNKNOWN } from "@ji/domain";

import {
  normaliseInhuurdeskObservation,
  parseInhuurdeskPayload,
} from "./inhuurdesk";

/** Built from the real capture in
 * fixtures/connectors/inhuurdesk/listing-page-0.json (id
 * 3c9792fd-d0ef-4bcc-9500-c2ceaba566a4, "Planner C", Alliander, captured
 * 2026-09-03). */
const buildPayload = (
  overrides: Partial<InhuurdeskFetchedPayload["assignment"]> = {}
): InhuurdeskFetchedPayload => ({
  assignment: {
    clientName: "Alliander",
    clientNameSlug: "alliander",
    closingDateClient: "2026-09-08T08:00:00",
    closingDateInvoice: "2026-09-08T08:00:00",
    content:
      "<h3><strong>Planner C</strong></h3>\n<p>Voor Alliander zoeken wij een Planner C &amp; sparringpartner.</p>",
    endDate: "2026-12-14T00:00:00",
    hasMaxRate: false,
    hourlyRateMax: 0,
    hourlyRateMin: 0,
    hoursPerWeekMax: 36,
    hoursPerWeekMin: 36,
    id: "3c9792fd-d0ef-4bcc-9500-c2ceaba566a4",
    location: "Arnhem Bellevue",
    publishedDate: "2026-09-03T11:46:00",
    referenceCode: "SRQ149582",
    segmentName: "Techniek Binnen",
    startDate: "2026-09-14T00:00:00",
    title: "Planner C",
    titleSlug: "planner-c",
    ...overrides,
  },
});

describe("parseInhuurdeskPayload (live schema, captured 2026-09-03)", () => {
  it("maps the projected contactpersonen into the draft (CTP-610)", () => {
    const draft = parseInhuurdeskPayload(
      buildPayload({
        contactpersonen: [
          {
            email: "recruiter@example.invalid",
            naam: "P. Persoon",
            rol: "Recruiter",
            telefoon: "+31000000000",
          },
        ],
      }),
      "hash-contact"
    );
    expect(draft.contactpersonen?.value).toEqual([
      {
        email: "recruiter@example.invalid",
        geinformeerdOp: null,
        naam: "P. Persoon",
        notificatieKanaal: null,
        rol: "Recruiter",
        telefoon: "+31000000000",
      },
    ]);
    expect(draft.contactpersonen?.provenance.sourcePath).toBe(
      "assignment.contactpersonen"
    );
  });

  it("omits contactpersonen when the payload carries none", () => {
    const draft = parseInhuurdeskPayload(buildPayload(), "hash-none");
    expect(draft.contactpersonen).toBeUndefined();
  });

  it("maps the real Planner C record into the normalised draft", () => {
    const draft = parseInhuurdeskPayload(buildPayload(), "hash-1");

    expect(draft.parserVersion).toBe("inhuurdesk/v4");
    expect(draft.titel.value).toBe("Planner C");
    expect(draft.bronReferentie.value).toBe(
      "3c9792fd-d0ef-4bcc-9500-c2ceaba566a4"
    );
    expect(draft.bronReferentie.provenance.sourcePath).toBe("assignment.id");
    expect(draft.opdrachtgeverNaam.value).toBe("Alliander");
    expect(draft.locatieTekst.value).toBe("Arnhem Bellevue");
    expect(draft.locatieLand.value).toBe("NL");
    expect(draft.startDatum.value).toBe("2026-09-14");
    expect(draft.beschrijving.value).toBe(
      "Planner C Voor Alliander zoeken wij een Planner C & sparringpartner."
    );
    expect(draft.bronUrl.value).toBe(
      "https://www.inhuurdesk.nl/aanvragen/alliander/planner-c/3c9792fd-d0ef-4bcc-9500-c2ceaba566a4"
    );
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2026-09-08T06:00:00.000Z"
    );
    expect(draft.bronSpecifiek.value).toEqual({
      aanvraagnummer: "SRQ149582",
      eind_datum: "2026-12-14T00:00:00",
      gepubliceerd_op: "2026-09-03T11:46:00",
      has_max_rate: false,
      provincie: null,
      segment: "Techniek Binnen",
      supplier_deadline: "2026-09-08T08:00:00",
      uren_max: 36,
      uren_min: 36,
      uren_per_week: "36",
    });
    expect(draft.extractieMethode).toBe("api");
  });

  it("maps provincie from an explicit 'stad, provincie' location text (CTP-520 F04)", () => {
    const draft = parseInhuurdeskPayload(
      buildPayload({ location: "Amsterdam, Noord-Holland" }),
      "hash-provincie"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      provincie: "Noord-Holland",
    });
  });

  it("leaves provincie null for the real bare city/site location text (honesty)", () => {
    // Real: "Arnhem Bellevue", "Gemeentehuis", "Schiedam" -- none of the 21
    // live 2026-09-03 records ever include a province name.
    const draft = parseInhuurdeskPayload(buildPayload(), "hash-no-provincie");
    expect(draft.bronSpecifiek.value).toMatchObject({ provincie: null });
  });

  it("keeps zero hourly rates as UNKNOWN (0 means not published)", () => {
    const draft = parseInhuurdeskPayload(buildPayload(), "hash-2");
    expect(draft.tarief).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("maps positive hourlyRateMin/Max to an EUR per-hour tarief", () => {
    const draft = parseInhuurdeskPayload(
      buildPayload({ hasMaxRate: true, hourlyRateMax: 110, hourlyRateMin: 0 }),
      "hash-3"
    );
    expect(draft.tarief).toEqual({
      eenheid: "uur",
      max: "110",
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("falls back to the description text parse when no structured rate exists", () => {
    const draft = parseInhuurdeskPayload(
      buildPayload({ content: "<p>Max tarief €95 incl msp fee per uur.</p>" }),
      "hash-4"
    );
    expect(draft.tarief.max).toBe("95");
    expect(draft.tarief.eenheid).toBe("uur");
  });

  it("leaves absent fields UNKNOWN instead of inventing values", () => {
    const draft = parseInhuurdeskPayload(
      buildPayload({
        clientName: null,
        clientNameSlug: null,
        closingDateClient: null,
        content: null,
        location: "  ",
        startDate: null,
      }),
      "hash-5"
    );
    expect(draft.opdrachtgeverNaam.value).toBe(UNKNOWN);
    expect(draft.locatieTekst.value).toBe(UNKNOWN);
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.bronUrl.value).toBe(UNKNOWN);
    expect(draft.sluitingsdatum).toBeUndefined();
    expect(draft.beschrijving.value).toBe("Planner C");
    expect(draft.lifecycle).toBe("active");
  });

  it("closes lifecycle once closingDateClient has passed, stays active before", () => {
    expect(
      parseInhuurdeskPayload(
        buildPayload({ closingDateClient: "2000-01-01T00:00:00" }),
        "hash-6"
      ).lifecycle
    ).toBe("closed");
    expect(
      parseInhuurdeskPayload(
        buildPayload({ closingDateClient: "2099-01-01T00:00:00" }),
        "hash-7"
      ).status
    ).toBe("active");
  });

  it("round-trips through the observation body decoder", () => {
    const body = new TextEncoder().encode(JSON.stringify(buildPayload()));
    const draft = normaliseInhuurdeskObservation(body, "hash-8");
    expect(draft.bronReferentie.value).toBe(
      "3c9792fd-d0ef-4bcc-9500-c2ceaba566a4"
    );
    expect(draft.contentHash).toBe("hash-8");
  });
});
