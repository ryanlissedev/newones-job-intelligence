import { describe, expect, it } from "bun:test";

import { createJsonLdClient, nsConfig } from "@ji/connectors/json-ld";

import { curateObservation } from "../identity/curate";
import { InMemoryCurateStore } from "../identity/store";
import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://www.werkenbijns.nl/vacatures/conducteur-zwolle-zwolle-1331708",
    "Conducteur Zwolle",
    "Zwolle",
    null,
  ],
  [
    "https://www.werkenbijns.nl/vacatures/it-lead-ns-stations-utrecht-1316973",
    "IT Lead - NS Stations",
    "Utrecht",
    "2026-09-27T00:00:00Z",
  ],
  [
    "https://www.werkenbijns.nl/vacatures/sap-run-manager-utrecht-utrecht-1320979",
    "SAP RUN manager - Utrecht",
    "Utrecht",
    "2026-10-28T00:00:00Z",
  ],
] as const;

describe("normaliseJsonLdObservation -- NS", () => {
  it("normalises each recorded detail", async () => {
    const client = createJsonLdClient({ config: nsConfig, liveEnabled: false });
    await Promise.all(
      cases.map(async ([url, title, location, validThrough]) => {
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: "ns/v2",
              slug: "ns",
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.opdrachtgeverNaam.value).toBe("NS");
        expect(draft.locatieTekst.value).toBe(location);
        expect(draft.bronSpecifiek).toMatchObject({
          value: { valid_through: validThrough },
        });
      })
    );
  });

  it("curates a normalised NS observation end to end", async () => {
    const client = createJsonLdClient({ config: nsConfig, liveEnabled: false });
    const url =
      "https://www.werkenbijns.nl/vacatures/conducteur-zwolle-zwolle-1331708";
    const detail = await client.fetchDetail(url);
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(
        JSON.stringify({
          ...detail,
          parserVersion: "ns/v2",
          slug: "ns",
          url,
        })
      ),
      "hash"
    );
    const result = await curateObservation(new InMemoryCurateStore(), {
      bronId: "00000000-0000-4000-8000-000000000021",
      draft,
      observedAt: new Date("2026-09-16T20:14:00Z"),
      rawPayloadRef: "raw/ns/conducteur",
      scrapeRunId: "run-ns",
    });
    expect(result.status).toBe("curated");
    expect(draft.titel.value).toBe("Conducteur Zwolle");
    expect(draft.opdrachtgeverNaam.value).toBe("NS");
    expect(draft.locatieTekst.value).toBe("Zwolle");
  });
});
