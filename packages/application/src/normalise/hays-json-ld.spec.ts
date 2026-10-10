import { describe, expect, it } from "bun:test";

import {
  curateObservation,
  InMemoryCurateStore,
} from "@ji/application/identity";
import { createJsonLdClient, haysConfig } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const url =
  "https://www.hays.nl/vacature-details/scrum-master-provincie-utrecht_1049921?q=&location=&applyId=JOB_5377570&jobSource=HaysGCJ&isSponsored=N&specialismId=&subSpecialismId=&jobName=projects/mineral-balm-174308/tenants/ab5d683d-f9a5-4b85-bfe0-eb74881e24cf/jobs/103039416380859078&lang=nl";
const client = createJsonLdClient({ config: haysConfig, liveEnabled: false });

describe("normalise and curate Hays JSON-LD", () => {
  it("maps and curates the recorded Scrum Master detail", async () => {
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected JobPosting JSON-LD");
    }
    const payload: JsonLdFetchedPayload = {
      jobPosting: detail.jobPosting,
      labelBlock: detail.labelBlock,
      parserVersion: "hays/v2",
      slug: "hays",
      url,
    };
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      "sha256-test"
    );
    expect(draft.titel.value).toBe("Scrum Master");
    expect(draft.opdrachtgeverNaam.value).toBe("Hays");
    expect(draft.locatieTekst.value).toBe("Provincie Utrecht");
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "Contracting",
      publicatiedatum: "2026-09-09",
      valid_through: "2026-12-07",
    });
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2026-12-07T22:59:59.999Z"
    );
    expect(draft.tarief).toEqual({
      eenheid: "unknown",
      max: "unknown",
      min: "unknown",
      valuta: "EUR",
    });

    const store = new InMemoryCurateStore();
    const curated = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-00000000001a",
      draft,
      observedAt: new Date("2026-09-16T20:00:00Z"),
      rawPayloadRef: "raw/hays/1049921.json",
      scrapeRunId: "run-hays",
    });
    expect(curated.status).toBe("curated");
    expect(store.aanvragen[0]).toMatchObject({
      locatieTekst: "Provincie Utrecht",
      opdrachtgeverNaam: "Hays",
      titel: "Scrum Master",
    });
  });
});
