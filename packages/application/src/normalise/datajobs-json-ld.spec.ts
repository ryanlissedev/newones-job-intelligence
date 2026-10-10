import { describe, expect, it } from "bun:test";

import { createJsonLdClient, datajobsConfig } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: datajobsConfig,
  liveEnabled: false,
});

describe("normaliseJsonLdObservation -- DataJobs", () => {
  it("maps the first recorded detail", async () => {
    const url = "https://www.datajobs.nl/vacatures/aiml-engineer-bij-ilionx";
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected JobPosting JSON-LD");
    }
    const payload: JsonLdFetchedPayload = {
      jobPosting: detail.jobPosting,
      labelBlock: detail.labelBlock,
      parserVersion: "datajobs/v2",
      slug: "datajobs",
      url,
    };
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      "hash"
    );
    expect(draft.titel.value).toBe("AI/ML Engineer");
    expect(draft.opdrachtgeverNaam.value).toBe("ilionx");
    expect(draft.locatieTekst.value).toContain("Groningen");
  });
});

// Curate/DB is out of scope: it needs Postgres, which this lane does not start.
