import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  planetInterimConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: planetInterimConfig,
  liveEnabled: false,
});

const normaliseFixture = async (url: string) => {
  const detail = await client.fetchDetail(url);
  return normaliseJsonLdObservation(
    new TextEncoder().encode(
      JSON.stringify({
        ...detail,
        parserVersion: planetInterimConfig.parserVersion,
        slug: planetInterimConfig.slug,
        url,
      })
    ),
    "hash-planet-interim"
  );
};

describe("normaliseJsonLdObservation -- Planet Interim", () => {
  it("normalises the recorded detail fixtures", async () => {
    const beleidsadviseur = await normaliseFixture(
      "https://planetinterim.nl/beleidsadviseur-informatisering-ciso-bu/538233/p13/default.html"
    );
    expect(beleidsadviseur.titel.value).toBe(
      "Beleidsadviseur Informatisering / CISO – Bunschoten & Putten"
    );
    expect(beleidsadviseur.opdrachtgeverNaam.value).toBe("Planet Interim");
    expect(beleidsadviseur.locatieTekst.value).toBe("Bunschoten-Spakenburg");

    const informatiemanager = await normaliseFixture(
      "https://planetinterim.nl/informatiemanager-crisisbeheersing/538704/p13/default.html"
    );
    expect(informatiemanager.titel.value).toBe(
      "Informatiemanager Crisisbeheersing"
    );
    expect(informatiemanager.opdrachtgeverNaam.value).toBe("Planet Interim");
    expect(informatiemanager.locatieTekst.value).toBe("Arnhem");
  });
});
