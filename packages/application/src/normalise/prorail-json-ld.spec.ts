import { describe, expect, it } from "bun:test";

import { createJsonLdClient, prorailConfig } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { curateObservation, InMemoryCurateStore } from "../identity";
import { normaliseJsonLdObservation } from "./json-ld";

const url =
  "https://www.werkenbijprorail.nl/vacatures/functie/medior-data-engineer";
const client = createJsonLdClient({
  config: prorailConfig,
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
    parserVersion: prorailConfig.parserVersion,
    slug: prorailConfig.slug,
    url,
  };
  return normaliseJsonLdObservation(
    new TextEncoder().encode(JSON.stringify(payload)),
    "hash-prorail"
  );
};

describe("normaliseJsonLdObservation -- ProRail", () => {
  it("maps the recorded detail", async () => {
    const draft = await normaliseFixture();
    expect(draft.titel.value).toBe("Medior data engineer");
    expect(draft.opdrachtgeverNaam.value).toBe("ProRail");
    expect(draft.locatieTekst.value).toBe("Utrecht");
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "Full-time",
      publicatiedatum: "2026-06-05",
    });
  });

  it("curates the recorded detail", async () => {
    const store = new InMemoryCurateStore();
    const result = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-000000000031",
      draft: await normaliseFixture(),
      observedAt: new Date("2026-09-17T18:00:00Z"),
      rawPayloadRef: "raw/prorail/medior-data-engineer.json",
      scrapeRunId: "run-prorail",
    });
    expect(result.status).toBe("curated");
    expect(store.aanvragen[0]).toMatchObject({
      locatieTekst: "Utrecht",
      opdrachtgeverNaam: "ProRail",
      titel: "Medior data engineer",
    });
  });
});
