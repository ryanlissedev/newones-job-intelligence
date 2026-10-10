import { describe, expect, it } from "bun:test";

import {
  curateObservation,
  InMemoryCurateStore,
} from "@ji/application/identity";
import { createJsonLdClient, randstadConfig } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const url = "https://www.randstad.nl/vacatures/752363/teamleider";
const client = createJsonLdClient({
  config: randstadConfig,
  liveEnabled: false,
});

describe("normalise and curate Randstad JSON-LD", () => {
  it("maps and curates the recorded Teamleider detail", async () => {
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected JobPosting JSON-LD");
    }
    const payload: JsonLdFetchedPayload = {
      jobPosting: detail.jobPosting,
      labelBlock: detail.labelBlock,
      parserVersion: "randstad/v2",
      slug: "randstad",
      url,
    };
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      "sha256-test"
    );
    expect(draft.titel.value).toBe("Teamleider");
    expect(draft.opdrachtgeverNaam.value).toBe("Randstad");
    expect(draft.locatieTekst.value).toBe("Venlo");
    expect(draft.bronSpecifiek.value).toMatchObject({
      identifier: { value: "752363" },
      publicatiedatum: "2026-09-16",
      valid_through: "2026-10-23",
    });
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2026-10-23T21:59:59.999Z"
    );
    expect(draft.tarief).toEqual({
      eenheid: "maand",
      max: "3100",
      min: "2700",
      valuta: "EUR",
    });

    const store = new InMemoryCurateStore();
    const curated = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-000000000019",
      draft,
      observedAt: new Date("2026-09-16T20:00:00Z"),
      rawPayloadRef: "raw/randstad/752363.json",
      scrapeRunId: "run-randstad",
    });
    expect(curated.status).toBe("curated");
    expect(store.aanvragen[0]).toMatchObject({
      locatieTekst: "Venlo",
      opdrachtgeverNaam: "Randstad",
      titel: "Teamleider",
    });
  });
});
