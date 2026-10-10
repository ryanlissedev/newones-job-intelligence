import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  zzpOpdrachtenConfig,
} from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: zzpOpdrachtenConfig,
  liveEnabled: false,
});

describe("normaliseJsonLdObservation -- ZZP-Opdrachten", () => {
  it("maps the first recorded detail", async () => {
    const url =
      "https://www.zzp-opdrachten.nl/vacatures/vacature-jurist-707983/";
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected JobPosting JSON-LD");
    }
    const payload: JsonLdFetchedPayload = {
      jobPosting: detail.jobPosting,
      labelBlock: detail.labelBlock,
      parserVersion: "zzp-opdrachten/v2",
      slug: "zzp-opdrachten",
      url,
    };
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      "hash"
    );
    expect(draft.titel.value).toBe("Jurist");
    expect(draft.opdrachtgeverNaam.value).toBe("ZZP Opdrachten");
    expect(draft.locatieTekst.value).toContain("Maarssen");
  });
});

// Curate/DB is out of scope: it needs Postgres, which this lane does not start.
