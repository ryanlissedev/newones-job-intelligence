import { describe, expect, it } from "bun:test";

import type { FreelancerNlFetchedPayload } from "@ji/connectors/freelancer-nl";
import { UNKNOWN } from "@ji/domain";

import {
  normaliseFreelancerNlObservation,
  parseFreelancerNlPayload,
} from "./freelancer-nl";

const payload: FreelancerNlFetchedPayload = {
  detail: {
    bronReferentie: "cfc3ced1",
    categorie: "Design & Creative",
    geplaatst: "Geplaatst 15-09-2026",
    locatie: "Remote",
    omschrijvingHtml: "<p>These projects will be done in Archicad.</p>",
    skills: ["archicad", "designer", "architect"],
    soortBudget: "In overleg",
    start: "05-10-2026",
    status: "Open",
    titel: "Designer needed for residential projects",
    url: "https://freelancer.nl/opdrachten/archicad-designer-architect/designer-needed-for-residential-projects-cfc3ced1",
    verwachteDuur: "In Overleg",
  },
  listing: {
    bronReferentie: "cfc3ced1",
    geplaatst: "Geplaatst 12 uur geleden",
    locatie: "Remote",
    reacties: "1 Reactie",
    titel: "Designer needed for residential projects",
    url: "https://freelancer.nl/opdrachten/archicad-designer-architect/designer-needed-for-residential-projects-cfc3ced1",
  },
};

describe("normaliseFreelancerNlObservation", () => {
  it("maps the literal HTML fields into the aanvraag draft", () => {
    const draft = parseFreelancerNlPayload(payload, "hash-freelancer-nl");

    expect(draft.titel.value).toBe("Designer needed for residential projects");
    expect(draft.bronReferentie.value).toBe("cfc3ced1");
    expect(draft.locatieTekst.value).toContain("Remote");
    expect(draft.startDatum.value).toBe("2026-10-05");
    expect(draft.beschrijving.value).toContain("Archicad");
    expect(draft.bronSpecifiek.value).toMatchObject({
      categorie: "Design & Creative",
      duur: "In Overleg",
      geplaatst: "Geplaatst 15-09-2026",
      publicatiedatum: "2026-09-15",
      skills: ["archicad", "designer", "architect"],
      soort_budget: "In overleg",
      status: "Open",
      verwachte_duur: "In Overleg",
    });
    expect(draft.lifecycle).toBe("active");
    expect(draft.tarief.min).toBe(UNKNOWN);
  });

  it("parses a priced 'Per Uur' budget block into tarief (CTP-611)", () => {
    const draft = parseFreelancerNlPayload(
      {
        ...payload,
        listing: { ...payload.listing, budget: "€30 — €40 Per Uur" },
      },
      "hash-freelancer-nl-tarief"
    );
    expect(draft.tarief.min).toBe("30");
    expect(draft.tarief.max).toBe("40");
    expect(draft.tarief.eenheid).toBe("uur");
    expect(draft.tarief.valuta).toBe("EUR");
  });

  it("keeps tarief UNKNOWN for a fixed-price budget — never mislabels it 'uur'", () => {
    const draft = parseFreelancerNlPayload(
      {
        ...payload,
        listing: { ...payload.listing, budget: "€1000 — €2000 Vaste Prijs" },
      },
      "hash-freelancer-nl-vaste-prijs"
    );
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.max).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
  });

  it("never promotes a relative 'Geplaatst X geleden' to publicatiedatum", () => {
    const draft = parseFreelancerNlPayload(
      {
        ...payload,
        detail: { ...payload.detail, geplaatst: "Geplaatst 12 uur geleden" },
      },
      "hash-freelancer-nl-rel"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      geplaatst: "Geplaatst 12 uur geleden",
      publicatiedatum: null,
    });
  });

  it("round-trips the connector JSON payload", () => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    expect(
      normaliseFreelancerNlObservation(body, "hash-roundtrip").contentHash
    ).toBe("hash-roundtrip");
  });
});
