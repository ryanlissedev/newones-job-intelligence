import { describe, expect, it } from "bun:test";

import { createJsonLdClient, intermediairConfig } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: intermediairConfig,
  liveEnabled: false,
});

const normaliseFixture = async (url: string) => {
  const detail = await client.fetchDetail(url);
  return normaliseJsonLdObservation(
    new TextEncoder().encode(
      JSON.stringify({
        ...detail,
        parserVersion: intermediairConfig.parserVersion,
        slug: intermediairConfig.slug,
        url,
      })
    ),
    "hash-intermediair"
  );
};

describe("normaliseJsonLdObservation -- Intermediair", () => {
  it("normalises the recorded detail fixtures", async () => {
    const asfaltuitvoerder = await normaliseFixture(
      "https://www.intermediair.nl/vacature/0cad6431-f0e1-4d5a-9872-d4cba5ef0225/asfaltuitvoerder"
    );
    expect(asfaltuitvoerder.titel.value).toBe("Asfaltuitvoerder");
    expect(asfaltuitvoerder.opdrachtgeverNaam.value).toBe("BAM");
    expect(asfaltuitvoerder.locatieTekst.value).toBe("Nieuwleusen");

    const klantmanager = await normaliseFixture(
      "https://www.intermediair.nl/vacature/7fd25dd1-894d-4844-acf7-b5b672a10afc/klantmanager-werk-en-inkomen"
    );
    expect(klantmanager.titel.value).toBe("Klantmanager Werk en Inkomen");
    expect(klantmanager.opdrachtgeverNaam.value).toBe("Matchpartner");
    expect(klantmanager.locatieTekst.value).toBe("Bergen op Zoom");
  });
});
