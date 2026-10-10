import { describe, expect, it } from "bun:test";

import { createJsonLdClient, enexisConfig } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://werkenbij.enexis.nl/vacatures/applicatie-engineer-13841",
    "Applicatie engineer",
    "Zwolle",
    "2026-06-29T19:08:50.000Z",
    "4223",
    "6033",
  ],
  [
    "https://werkenbij.enexis.nl/vacatures/junior-monteur-hoogspanning-13619",
    "Junior monteur hoogspanning",
    "Groningen",
    "2026-08-18T07:03:26.000Z",
    "2864",
    "4092",
  ],
  [
    "https://werkenbij.enexis.nl/vacatures/senior-projectmanager-13320",
    "Senior projectmanager",
    "Den Bosch",
    "2026-09-02T13:28:28.000Z",
    "4953",
    "7076",
  ],
] as const;

describe("normaliseJsonLdObservation -- Enexis", () => {
  it("normalises each recorded detail", async () => {
    const client = createJsonLdClient({
      config: enexisConfig,
      liveEnabled: false,
    });
    await Promise.all(
      cases.map(async ([url, title, location, datePosted, min, max]) => {
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: enexisConfig.parserVersion,
              slug: enexisConfig.slug,
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.bronReferentie.value).toBe(new URL(url).pathname.slice(1));
        expect(draft.opdrachtgeverNaam.value).toBe("Enexis Netbeheer B.V.");
        expect(draft.locatieTekst.value).toBe(location);
        expect(draft.tarief).toEqual({
          eenheid: "maand",
          max,
          min,
          valuta: "EUR",
        });
        expect(draft.bronSpecifiek).toMatchObject({
          value: {
            contract_type: null,
            publicatiedatum: datePosted,
            sluitings_datum: null,
            valid_through: null,
          },
        });
        expect(draft.sluitingsdatum).toBeUndefined();
      })
    );
  });
});
