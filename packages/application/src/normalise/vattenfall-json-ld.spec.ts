import { describe, expect, it } from "bun:test";

import { createJsonLdClient, vattenfallConfig } from "@ji/connectors/json-ld";

import { curateObservation } from "../identity/curate";
import { InMemoryCurateStore } from "../identity/store";
import { normaliseJsonLdObservation } from "./json-ld";

const expected = [
  [
    "Analytics Engineer",
    "Amsterdam",
    "2026-09-14T07:03:00+00:00",
    "2126-09-14T07:03:00+00:00",
  ],
  [
    "Monteur Stadswarmte",
    "Arnhem",
    "2026-08-31T05:30:41+00:00",
    "2126-08-31T05:30:41+00:00",
  ],
  [
    "Service Technician - Onshore Wind Turbines",
    "Slootdorp",
    "2026-01-16T13:23:44+00:00",
    "2126-01-16T13:23:44+00:00",
  ],
] as const;

describe("normaliseJsonLdObservation -- Vattenfall", () => {
  it("normalises the recorded detail fixtures", async () => {
    const client = createJsonLdClient({
      config: vattenfallConfig,
      liveEnabled: false,
    });
    await Promise.all(
      expected.map(async ([title, location, datePosted, validThrough]) => {
        const url =
          Object.keys(vattenfallConfig.detailFixtures ?? {}).find((key) =>
            key.includes(title.toLowerCase().replaceAll(" ", "-"))
          ) ??
          Object.keys(vattenfallConfig.detailFixtures ?? {}).find((key) =>
            key.includes(location.toLowerCase())
          );
        if (!url) {
          throw new Error(`missing fixture for ${title}`);
        }
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: vattenfallConfig.parserVersion,
              slug: vattenfallConfig.slug,
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.opdrachtgeverNaam.value).toBe("Vattenfall");
        expect(draft.locatieTekst.value).toBe(location);
        expect(draft.bronSpecifiek).toMatchObject({
          value: { publicatiedatum: datePosted, valid_through: validThrough },
        });
      })
    );
  });

  it("curates a normalised Vattenfall observation end to end", async () => {
    const client = createJsonLdClient({
      config: vattenfallConfig,
      liveEnabled: false,
    });
    const url = Object.keys(vattenfallConfig.detailFixtures ?? {}).find((key) =>
      key.includes("analytics-engineer")
    );
    if (!url) {
      throw new Error("missing analytics-engineer fixture");
    }
    const detail = await client.fetchDetail(url);
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(
        JSON.stringify({
          ...detail,
          parserVersion: vattenfallConfig.parserVersion,
          slug: vattenfallConfig.slug,
          url,
        })
      ),
      "hash"
    );
    const result = await curateObservation(new InMemoryCurateStore(), {
      bronId: "00000000-0000-4000-8000-00000000001d",
      draft,
      observedAt: new Date("2026-09-16T20:14:00Z"),
      rawPayloadRef: "raw/vattenfall/analytics",
      scrapeRunId: "run-vattenfall",
    });
    expect(result.status).toBe("curated");
    expect(draft.titel.value).toBe("Analytics Engineer");
    expect(draft.opdrachtgeverNaam.value).toBe("Vattenfall");
    expect(draft.locatieTekst.value).toBe("Amsterdam");
  });
});
