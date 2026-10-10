import { describe, expect, it } from "bun:test";

import { CLEARED_BRON_MARKER_KEY } from "@ji/domain";

import {
  planCuratedEnrichmentPatchFromStored,
  proposalsFromStoredEnrichment,
} from "./apply-stored-curated";

const emptyFacts = {
  beschrijving: "Senior Java Developer (flextender/abc-123)",
  bronSpecifiek: {},
  contracttype: null,
  eindDatum: null,
  locatieTekst: null,
  opdrachtgeverNaam: null,
  publicatiedatum: null,
  sluitingsdatum: null,
  startDatum: null,
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: null,
  tariefValuta: null,
  titleFallbackParts: {
    externalId: "abc-123",
    platform: "flextender",
    title: "Senior Java Developer",
  },
  urenPerWeek: null,
  werkvorm: null,
} as const;

describe("proposalsFromStoredEnrichment", () => {
  it("keeps only high-confidence deterministic rows", () => {
    const proposals = proposalsFromStoredEnrichment([
      {
        confidence: 0.92,
        field: "locatie",
        source: "deterministic",
        value: { locatieTekst: "Utrecht" },
      },
      {
        confidence: 0.99,
        field: "contract",
        source: "llm",
        value: { contracttype: "interim" },
      },
      {
        confidence: 0.5,
        field: "remote",
        source: "deterministic",
        value: { werkvorm: "Hybride" },
      },
    ]);
    expect(proposals).toEqual([
      {
        confidence: 0.92,
        field: "locatie",
        rawRefs: [],
        source: "deterministic",
        value: { locatieTekst: "Utrecht" },
      },
    ]);
  });
});

describe("planCuratedEnrichmentPatchFromStored", () => {
  it("plans curated fills from stored enrichment", () => {
    const patch = planCuratedEnrichmentPatchFromStored(emptyFacts, [
      {
        confidence: 0.91,
        field: "locatie",
        source: "deterministic",
        value: { locatieTekst: "Den Haag" },
      },
      {
        confidence: 0.9,
        field: "contract",
        source: "deterministic",
        value: { contracttype: "detachering" },
      },
    ]);
    expect(patch).toEqual({
      contracttype: "detachering",
      fields: ["locatie", "contract"],
      locatieTekst: "Den Haag",
    });
  });

  it("respects durable CLEARED markers", () => {
    const patch = planCuratedEnrichmentPatchFromStored(
      {
        ...emptyFacts,
        bronSpecifiek: {
          [CLEARED_BRON_MARKER_KEY]: { locatie_tekst: true },
        },
      },
      [
        {
          confidence: 0.95,
          field: "locatie",
          source: "deterministic",
          value: { locatieTekst: "Utrecht" },
        },
        {
          confidence: 0.9,
          field: "contract",
          source: "deterministic",
          value: { contracttype: "interim" },
        },
      ]
    );
    expect(patch).toEqual({
      contracttype: "interim",
      fields: ["contract"],
    });
  });

  it("parses and applies a stored beschrijving proposal", () => {
    const patch = planCuratedEnrichmentPatchFromStored(emptyFacts, [
      {
        confidence: 0.95,
        field: "beschrijving",
        source: "deterministic",
        value: { beschrijving: "Volledige bronbeschrijving." },
      },
    ]);

    expect(patch).toEqual({
      beschrijving: "Volledige bronbeschrijving.",
      fields: ["beschrijving"],
    });
  });
});
