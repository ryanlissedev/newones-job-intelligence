import { describe, expect, it } from "bun:test";

import type { FlinterFetchedPayload } from "@ji/connectors/flinter";
import { UNKNOWN } from "@ji/domain";

import { normaliseFlinterObservation, parseFlinterPayload } from "./flinter";

/** Built from the real listing + detail capture in
 * fixtures/connectors/flinter/listing-page-0.json and
 * fixtures/connectors/flinter/detail-vergunningverlener-agrarisch.json
 * (slug "vergunningverlener-agrarisch", captured 2026-08-31). */
const buildAssignmentPayload = (
  overrides: Partial<FlinterFetchedPayload["detail"]> = {}
): FlinterFetchedPayload => ({
  detail: {
    beschrijvingHtml:
      "<h2>Omgevingsdienst Drenthe</h2><div><p>Flinter zoekt namens Omgevingsdienst Drenthe een Vergunningverlener Agrarisch.</p></div>",
    isPermanentVacancy: false,
    slug: "vergunningverlener-agrarisch",
    titel: "Vergunningverlener Agrarisch",
    urenPerWeek: "36",
    ...overrides,
  },
  listing: {
    locatiePlaats: "Assen",
    looptijdTekst: "1 jr",
    opdrachtgeverNaam: "Omgevingsdienst Drenthe",
    slug: "vergunningverlener-agrarisch",
    titel: "Vergunningverlener Agrarisch",
  },
});

describe("parseFlinterPayload", () => {
  it("maps a real assignment to a normalised draft with tarief/startdatum/sluitingsdatum UNKNOWN", () => {
    const draft = parseFlinterPayload(buildAssignmentPayload(), "hash-1");

    expect(draft.titel.value).toBe("Vergunningverlener Agrarisch");
    expect(draft.opdrachtgeverNaam.value).toBe("Omgevingsdienst Drenthe");
    expect(draft.locatieTekst.value).toBe("Assen");
    expect(draft.locatieLand.value).toBe("NL");
    expect(draft.bronReferentie.value).toBe("vergunningverlener-agrarisch");
    expect(draft.bronUrl.value).toBe(
      "https://www.flinter.nl/opdrachten/vergunningverlener-agrarisch"
    );
    expect(draft.beschrijving.value).toContain("Vergunningverlener Agrarisch");

    // Genuinely absent at this source (docs/sources/flinter.md) -- never
    // inferred from prose, even though the fixture's own "Praktische zaken"
    // list mentions a (non-authoritative) "Startdatum z.s.m.".
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.startDatum.provenance.sourcePath).toBe(
      "n/a (not published by source)"
    );
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.max).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe(UNKNOWN);

    expect(draft.bronSpecifiek.value).toMatchObject({
      looptijd_tekst: "1 jr",
      slug: "vergunningverlener-agrarisch",
      uren_per_week_raw: "36",
    });
  });

  it("falls back locatie/opdrachtgever to UNKNOWN when the listing card carries neither", () => {
    const payload = buildAssignmentPayload();
    payload.listing.locatiePlaats = undefined;
    payload.listing.opdrachtgeverNaam = undefined;

    const draft = parseFlinterPayload(payload, "hash-2");

    expect(draft.locatieTekst.value).toBe(UNKNOWN);
    expect(draft.opdrachtgeverNaam.value).toBe(UNKNOWN);
  });

  it("falls back beschrijving to the titel when the detail page carries no description text", () => {
    const draft = parseFlinterPayload(
      buildAssignmentPayload({ beschrijvingHtml: "" }),
      "hash-3"
    );

    expect(draft.beschrijving.value).toBe("Vergunningverlener Agrarisch");
  });

  it("carries the raw parserVersion through contentHash and provenance", () => {
    const draft = parseFlinterPayload(buildAssignmentPayload(), "hash-4");
    expect(draft.contentHash).toBe("hash-4");
    expect(draft.titel.provenance.parserVersion).toBe("flinter/v1");
  });

  it("never auto-closes on a closing date (RJC-377): no such field exists at this source", () => {
    const draft = parseFlinterPayload(buildAssignmentPayload(), "hash-5");
    expect(draft.lifecycle).not.toBe("closed");
    expect(draft.status).not.toBe("closed");
  });
});

describe("normaliseFlinterObservation", () => {
  it("round-trips a JSON-encoded FlinterFetchedPayload body", () => {
    const payload = buildAssignmentPayload();
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const draft = normaliseFlinterObservation(body, "hash-roundtrip");
    expect(draft.titel.value).toBe("Vergunningverlener Agrarisch");
    expect(draft.contentHash).toBe("hash-roundtrip");
  });
});
