import { describe, expect, it } from "bun:test";

import { bamConfig, createJsonLdClient } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { curateObservation, InMemoryCurateStore } from "../identity";
import { normaliseJsonLdObservation } from "./json-ld";

const url =
  "https://www.bamcareers.com/nl/nl/job/26209/Medewerker-Verkeersmaatregelen";
const client = createJsonLdClient({ config: bamConfig, liveEnabled: false });

const normaliseFixture = async () => {
  const detail = await client.fetchDetail(url);
  if (!detail.jobPosting) {
    throw new Error("expected JobPosting JSON-LD");
  }
  const payload: JsonLdFetchedPayload = {
    jobPosting: detail.jobPosting,
    labelBlock: detail.labelBlock,
    parserVersion: bamConfig.parserVersion,
    slug: bamConfig.slug,
    url,
  };
  return normaliseJsonLdObservation(
    new TextEncoder().encode(JSON.stringify(payload)),
    "hash-bam"
  );
};

describe("normaliseJsonLdObservation -- BAM", () => {
  it("maps the recorded detail", async () => {
    const draft = await normaliseFixture();
    expect(draft.titel.value).toBe("Medewerker Verkeersmaatregelen");
    expect(draft.opdrachtgeverNaam.value).toBe("BAM Infra Wegen");
    expect(draft.locatieTekst.value).toBe("Nieuwleusen");
    expect(draft.bronSpecifiek.value).toMatchObject({
      publicatiedatum: "2026-06-22",
    });
  });

  it("curates the recorded detail", async () => {
    const store = new InMemoryCurateStore();
    const result = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-000000000015",
      draft: await normaliseFixture(),
      observedAt: new Date("2026-09-16T20:00:00Z"),
      rawPayloadRef: "raw/bam/26209.json",
      scrapeRunId: "run-bam",
    });
    expect(result.status).toBe("curated");
    expect(store.aanvragen[0]).toMatchObject({
      locatieTekst: "Nieuwleusen",
      opdrachtgeverNaam: "BAM Infra Wegen",
      titel: "Medewerker Verkeersmaatregelen",
    });
  });
});
