import { describe, expect, it } from "bun:test";

import { allianderConfig, createJsonLdClient } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://werkenbij.alliander.com/vacatures/business-partner-veiligheid-milieu-en-kwaliteit/jr14092",
    "Business Partner Veiligheid, Milieu en Kwaliteit",
    "Alliander",
    "Arnhem",
    "JR14092",
    "2026-09-17T07:00:00",
    "2026-10-09T07:00:00",
  ],
  [
    "https://werkenbij.alliander.com/vacatures/gasmonteur-in-opleiding/jr18244",
    "Gasmonteur in opleiding",
    "Liander",
    "Amsterdam",
    "JR18244",
    "2026-09-17T07:00:00",
    "2026-10-20T07:00:00",
  ],
] as const;

describe("normaliseJsonLdObservation -- Alliander", () => {
  it("normalises each recorded vacancy API record", async () => {
    const client = createJsonLdClient({
      config: allianderConfig,
      liveEnabled: false,
    });
    await Promise.all(
      cases.map(
        async ([url, title, employer, city, id, published, validThrough]) => {
          const detail = await client.fetchDetail(url);
          const draft = normaliseJsonLdObservation(
            new TextEncoder().encode(
              JSON.stringify({
                ...detail,
                parserVersion: allianderConfig.parserVersion,
                slug: allianderConfig.slug,
                url,
              })
            ),
            "hash"
          );
          expect(draft.titel.value).toBe(title);
          expect(draft.bronReferentie.value).toBe(
            new URL(url).pathname.slice(1)
          );
          expect(draft.opdrachtgeverNaam.value).toBe(employer);
          expect(draft.locatieTekst.value).toBe(city);
          expect(draft.bronSpecifiek).toMatchObject({
            value: {
              contract_type: "Fulltime",
              label_block: {
                referentienummer: id,
                salarisschaal: expect.any(String),
                urenPerWeek: "40 uur",
              },
              publicatiedatum: published,
              uren_per_week: "40",
              valid_through: validThrough,
            },
          });
          expect(draft.sluitingsdatum).toBeDefined();
        }
      )
    );
  });
});
