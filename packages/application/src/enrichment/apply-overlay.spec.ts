import { describe, expect, it } from "bun:test";

import { CLEARED } from "@ji/domain";

import {
  applyEnrichmentOverlayToAanvraagFacts,
  applyEnrichmentOverlayToSearchFacts,
  toEnrichedFieldMeta,
} from "./apply-overlay";
import type { EnrichmentOverlayRow } from "./apply-overlay";

const locatieRow: EnrichmentOverlayRow = {
  confidence: 0.9,
  field: "locatie",
  source: "deterministic",
  value: { locatieTekst: "Utrecht" },
};

const lowConfidence: EnrichmentOverlayRow = {
  confidence: 0.79,
  field: "locatie",
  source: "deterministic",
  value: { locatieTekst: "Den Haag" },
};

describe("enrichment overlay", () => {
  it("fills missing curated facts and exposes aangevuld metadata", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        contracttype: null,
        locatie: null,
        tariefEenheid: null,
        tariefMax: null,
        tariefMin: null,
        tariefValuta: null,
        werkvorm: null,
      },
      [
        locatieRow,
        {
          confidence: 0.92,
          field: "tarief",
          source: "deterministic",
          value: {
            eenheid: "uur",
            max: "110",
            min: "90",
            valuta: "EUR",
          },
        },
        {
          confidence: 0.91,
          field: "contract",
          source: "deterministic",
          value: { contracttype: "detachering" },
        },
        {
          confidence: 0.88,
          field: "remote",
          source: "deterministic",
          value: { werkvorm: "Hybride" },
        },
      ]
    );

    expect(overlaid.locatie).toBe("Utrecht");
    expect(overlaid.tariefMin).toBe(90);
    expect(overlaid.tariefMax).toBe(110);
    expect(overlaid.tariefEenheid).toBe("uur");
    expect(overlaid.tariefValuta).toBe("EUR");
    expect(overlaid.contracttype).toBe("detachering");
    expect(overlaid.werkvorm).toBe("Hybride");
    expect(
      overlaid.enrichedFields.map((entry) => entry.field).toSorted()
    ).toEqual(["contract", "locatie", "remote", "tarief"]);
  });

  it("does not overwrite curated values already published by the bron", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        contracttype: "interim",
        locatie: "Amsterdam",
        tariefEenheid: "uur",
        tariefMax: 100,
        tariefMin: 80,
        tariefValuta: "EUR",
        werkvorm: "Op locatie",
      },
      [locatieRow]
    );

    expect(overlaid.locatie).toBe("Amsterdam");
    expect(overlaid.enrichedFields).toEqual([
      { confidence: 0.9, field: "locatie", source: "deterministic" },
    ]);
  });

  it("keeps low-confidence rows out of aangevuld metadata", () => {
    expect(toEnrichedFieldMeta([lowConfidence])).toEqual([]);
  });

  it("overlays search documents for locatie/tarief/contract only", () => {
    const overlaid = applyEnrichmentOverlayToSearchFacts(
      {
        contracttype: null,
        locatie: null,
        tariefMax: null,
        tariefMin: null,
      },
      [
        locatieRow,
        {
          confidence: 0.9,
          field: "tarief",
          source: "deterministic",
          value: {
            eenheid: "uur",
            max: "120",
            min: "unknown",
            valuta: "EUR",
          },
        },
      ]
    );

    expect(overlaid.locatie).toBe("Utrecht");
    expect(overlaid.tariefMin).toBeNull();
    expect(overlaid.tariefMax).toBe(120);
  });

  it("does not resurrect CLEARED curated facts via overlay", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        contracttype: CLEARED,
        locatie: CLEARED,
        tariefEenheid: CLEARED,
        tariefMax: null,
        tariefMin: null,
        tariefValuta: null,
        werkvorm: CLEARED,
      },
      [locatieRow]
    );

    expect(overlaid.locatie).toBe(CLEARED);
    expect(overlaid.contracttype).toBe(CLEARED);
    expect(overlaid.werkvorm).toBe(CLEARED);
  });
});

