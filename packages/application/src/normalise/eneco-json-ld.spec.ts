import { describe, expect, it } from "bun:test";

import { createJsonLdClient, enecoConfig } from "@ji/connectors/json-ld";

import { curateObservation } from "../identity/curate";
import { InMemoryCurateStore } from "../identity/store";
import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://www.werkenbijeneco.nl/vacatures/meewerkstage-dei-communicatie-employee-networks-2954",
    "Meewerkstage DEI: Communicatie & Employee Networks",
    "450",
    "675",
  ],
  [
    "https://www.werkenbijeneco.nl/vacatures/ervaren-accountsupporter-3145",
    "Ervaren Accountsupporter",
    "55000",
    "77000",
  ],
  [
    "https://www.werkenbijeneco.nl/vacatures/senior-trader-gas-2864",
    "Senior Trader Gas",
    "110000",
    "170000",
  ],
] as const;

describe("normaliseJsonLdObservation -- Eneco", () => {
  it("normalises each recorded detail", async () => {
    const client = createJsonLdClient({
      config: enecoConfig,
      liveEnabled: false,
    });
    await Promise.all(
      cases.map(async ([url, title, min, max]) => {
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: "eneco/v2",
              slug: "eneco",
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.opdrachtgeverNaam.value).toBe("Eneco");
        expect(draft.locatieTekst.value).toBe("Rotterdam");
        expect(draft.tarief).toEqual({
          eenheid: "maand",
          max,
          min,
          valuta: "EUR",
        });
        expect(draft.bronSpecifiek).toMatchObject({
          value: { valid_through: null },
        });
      })
    );
  });

  it("curates a normalised Eneco observation end to end", async () => {
    const client = createJsonLdClient({
      config: enecoConfig,
      liveEnabled: false,
    });
    const url =
      "https://www.werkenbijeneco.nl/vacatures/meewerkstage-dei-communicatie-employee-networks-2954";
    const detail = await client.fetchDetail(url);
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(
        JSON.stringify({
          ...detail,
          parserVersion: "eneco/v2",
          slug: "eneco",
          url,
        })
      ),
      "hash"
    );
    const result = await curateObservation(new InMemoryCurateStore(), {
      bronId: "00000000-0000-4000-8000-00000000001e",
      draft,
      observedAt: new Date("2026-09-16T20:14:00Z"),
      rawPayloadRef: "raw/eneco/stage",
      scrapeRunId: "run-eneco",
    });
    expect(result.status).toBe("curated");
    expect(draft.titel.value).toBe(
      "Meewerkstage DEI: Communicatie & Employee Networks"
    );
    expect(draft.opdrachtgeverNaam.value).toBe("Eneco");
    expect(draft.locatieTekst.value).toBe("Rotterdam");
  });
});
