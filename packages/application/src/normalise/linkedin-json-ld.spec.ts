import { describe, expect, it } from "bun:test";

import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";
import { createLinkedinClient } from "@ji/connectors/linkedin";
import { UNKNOWN } from "@ji/domain";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createLinkedinClient({ liveEnabled: false });

const SYNTHESIZED_URL =
  "https://nl.linkedin.com/jobs/view/freelance-ai-multimedia-designer-433-at-433-4419416701";
const JSONLD_URL =
  "https://nl.linkedin.com/jobs/view/software-engineering-expert-ai-training-%E2%82%AC65%E2%80%9390-h-at-huzzle-com-4456662010";

const normaliseDetail = async (url: string) => {
  const detail = await client.fetchDetail({
    bronReferentie: `jobs/view/${url.split("/jobs/view/")[1]}`,
    jobId: url.split("-").pop() ?? "",
    titel: "fixture",
    url,
  });
  if (!detail.jobPosting) {
    throw new Error("expected JobPosting data");
  }
  const payload: JsonLdFetchedPayload = {
    jobPosting: detail.jobPosting,
    labelBlock: detail.labelBlock,
    parserVersion: "linkedin/v1",
    slug: "linkedin",
    url,
  };
  return normaliseJsonLdObservation(
    new TextEncoder().encode(JSON.stringify(payload)),
    "hash"
  );
};

describe("normaliseJsonLdObservation -- LinkedIn", () => {
  it("maps the explicit JobPosting detail (ld+json served)", async () => {
    const draft = await normaliseDetail(JSONLD_URL);

    expect(draft.titel.value).toBe(
      "Software Engineering Expert (AI Training, €65–90/h)"
    );
    expect(draft.opdrachtgeverNaam.value).toBe("Huzzle.com");
    expect(draft.locatieTekst.value).toBe("Amsterdam");
    expect(draft.locatieLand.value).toBe("NL");
    expect(draft.bronReferentie.value).toBe(
      "jobs/view/software-engineering-expert-ai-training-€65–90-h-at-huzzle-com-4456662010"
    );
    expect(draft.bronUrl.value).toBe(JSONLD_URL);
    expect(draft.extractieMethode).toBe("jsonld");
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "CONTRACTOR",
      contracttype: "freelance",
      publicatiedatum: "2026-08-22T13:11:05.000Z",
      valid_through: "2027-02-18T13:11:05.000Z",
    });
    // LinkedIn's validThrough is a real published instant (platform expiry,
    // not a client deadline) and lands as the closing moment.
    expect(draft.sluitingsdatum).toBeInstanceOf(Date);
    // No label-block startDatum is published → honest UNKNOWN.
    expect(draft.startDatum.value).toBe(UNKNOWN);
  });

  it("maps the synthesised detail (no ld+json served) with the same shape", async () => {
    const draft = await normaliseDetail(SYNTHESIZED_URL);

    expect(draft.titel.value).toBe("Freelance AI Multimedia Designer - 433");
    expect(draft.opdrachtgeverNaam.value).toBe("433");
    expect(draft.locatieTekst.value).toBe("Nederland");
    expect(draft.bronReferentie.value).toBe(
      "jobs/view/freelance-ai-multimedia-designer-433-at-433-4419416701"
    );
    expect(draft.beschrijving.value.length).toBeGreaterThan(50);
    // Markup-only variant publishes no datePosted/validThrough → honest absence.
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "OTHER",
      label_block: { seniority_level: "Senior medewerker" },
      publicatiedatum: null,
      valid_through: null,
    });
    expect(draft.sluitingsdatum).toBeUndefined();
  });
});
