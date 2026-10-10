import { describe, expect, it } from "bun:test";

import {
  curateObservation,
  InMemoryCurateStore,
} from "@ji/application/identity";
import {
  createJsonLdClient,
  rijkswaterstaatConfig,
} from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const url =
  "https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-assetmanagement-rivierbodem/1330716";
const client = createJsonLdClient({
  config: rijkswaterstaatConfig,
  liveEnabled: false,
});

describe("normalise and curate Rijkswaterstaat JSON-LD", () => {
  it("maps and curates the recorded direct-employer detail", async () => {
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected JobPosting JSON-LD");
    }
    const payload: JsonLdFetchedPayload = {
      jobPosting: detail.jobPosting,
      labelBlock: detail.labelBlock,
      parserVersion: "rijkswaterstaat/v2",
      slug: "rijkswaterstaat",
      url,
    };
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      "sha256-test"
    );
    expect(draft.titel.value).toBe("Adviseur assetmanagement rivierbodem");
    expect(draft.opdrachtgeverNaam.value).toBe("DG Rijkswaterstaat");
    expect(draft.locatieTekst.value).toBe("Roermond");
    expect(draft.bronSpecifiek.value).toMatchObject({
      identifier: { name: "Rijkswaterstaat", value: "1330716-NL-1160" },
      publicatiedatum: "2026-09-10T11:45:23Z",
    });
    expect(draft.sluitingsdatum).toBeUndefined();
    expect(draft.tarief).toEqual({
      eenheid: "maand",
      max: "6275",
      min: "4132",
      valuta: "EUR",
    });

    const store = new InMemoryCurateStore();
    const curated = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-00000000001b",
      draft,
      observedAt: new Date("2026-09-16T20:00:00Z"),
      rawPayloadRef: "raw/rijkswaterstaat/1330716.json",
      scrapeRunId: "run-rijkswaterstaat",
    });
    expect(curated.status).toBe("curated");
    expect(store.aanvragen[0]).toMatchObject({
      locatieTekst: "Roermond",
      opdrachtgeverNaam: "DG Rijkswaterstaat",
      titel: "Adviseur assetmanagement rivierbodem",
    });
  });
});
