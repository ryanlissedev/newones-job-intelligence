import { describe, expect, it } from "bun:test";

import { CLEARED } from "@ji/domain";

import { listMissingEnrichmentFields } from "./incomplete";

const parts = {
  externalId: "abc-123",
  platform: "flextender",
  title: "Senior Java Developer",
} as const;

const completeFacts = {
  beschrijving: "A short but real description.",
  bronSpecifiek: { opleidingsniveau: "HBO" },
  contracttype: "detachering",
  eindDatum: "2027-01-01",
  locatieTekst: "Utrecht",
  opdrachtgeverNaam: "Gemeente Utrecht",
  publicatiedatum: "2026-08-01",
  sluitingsdatum: "2026-09-01T21:59:59.000Z",
  startDatum: "2026-10-01",
  tariefEenheid: "uur",
  tariefMax: "100",
  tariefMin: "90",
  urenPerWeek: "36",
  werkvorm: "Hybride",
} as const;

describe("incomplete enrichment beschrijving", () => {
  it("marks only the exact title fallback as incomplete", () => {
    expect(
      listMissingEnrichmentFields({
        ...completeFacts,
        beschrijving: "Senior Java Developer (flextender/abc-123)",
        titleFallbackParts: parts,
      })
    ).toContain("beschrijving");
    expect(
      listMissingEnrichmentFields({
        ...completeFacts,
        titleFallbackParts: parts,
      })
    ).not.toContain("beschrijving");
  });
});

describe("incomplete enrichment detail fields", () => {
  it("marks each new detail field missing when its fact is absent", () => {
    expect(
      listMissingEnrichmentFields({
        ...completeFacts,
        eindDatum: null,
        opdrachtgeverNaam: null,
        sluitingsdatum: null,
        startDatum: null,
        urenPerWeek: null,
      })
    ).toEqual(
      expect.arrayContaining([
        "einddatum",
        "organisatie",
        "sluitingsdatum",
        "startdatum",
        "uren",
      ])
    );
    expect(listMissingEnrichmentFields(completeFacts)).toEqual([]);
  });

  it("marks opleiding missing only when the bron fact is absent", () => {
    expect(listMissingEnrichmentFields(completeFacts)).not.toContain(
      "opleiding"
    );
    expect(
      listMissingEnrichmentFields({
        ...completeFacts,
        bronSpecifiek: { education_level: "Bachelor" },
      })
    ).not.toContain("opleiding");
    expect(
      listMissingEnrichmentFields({ ...completeFacts, bronSpecifiek: {} })
    ).toContain("opleiding");
    expect(
      listMissingEnrichmentFields({
        ...completeFacts,
        bronSpecifiek: { opleidingsniveau: "unknown" },
      })
    ).toContain("opleiding");
  });

  it("reads startdatum and organisatie from bron_specifiek fallbacks", () => {
    expect(
      listMissingEnrichmentFields({
        ...completeFacts,
        bronSpecifiek: {
          opdrachtgever_naam: "Gemeente X",
          opleidingsniveau: "HBO",
          start_datum: "2026-10-01",
        },
        opdrachtgeverNaam: null,
        startDatum: null,
      })
    ).toEqual([]);
  });

  it("never marks a detail field missing when the fact is CLEARED", () => {
    const missing = listMissingEnrichmentFields({
      ...completeFacts,
      eindDatum: CLEARED,
      opdrachtgeverNaam: CLEARED,
      sluitingsdatum: CLEARED,
      startDatum: CLEARED,
      urenPerWeek: CLEARED,
    });
    for (const field of [
      "einddatum",
      "organisatie",
      "sluitingsdatum",
      "startdatum",
      "uren",
    ]) {
      expect(missing).not.toContain(field);
    }
  });
});
