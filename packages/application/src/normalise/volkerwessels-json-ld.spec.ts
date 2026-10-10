import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  volkerwesselsConfig,
} from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";
import { UNKNOWN } from "@ji/domain";

import { curateObservation, InMemoryCurateStore } from "../identity";
import { normaliseJsonLdObservation } from "./json-ld";

const url =
  "https://www.werkenbijvolkerwessels.nl/vacature/3353/projectontwikkelaar-1";
const client = createJsonLdClient({
  config: volkerwesselsConfig,
  liveEnabled: false,
});

const normaliseFixture = async () => {
  const detail = await client.fetchDetail(url);
  if (!detail.jobPosting) {
    throw new Error("expected JobPosting JSON-LD");
  }
  const payload: JsonLdFetchedPayload = {
    jobPosting: detail.jobPosting,
    labelBlock: detail.labelBlock,
    parserVersion: volkerwesselsConfig.parserVersion,
    slug: volkerwesselsConfig.slug,
    url,
  };
  return normaliseJsonLdObservation(
    new TextEncoder().encode(JSON.stringify(payload)),
    "hash-volkerwessels"
  );
};

describe("normaliseJsonLdObservation -- VolkerWessels", () => {
  it("maps the recorded detail", async () => {
    const draft = await normaliseFixture();
    expect(draft.titel.value).toBe("Projectontwikkelaar");
    expect(draft.opdrachtgeverNaam.value).toBe("Aannemersbedrijf Van Agtmaal");
    expect(draft.locatieTekst.value).toBe("Oudenbosch");
    expect(draft.bronSpecifiek.value).toMatchObject({
      publicatiedatum: "2025-09-25T11:19:41+02:00",
    });
    expect(draft.tarief.min).toBe(UNKNOWN);
  });

  it("curates the recorded detail", async () => {
    const store = new InMemoryCurateStore();
    const result = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-000000000014",
      draft: await normaliseFixture(),
      observedAt: new Date("2026-09-16T20:00:00Z"),
      rawPayloadRef: "raw/volkerwessels/3353.json",
      scrapeRunId: "run-volkerwessels",
    });
    expect(result.status).toBe("curated");
    expect(store.aanvragen[0]).toMatchObject({
      locatieTekst: "Oudenbosch",
      opdrachtgeverNaam: "Aannemersbedrijf Van Agtmaal",
      titel: "Projectontwikkelaar",
    });
  });
});
