import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  techniekwerktConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://techniekwerkt.nl/nl/vacature/monteur-elektrotechniek-unica-eindhoven-973508",
    "Monteur Elektrotechniek",
    "Unica",
    "Eindhoven",
    "973508",
    "2026-09-17T00:59:25.000000Z",
  ],
  [
    "https://techniekwerkt.nl/nl/vacature/pcs-7-software-engineer-unica-zwolle-973447",
    "PCS 7 Software Engineer",
    "Unica",
    "Zwolle",
    "973447",
    "2026-09-17T00:59:24.000000Z",
  ],
  [
    "https://techniekwerkt.nl/nl/vacature/leerling-monteur-werktuigbouwkunde-unica-rotterdam-973440",
    "Leerling Monteur Werktuigbouwkunde",
    "Unica",
    "Rotterdam",
    "973440",
    "2026-09-17T00:59:24.000000Z",
  ],
] as const;

describe("normaliseJsonLdObservation -- Techniekwerkt", () => {
  it("normalises each recorded detail", async () => {
    const client = createJsonLdClient({
      config: techniekwerktConfig,
      liveEnabled: false,
    });
    await Promise.all(
      cases.map(async ([url, title, company, city, id, updatedAt]) => {
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: techniekwerktConfig.parserVersion,
              slug: techniekwerktConfig.slug,
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.bronReferentie.value).toBe(new URL(url).pathname.slice(1));
        expect(draft.opdrachtgeverNaam.value).toBe(company);
        expect(draft.locatieTekst.value).toBe(city);
        expect(draft.bronSpecifiek).toMatchObject({
          value: {
            contract_type: null,
            label_block: {
              branche: "Installatiebedrijven",
              gewijzigdOp: updatedAt,
              referentienummer: id,
            },
            publicatiedatum: null,
            valid_through: null,
          },
        });
        expect(draft.sluitingsdatum).toBeUndefined();
      })
    );
  });
});
