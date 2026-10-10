import { describe, expect, it } from "bun:test";

import { createJsonLdClient, haertConfig } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: haertConfig,
  liveEnabled: false,
});

const normaliseFixture = async (url: string) => {
  const detail = await client.fetchDetail(url);
  return normaliseJsonLdObservation(
    new TextEncoder().encode(
      JSON.stringify({
        ...detail,
        parserVersion: haertConfig.parserVersion,
        slug: haertConfig.slug,
        url,
      })
    ),
    "hash-haert"
  );
};

describe("normaliseJsonLdObservation -- Haert", () => {
  it("normalises the recorded detail fixtures", async () => {
    const zwemonderwijzer = await normaliseFixture(
      "https://www.haert.nl/opdrachten/zwemonderwijzer-13184"
    );
    expect(zwemonderwijzer.titel.value).toBe("Zwemonderwijzer");
    expect(zwemonderwijzer.opdrachtgeverNaam.value).toBe("Haert");
    expect(zwemonderwijzer.locatieTekst.value).toBe("Voorne aan Zee");
    expect(zwemonderwijzer.tarief).toMatchObject({
      eenheid: "uur",
      max: "55",
      valuta: "EUR",
    });
    expect(zwemonderwijzer.bronSpecifiek.value).toMatchObject({
      contract_type: "CONTRACTOR",
      identifier: "13184",
      publicatiedatum: "2026-09-17",
      valid_through: "2026-09-30",
    });

    const hrAdviseur = await normaliseFixture(
      "https://www.haert.nl/opdrachten/hr-adviseur-39565"
    );
    expect(hrAdviseur.titel.value).toBe("HR adviseur");
    expect(hrAdviseur.opdrachtgeverNaam.value).toBe("Haert");
    expect(hrAdviseur.locatieTekst.value).toBe("Hoofddorp");
    expect(hrAdviseur.tarief).toMatchObject({
      eenheid: "uur",
      max: "88",
      valuta: "EUR",
    });
  });
});
