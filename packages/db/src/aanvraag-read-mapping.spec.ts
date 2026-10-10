import { describe, expect, it } from "bun:test";

import { readAanvraagBronFacts } from "./aanvraag-read-mapping";

describe("readAanvraagBronFacts", () => {
  it("preserves the publication formats and workform emitted by known normalisers", () => {
    expect(
      readAanvraagBronFacts({
        publicatiedatum: "2026-08-26T04:34:00+02:00",
      }).publicatiedatum
    ).toBe("2026-08-26T04:34:00+02:00");
    expect(
      readAanvraagBronFacts({
        gepubliceerd_op: "2026-09-03T11:46:00",
      }).publicatiedatum
    ).toBe("2026-09-03T11:46:00");
    expect(readAanvraagBronFacts({ werkvorm: "remote" }).werkvorm).toBe(
      "remote"
    );
    expect(
      readAanvraagBronFacts({ opdrachtgeverNaam: "Gemeente Amsterdam" })
        .opdrachtgeverNaam
    ).toBe("Gemeente Amsterdam");
  });

  it("reads the contract_type shape emitted by Opdrachtoverheid", () => {
    expect(
      readAanvraagBronFacts({ contract_type: "detachering" })
    ).toMatchObject({
      contracttype: "detachering",
    });
  });

  it("keeps valid facts when sibling optional fields are malformed", () => {
    expect(
      readAanvraagBronFacts({
        contract_type: "detachering",
        opdrachtgeverNaam: 42,
        publicatiedatum: "bad",
        werkvorm: " ",
      })
    ).toEqual({
      contracttype: "detachering",
      duur: null,
      opdrachtgeverNaam: null,
      opleidingsniveau: null,
      provincie: null,
      publicatiedatum: null,
      skills: [],
      startDatum: null,
      werkvorm: null,
    });
  });

  it("returns null for absent, blank, malformed, or unrelated source fields", () => {
    for (const bronSpecifiek of [
      null,
      {},
      { gepubliceerd_op: "" },
      { publicatiedatum: "not-a-date" },
      { publicatiedatum: "2026-02-31T10:00:00Z" },
      { time_published: 1_785_448_800 },
      { werkvorm: " " },
    ]) {
      const facts = readAanvraagBronFacts(bronSpecifiek);
      expect(facts.publicatiedatum).toBeNull();
      expect(facts.werkvorm).toBeNull();
    }
  });

  it("accepts date-only publication values from json-ld sources", () => {
    expect(
      readAanvraagBronFacts({ publicatiedatum: "2026-08-24" }).publicatiedatum
    ).toBe("2026-08-24");
  });

  it("reads the skills list and a canonical province off one curated row", () => {
    const facts = readAanvraagBronFacts({
      provincie: "noord holland",
      skills: ["Java", " java ", "", "Kubernetes"],
    });
    expect(facts.skills).toEqual(["Java", "Kubernetes"]);
    // "noord holland" never went through toCanonicalProvincie, so the read
    // path refuses it rather than canonicalising on the source's behalf.
    expect(facts.provincie).toBeNull();
  });

  it("reads the duur (looptijd) text emitted by harveynash/onefellow/needstaffing", () => {
    expect(readAanvraagBronFacts({ duur: "4 maanden" }).duur).toBe("4 maanden");
    expect(readAanvraagBronFacts({}).duur).toBeNull();
  });

  it("accepts the duration aliases existing normalisers actually emit (Onefellow, Needstaffing, Flinter) (CTP-514)", () => {
    expect(readAanvraagBronFacts({ duration: "6 months" }).duur).toBe(
      "6 months"
    );
    expect(readAanvraagBronFacts({ periode: "3 maanden" }).duur).toBe(
      "3 maanden"
    );
    expect(
      readAanvraagBronFacts({ looptijd_tekst: "t/m einde project" }).duur
    ).toBe("t/m einde project");
    // duur takes priority when a source somehow emits both.
    expect(
      readAanvraagBronFacts({ duration: "6 months", duur: "4 maanden" }).duur
    ).toBe("4 maanden");
  });

  it("accepts freelancer-nl's verwachte_duur alias for the looptijd fact (CTP-611)", () => {
    expect(readAanvraagBronFacts({ verwachte_duur: "In Overleg" }).duur).toBe(
      "In Overleg"
    );
    // Canonical duur still wins when both exist.
    expect(
      readAanvraagBronFacts({ duur: "3 maanden", verwachte_duur: "In Overleg" })
        .duur
    ).toBe("3 maanden");
  });

  it("passes a canonical province through unchanged", () => {
    expect(
      readAanvraagBronFacts({ provincie: "Noord-Holland" }).provincie
    ).toBe("Noord-Holland");
  });

  it("yields no skills and no province when the source published neither", () => {
    for (const bronSpecifiek of [
      null,
      {},
      { provincie: "Amsterdam", skills: "Java, Kubernetes" },
      { provincie: "", skills: [""] },
      { skills: [42, null] },
    ]) {
      const facts = readAanvraagBronFacts(bronSpecifiek);
      expect(facts.provincie).toBeNull();
      expect(facts.skills).toEqual([]);
    }
  });
});
