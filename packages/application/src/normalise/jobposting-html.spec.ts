import { describe, expect, it } from "bun:test";

import { extractJobPostingCommercialFacts } from "./jobposting-html";

const NVB_HTML = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"JobPosting","baseSalary":{"@type":"MonetaryAmount","currency":"EUR","value":{"@type":"QuantitativeValue","maxValue":6500,"minValue":3150,"unitText":"MONTH"}},"datePosted":"2026-08-10T22:00:00Z","workHours":"24 uur per week","description":"Opleidingsniveau: MBO<br>Uren: 24 uur per week"}
</script>
</head><body></body></html>`;

describe("extractJobPostingCommercialFacts", () => {
  it("reads monthly salaris, hours, education chip, and datePosted", () => {
    expect(extractJobPostingCommercialFacts(NVB_HTML)).toMatchObject({
      educationLevel: "MBO",
      publicatiedatum: "2026-08-10T22:00:00Z",
      tarief: {
        eenheid: "maand",
        max: "6500",
        min: "3150",
        valuta: "EUR",
      },
      urenPerWeek: "24 uur per week",
    });
  });

  it("returns nulls when JSON-LD is absent", () => {
    expect(extractJobPostingCommercialFacts("<html></html>")).toEqual({
      educationLevel: null,
      publicatiedatum: null,
      tarief: null,
      urenPerWeek: null,
    });
  });
});
