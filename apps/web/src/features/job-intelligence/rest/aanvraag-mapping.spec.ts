import { describe, expect, it } from "bun:test";

import { mapAanvraagToJobListing } from "./aanvraag-mapping";
import { buildBronCatalog } from "./bron-catalog";

const bronCatalog = buildBronCatalog([
  { bronId: "00000000-0000-4000-8000-000000000001", naam: "TenderNed" },
]);

const baseAanvraag = (
  overrides: Partial<Parameters<typeof mapAanvraagToJobListing>[0]["aanvraag"]>
) => ({
  beschrijving: "beschrijving",
  bronId: "00000000-0000-4000-8000-000000000001",
  bronReferentie: "TN-1",
  id: "00000000-0000-4000-8000-000000000010",
  rawPayloadRef: "raw/tn-1.json",
  scrapeRunId: "00000000-0000-4000-8000-000000000020",
  status: "active",
  titel: "Java developer",
  ...overrides,
});

describe("mapAanvraagToJobListing country (CTP-514/CTP-523)", () => {
  it("maps locatieLand NL to country NL", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: baseAanvraag({ locatieLand: "NL" }),
      bronCatalog,
      versies: [],
    });
    expect(job.country).toBe("NL");
  });

  it("maps a non-NL locatieLand to null (never invents NL)", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: baseAanvraag({ locatieLand: "BE" }),
      bronCatalog,
      versies: [],
    });
    expect(job.country).toBeNull();
  });

  it("maps an absent locatieLand to null", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: baseAanvraag({ locatieLand: null }),
      bronCatalog,
      versies: [],
    });
    expect(job.country).toBeNull();
  });
});

describe("mapAanvraagToJobListing duration/duur (CTP-514/CTP-519)", () => {
  it("maps a published duur to duration", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: baseAanvraag({ duur: "4 maanden" }),
      bronCatalog,
      versies: [],
    });
    expect(job.duration).toBe("4 maanden");
  });

  it("maps an absent duur to null", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: baseAanvraag({ duur: null }),
      bronCatalog,
      versies: [],
    });
    expect(job.duration).toBeNull();
  });
});
