import { describe, expect, it } from "bun:test";

import { createJsonLdClient, essentConfig } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://www.werkenbijessent.nl/nl/vacatures/engineering/project-manager-warmtenetten",
    "Project Manager Warmtenetten",
    "Utrecht  / 's-Hertogenbosch",
    "€6523 - €8253",
    "36–40",
  ],
  [
    "https://www.werkenbijessent.nl/nl/vacatures/vacatures/financial-controller",
    "Financial Controller",
    "Amsterdam",
    "€3800 - €4500",
    "40",
  ],
] as const;

describe("normaliseJsonLdObservation -- Essent", () => {
  it("normalises each recorded DataItems detail", async () => {
    const client = createJsonLdClient({
      config: essentConfig,
      liveEnabled: false,
    });
    await Promise.all(
      cases.map(async ([url, title, location, salaris, uren]) => {
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: essentConfig.parserVersion,
              slug: essentConfig.slug,
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.bronReferentie.value).toBe(new URL(url).pathname.slice(1));
        expect(draft.opdrachtgeverNaam.value).toBe("Essent");
        expect(draft.locatieTekst.value).toBe(location);
        expect(draft.bronSpecifiek).toMatchObject({
          value: {
            label_block: {
              locatie: location,
              salaris,
              urenPerWeek: expect.any(String),
            },
            uren_per_week: uren,
          },
        });
        // No validThrough at the source -- no closing moment is invented.
        expect(draft.sluitingsdatum).toBeUndefined();
      })
    );
  });
});
