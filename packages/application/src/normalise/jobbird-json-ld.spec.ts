import { describe, expect, it } from "bun:test";

import { createJsonLdClient, jobbirdConfig } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: jobbirdConfig,
  liveEnabled: false,
});

describe("normaliseJsonLdObservation -- Jobbird", () => {
  it("maps the first recorded detail", async () => {
    const url =
      "https://www.jobbird.com/nl/vacature/25796307-freelance-inkoper-sociaal-domein-zzp";
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected JobPosting JSON-LD");
    }
    const payload: JsonLdFetchedPayload = {
      jobPosting: detail.jobPosting,
      labelBlock: detail.labelBlock,
      parserVersion: "jobbird/v2",
      slug: "jobbird",
      url,
    };
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      "hash"
    );
    expect(draft.titel.value).toBe("Freelance Inkoper Sociaal Domein (ZZP)");
    expect(draft.opdrachtgeverNaam.value).toBe("Randstad Freelance");
    expect(draft.locatieTekst.value).toContain("OIRSCHOT");
  });
});

// Curate/DB is out of scope: it needs Postgres, which this lane does not start.
