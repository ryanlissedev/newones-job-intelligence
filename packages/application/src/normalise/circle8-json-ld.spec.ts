import { describe, expect, it } from "bun:test";

import { circle8Config, createJsonLdClient } from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "./json-ld";

const url = "https://werkenbij.circle8.nl/jobs/8338072-it-recruiter";
const client = createJsonLdClient({
  config: circle8Config,
  liveEnabled: false,
});

describe("normalise Circle8 JSON-LD", () => {
  it("maps the recorded IT Recruiter detail", async () => {
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected JobPosting JSON-LD");
    }
    const payload: JsonLdFetchedPayload = {
      contactpersonen: detail.contactpersonen,
      jobPosting: detail.jobPosting,
      labelBlock: detail.labelBlock,
      parserVersion: "circle8/v2",
      slug: "circle8",
      url,
    };
    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      "sha256-test"
    );
    expect(draft.titel.value).toBe("IT Recruiter");
    expect(draft.opdrachtgeverNaam.value).toBe("Circle8");
    // jobLocation.addressLocality wins over the vaguer "Locaties: Circle8
    // Nederland" <dl> label, which is deliberately not canonical `locatie`.
    expect(draft.locatieTekst.value).toBe("Nieuwegein");
    // A monthly salaris band lands as per-maand, never a bare-euro uurtarief.
    expect(draft.tarief).toEqual({
      eenheid: "maand",
      max: "4500",
      min: "3656",
      valuta: "EUR",
    });
    // The source publishes no start/eind/sluitings dates — UNKNOWN, not
    // inferred from datePosted (which is a publish date, not a start date).
    expect(draft.startDatum.value).toBe("unknown");
    expect(draft.sluitingsdatum).toBeUndefined();
    expect(draft.contactpersonen?.value).toMatchObject([
      {
        naam: "Monique Manger",
        rol: "Corporate Recruiter – HR",
        telefoon: "+31000000000",
      },
    ]);
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "FULL_TIME",
      identifier: { value: "8338072" },
      label_block: {
        afdeling: "Recruitment",
        locaties: "Circle8 Nederland",
        rol: "Recruiter",
        statusWerkenOpAfstand: "Hybride",
      },
      publicatiedatum: "2026-09-08T09:53:59+02:00",
      // "Je werkt tussen de 32 en 40 uur per week" — the Dutch en/tot
      // connector lands the band, not its upper bound alone.
      uren_per_week: "32–40",
    });
  });
});
