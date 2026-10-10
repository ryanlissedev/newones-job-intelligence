import { describe, expect, it } from "bun:test";

import { CLEARED } from "@ji/domain";

import { planCuratedEnrichmentPatch } from "./persist-curated";
import type { EnrichmentProposal } from "./types";

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

const locatieProposal: EnrichmentProposal = {
  confidence: 0.92,
  field: "locatie",
  rawRefs: [
    {
      excerpt: "Locatie: Utrecht",
      field: "locatie",
      sourcePath: "beschrijving",
    },
  ],
  source: "deterministic",
  value: { locatieTekst: "Utrecht" },
};

const tariefProposal: EnrichmentProposal = {
  confidence: 0.9,
  field: "tarief",
  rawRefs: [],
  source: "deterministic",
  value: {
    eenheid: "uur",
    max: "110",
    min: "90",
    valuta: "EUR",
  },
};

const contractProposal: EnrichmentProposal = {
  confidence: 0.91,
  field: "contract",
  rawRefs: [],
  source: "deterministic",
  value: { contracttype: "detachering" },
};

const remoteProposal: EnrichmentProposal = {
  confidence: 0.88,
  field: "remote",
  rawRefs: [],
  source: "deterministic",
  value: { werkvorm: "Hybride" },
};

describe("planCuratedEnrichmentPatch", () => {
  it("fills missing curated commercial columns from high-confidence proposals", () => {
    const patch = planCuratedEnrichmentPatch(emptyFacts, [
      locatieProposal,
      tariefProposal,
      contractProposal,
      remoteProposal,
    ]);

    expect(patch).toEqual({
      contracttype: "detachering",
      fields: ["locatie", "tarief", "contract", "remote"],
      locatieTekst: "Utrecht",
      tariefEenheid: "uur",
      tariefMax: "110",
      tariefMin: "90",
      tariefValuta: "EUR",
      werkvorm: "Hybride",
    });
  });

  it("does not overwrite published bron values", () => {
    const patch = planCuratedEnrichmentPatch(
      {
        ...emptyFacts,
        contracttype: "interim",
        locatieTekst: "Amsterdam",
        tariefEenheid: "uur",
        tariefMax: "100",
        tariefMin: "80",
        tariefValuta: "EUR",
        werkvorm: "Op locatie",
      },
      [locatieProposal, tariefProposal, contractProposal, remoteProposal]
    );

    expect(patch).toBeNull();
  });

  it("never resurrects CLEARED commercial keys from column tombstones", () => {
    const patch = planCuratedEnrichmentPatch(
      {
        ...emptyFacts,
        contracttype: CLEARED,
        locatieTekst: CLEARED,
        tariefEenheid: CLEARED,
        tariefMax: CLEARED,
        tariefMin: CLEARED,
        werkvorm: CLEARED,
      },
      [locatieProposal, tariefProposal, contractProposal, remoteProposal]
    );

    expect(patch).toBeNull();
  });

  it("never resurrects CLEARED commercial keys still present in bron_specifiek", () => {
    const patch = planCuratedEnrichmentPatch(
      {
        ...emptyFacts,
        bronSpecifiek: {
          contracttype: CLEARED,
          locatie_tekst: CLEARED,
          tarief_eenheid: CLEARED,
          werkvorm: CLEARED,
        },
      },
      [locatieProposal, tariefProposal, contractProposal, remoteProposal]
    );

    expect(patch).toBeNull();
  });

  it("skips proposals below apply confidence", () => {
    const patch = planCuratedEnrichmentPatch(emptyFacts, [
      {
        ...locatieProposal,
        confidence: 0.84,
      },
    ]);

    expect(patch).toBeNull();
  });

  it("fills only the gaps that are not CLEARED", () => {
    const patch = planCuratedEnrichmentPatch(
      {
        ...emptyFacts,
        bronSpecifiek: { locatie_tekst: CLEARED },
        locatieTekst: null,
      },
      [locatieProposal, contractProposal]
    );

    expect(patch).toEqual({
      contracttype: "detachering",
      fields: ["contract"],
    });
  });

  it("never resurrects commercial keys recorded in durable _cleared markers", () => {
    const patch = planCuratedEnrichmentPatch(
      {
        ...emptyFacts,
        bronSpecifiek: {
          _cleared: {
            contracttype: true,
            locatie_tekst: true,
            tarief_eenheid: true,
            tarief_max: true,
            tarief_min: true,
            werkvorm: true,
          },
          other_meta: "keep-me",
        },
        contracttype: null,
        locatieTekst: null,
        tariefEenheid: null,
        tariefMax: null,
        tariefMin: null,
        werkvorm: null,
      },
      [locatieProposal, tariefProposal, contractProposal, remoteProposal]
    );

    expect(patch).toBeNull();
  });
});

describe("planCuratedEnrichmentPatch publicatiedatum", () => {
  it("fills null curated publicatiedatum from JobPosting proposal", () => {
    const patch = planCuratedEnrichmentPatch(emptyFacts, [
      {
        confidence: 0.95,
        field: "publicatiedatum",
        rawRefs: [],
        source: "deterministic",
        value: { publicatiedatum: "2026-08-10T22:00:00Z" },
      },
    ]);

    expect(patch).toEqual({
      fields: ["publicatiedatum"],
      publicatiedatum: "2026-08-10T22:00:00Z",
    });
  });

  it("does not overwrite an existing publicatiedatum", () => {
    const patch = planCuratedEnrichmentPatch(
      { ...emptyFacts, publicatiedatum: "2026-07-01T00:00:00Z" },
      [
        {
          confidence: 0.95,
          field: "publicatiedatum",
          rawRefs: [],
          source: "deterministic",
          value: { publicatiedatum: "2026-08-10T22:00:00Z" },
        },
      ]
    );

    expect(patch).toBeNull();
  });
});

describe("planCuratedEnrichmentPatch beschrijving", () => {
  it("fills the exact title fallback from a deterministic proposal", () => {
    const patch = planCuratedEnrichmentPatch(emptyFacts, [
      {
        confidence: 0.95,
        field: "beschrijving",
        rawRefs: [],
        source: "deterministic",
        value: { beschrijving: "Volledige bronbeschrijving." },
      },
    ]);

    expect(patch).toEqual({
      beschrijving: "Volledige bronbeschrijving.",
      fields: ["beschrijving"],
    });
  });

  it("does not overwrite a non-placeholder description", () => {
    const patch = planCuratedEnrichmentPatch(
      { ...emptyFacts, beschrijving: "Een echte bronbeschrijving." },
      [
        {
          confidence: 0.95,
          field: "beschrijving",
          rawRefs: [],
          source: "deterministic",
          value: { beschrijving: "Niet toepassen." },
        },
      ]
    );

    expect(patch).toBeNull();
  });
});
