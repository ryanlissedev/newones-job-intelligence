import { describe, expect, it } from "bun:test";

import { createJsonLdClient, heijmansConfig } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { curateObservation, InMemoryCurateStore } from "../identity";
import { normaliseJsonLdObservation } from "./json-ld";

const url =
  "https://www.werkenbijheijmans.nl/vacatures/maintenance-engineer-drachten-v-014747";
const client = createJsonLdClient({
  config: heijmansConfig,
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
    parserVersion: heijmansConfig.parserVersion,
    slug: heijmansConfig.slug,
    url,
  };
  return normaliseJsonLdObservation(
    new TextEncoder().encode(JSON.stringify(payload)),
    "hash-heijmans"
  );
};

describe("normaliseJsonLdObservation -- Heijmans", () => {
  it("maps the recorded detail", async () => {
    const draft = await normaliseFixture();
    expect(draft.titel.value).toBe("Maintenance engineer");
    expect(draft.opdrachtgeverNaam.value).toBe("Heijmans");
    expect(draft.locatieTekst.value).toBe("Drachten");
    expect(draft.bronSpecifiek.value).toMatchObject({
      publicatiedatum: "2026-06-03T13:50:10.413891Z",
    });
  });

  it("curates the recorded detail", async () => {
    const store = new InMemoryCurateStore();
    const result = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-000000000016",
      draft: await normaliseFixture(),
      observedAt: new Date("2026-09-16T20:00:00Z"),
      rawPayloadRef: "raw/heijmans/014747.json",
      scrapeRunId: "run-heijmans",
    });
    expect(result.status).toBe("curated");
    expect(store.aanvragen[0]).toMatchObject({
      locatieTekst: "Drachten",
      opdrachtgeverNaam: "Heijmans",
      titel: "Maintenance engineer",
    });
  });
});
