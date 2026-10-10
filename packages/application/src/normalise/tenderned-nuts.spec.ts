import { describe, expect, it } from "bun:test";

import { UNKNOWN } from "@ji/domain";

import {
  normaliseNutsOmschrijving,
  nutsCodesToLocatieTekst,
  parseTenderNedNutsEntries,
} from "./tenderned-nuts";

describe("tenderned NUTS → locatie (CTP-506)", () => {
  it("maps fixture string code NL329 to Groot-Amsterdam", () => {
    expect(nutsCodesToLocatieTekst(["NL329"])).toBe("Groot-Amsterdam");
  });

  it("maps remapped code NL32B to the same Groot-Amsterdam label", () => {
    expect(nutsCodesToLocatieTekst(["NL32B"])).toBe("Groot-Amsterdam");
  });

  it("prefers omschrijving from live object form", () => {
    expect(
      nutsCodesToLocatieTekst([{ code: "NL23", omschrijving: "Flevoland" }])
    ).toBe("Flevoland");
  });

  it("title-cases ALL-CAPS omschrijving from TenderNed", () => {
    expect(normaliseNutsOmschrijving("NOORD-NEDERLAND")).toBe(
      "Noord-Nederland"
    );
    expect(
      nutsCodesToLocatieTekst([
        { code: "NL1", omschrijving: "NOORD-NEDERLAND" },
      ])
    ).toBe("Noord-Nederland");
  });

  it("keeps already mixed-case omschrijving unchanged", () => {
    expect(normaliseNutsOmschrijving("Agglomeratie Haarlem")).toBe(
      "Agglomeratie Haarlem"
    );
  });

  it("prefers the most specific code when several are present", () => {
    expect(
      nutsCodesToLocatieTekst([
        { code: "NL1", omschrijving: "NOORD-NEDERLAND" },
        { code: "NL23", omschrijving: "Flevoland" },
      ])
    ).toBe("Flevoland");
  });

  it("falls back to the label map when omschrijving is missing", () => {
    expect(nutsCodesToLocatieTekst([{ code: "NL411" }, { code: "NL4" }])).toBe(
      "West-Noord-Brabant"
    );
  });

  it("returns UNKNOWN for empty, null, or unlabelled input", () => {
    expect(nutsCodesToLocatieTekst(null)).toBe(UNKNOWN);
    expect(nutsCodesToLocatieTekst()).toBe(UNKNOWN);
    expect(nutsCodesToLocatieTekst([])).toBe(UNKNOWN);
    expect(nutsCodesToLocatieTekst([{ code: "XX999" }])).toBe(UNKNOWN);
  });

  it("parses mixed string/object arrays and ignores junk", () => {
    expect(
      parseTenderNedNutsEntries([
        "nl329",
        { code: "NL23", omschrijving: "Flevoland" },
        42,
        { omschrijving: "no code" },
        null,
      ])
    ).toEqual([
      { code: "NL329", omschrijving: null },
      { code: "NL23", omschrijving: "Flevoland" },
    ]);
  });
});