describe("enrichment overlay detail fields (CTP-611)", () => {
  it("fills missing detail facts from enrichment rows", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        eindDatum: null,
        opdrachtgeverNaam: null,
        opleidingsniveau: null,
        sluitingsdatum: null,
        startDatum: null,
        urenPerWeek: null,
      },
      [
        {
          confidence: 0.9,
          field: "uren",
          source: "deterministic",
          value: { urenPerWeek: "36" },
        },
        {
          confidence: 0.86,
          field: "opleiding",
          source: "deterministic",
          value: { opleidingsniveau: "HBO" },
        },
        {
          confidence: 0.88,
          field: "startdatum",
          source: "deterministic",
          value: { startdatum: "2026-10-01" },
        },
        {
          confidence: 0.88,
          field: "einddatum",
          source: "deterministic",
          value: { einddatum: "2027-03-31" },
        },
        {
          confidence: 0.88,
          field: "sluitingsdatum",
          source: "deterministic",
          value: { sluitingsdatum: "2026-09-15" },
        },
        {
          confidence: 0.85,
          field: "organisatie",
          source: "deterministic",
          value: { organisatie: "Gemeente Utrecht" },
        },
      ]
    );

    expect(overlaid.urenPerWeek).toBe("36");
    expect(overlaid.opleidingsniveau).toBe("HBO");
    expect(overlaid.startDatum).toBe("2026-10-01");
    expect(overlaid.eindDatum).toBe("2027-03-31");
    expect(overlaid.sluitingsdatum).toBeInstanceOf(Date);
    expect(overlaid.opdrachtgeverNaam).toBe("Gemeente Utrecht");
    expect(
      overlaid.enrichedFields.map((entry) => entry.field).toSorted()
    ).toEqual([
      "einddatum",
      "opleiding",
      "organisatie",
      "sluitingsdatum",
      "startdatum",
      "uren",
    ]);
  });

  it("never overwrites published detail facts", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        opdrachtgeverNaam: "Gemeente Amsterdam",
        startDatum: "2026-01-01",
        urenPerWeek: "40",
      },
      [
        {
          confidence: 0.9,
          field: "uren",
          source: "deterministic",
          value: { urenPerWeek: "36" },
        },
        {
          confidence: 0.88,
          field: "startdatum",
          source: "deterministic",
          value: { startdatum: "2026-10-01" },
        },
        {
          confidence: 0.85,
          field: "organisatie",
          source: "deterministic",
          value: { organisatie: "Gemeente Utrecht" },
        },
      ]
    );

    expect(overlaid.urenPerWeek).toBe("40");
    expect(overlaid.startDatum).toBe("2026-01-01");
    expect(overlaid.opdrachtgeverNaam).toBe("Gemeente Amsterdam");
  });

  it("maps uren/organisatie/sluitingsdatum onto search documents", () => {
    const overlaid = applyEnrichmentOverlayToSearchFacts(
      {
        contracttype: null,
        tariefMax: null,
        tariefMin: null,
      },
      [
        {
          confidence: 0.9,
          field: "uren",
          source: "deterministic",
          value: { urenPerWeek: "32–40" },
        },
        {
          confidence: 0.85,
          field: "organisatie",
          source: "deterministic",
          value: { organisatie: "ProRail" },
        },
        {
          confidence: 0.88,
          field: "sluitingsdatum",
          source: "deterministic",
          value: { sluitingsdatum: "2026-09-15" },
        },
      ]
    );

    expect(overlaid.urenPerWeekMin).toBe(32);
    expect(overlaid.urenPerWeekMax).toBe(40);
    expect(overlaid.opdrachtgeverNaam).toBe("ProRail");
    expect(overlaid.sluitingsdatum).toBeInstanceOf(Date);
  });
});

describe("enrichment overlay publicatiedatum", () => {
  it("fills missing publicatiedatum from enrichment rows", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        contracttype: null,
        locatie: null,
        publicatiedatum: null,
        tariefEenheid: null,
        tariefMax: null,
        tariefMin: null,
        tariefValuta: null,
        werkvorm: null,
      },
      [
        {
          confidence: 0.95,
          field: "publicatiedatum",
          source: "deterministic",
          value: { publicatiedatum: "2026-08-10T22:00:00Z" },
        },
      ]
    );

    expect(overlaid.publicatiedatum).toBe("2026-08-10T22:00:00Z");
    expect(overlaid.enrichedFields.map((entry) => entry.field)).toContain(
      "publicatiedatum"
    );
  });
});

describe("enrichment overlay beschrijving", () => {
  it("overlays a stored description only onto the exact title fallback", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        beschrijving: "Senior Java Developer (flextender/abc-123)",
        contracttype: null,
        locatie: null,
        publicatiedatum: null,
        tariefEenheid: null,
        tariefMax: null,
        tariefMin: null,
        tariefValuta: null,
        titleFallbackParts: {
          externalId: "abc-123",
          platform: "flextender",
          title: "Senior Java Developer",
        },
        werkvorm: null,
      },
      [
        {
          confidence: 0.95,
          field: "beschrijving",
          source: "deterministic",
          value: { beschrijving: "Volledige bronbeschrijving." },
        },
      ]
    );

    expect(overlaid.beschrijving).toBe("Volledige bronbeschrijving.");
    expect(overlaid.enrichedFields).toEqual([
      { confidence: 0.95, field: "beschrijving", source: "deterministic" },
    ]);
  });

  it("does not overwrite a non-placeholder description", () => {
    const overlaid = applyEnrichmentOverlayToAanvraagFacts(
      {
        beschrijving: "Bronbeschrijving die al compleet is.",
        titleFallbackParts: {
          externalId: "abc-123",
          platform: "flextender",
          title: "Senior Java Developer",
        },
      },
      [
        {
          confidence: 0.95,
          field: "beschrijving",
          source: "deterministic",
          value: { beschrijving: "Niet toepassen." },
        },
      ]
    );

    expect(overlaid.beschrijving).toBe("Bronbeschrijving die al compleet is.");
  });
});
