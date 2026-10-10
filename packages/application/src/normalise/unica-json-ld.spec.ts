import { describe, expect, it } from "bun:test";

import { createJsonLdClient, unicaConfig } from "@ji/connectors/json-ld";

import { curateObservation } from "../identity/curate";
import { InMemoryCurateStore } from "../identity/store";
import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://www.werkenbijunica.nl/vacatures/werkvoorbereider-warmtenetten-oosterhout-aqlgyyae65n4goyv",
    "Werkvoorbereider Warmtenetten",
    "Unica Building Services Oosterhout",
    "3724",
    "5316",
    null,
  ],
  [
    "https://www.werkenbijunica.nl/vacatures/technisch-administratief-medewerker-oosterhout-aqk-1g-tfhzmqqg",
    "Technisch Administratief Medewerker",
    "Unica Building Services Oosterhout",
    "3200",
    "4460",
    null,
  ],
  [
    "https://www.werkenbijunica.nl/vacatures/accountmanager-venray-aqkcmj2yd4e-nszi",
    "Accountmanager",
    "Brainpact",
    "4000",
    "6000",
    "Limburg",
  ],
] as const;

describe("normaliseJsonLdObservation -- Unica", () => {
  it("normalises each employing entity, tariff, deadline and province", async () => {
    const client = createJsonLdClient({
      config: unicaConfig,
      liveEnabled: false,
    });
    await Promise.all(
      cases.map(async ([url, title, org, min, max, province]) => {
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: "unica/v2",
              slug: "unica",
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.opdrachtgeverNaam.value).toBe(org);
        expect(draft.locatieTekst.value).toBe(
          url.includes("venray") ? "Venray" : "Oosterhout"
        );
        expect(draft.tarief).toEqual({
          eenheid: "maand",
          max,
          min,
          valuta: "EUR",
        });
        expect(draft.bronSpecifiek).toMatchObject({
          value: {
            provincie: province,
            valid_through: "2027-09-15T23:59:59+02:00",
          },
        });
      })
    );
  });

  it("curates a normalised Unica observation end to end", async () => {
    const client = createJsonLdClient({
      config: unicaConfig,
      liveEnabled: false,
    });
    const url =
      "https://www.werkenbijunica.nl/vacatures/accountmanager-venray-aqkcmj2yd4e-nszi";
    const detail = await client.fetchDetail(url);
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(
        JSON.stringify({
          ...detail,
          parserVersion: "unica/v2",
          slug: "unica",
          url,
        })
      ),
      "hash"
    );
    const result = await curateObservation(new InMemoryCurateStore(), {
      bronId: "00000000-0000-4000-8000-00000000001f",
      draft,
      observedAt: new Date("2026-09-16T20:14:00Z"),
      rawPayloadRef: "raw/unica/accountmanager",
      scrapeRunId: "run-unica",
    });
    expect(result.status).toBe("curated");
    expect(draft.opdrachtgeverNaam.value).toBe("Brainpact");
    expect(draft.locatieTekst.value).toBe("Venray");
  });
});
