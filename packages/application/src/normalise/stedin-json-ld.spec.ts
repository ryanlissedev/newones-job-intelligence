import { describe, expect, it } from "bun:test";

import { createJsonLdClient, stedinConfig } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: stedinConfig,
  liveEnabled: false,
});

const normaliseFixture = async (url: string) => {
  const detail = await client.fetchDetail(url);
  return normaliseJsonLdObservation(
    new TextEncoder().encode(
      JSON.stringify({
        ...detail,
        parserVersion: stedinConfig.parserVersion,
        slug: stedinConfig.slug,
        url,
      })
    ),
    "hash-stedin"
  );
};

describe("normaliseJsonLdObservation -- Stedin", () => {
  it("normalises the recorded detail fixtures", async () => {
    const amstelveen = await normaliseFixture(
      "https://werkenbij.stedin.net/banen/amstelveen/monteur-gas/3297/35532249792"
    );
    expect(amstelveen.titel.value).toBe("Monteur Gas");
    expect(amstelveen.opdrachtgeverNaam.value).toBe("Stedin");
    expect(amstelveen.locatieTekst.value).toBe("Amstelveen");

    const delft = await normaliseFixture(
      "https://werkenbij.stedin.net/banen/delft/devops-engineer/3297/43419274752"
    );
    expect(delft.titel.value).toBe("DevOps Engineer");
    expect(delft.opdrachtgeverNaam.value).toBe("Stedin");
    expect(delft.locatieTekst.value).toBe("Delft");
  });
});
