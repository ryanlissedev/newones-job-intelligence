import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { essentConfig } from "./configs/essent";
import { synthesizeJobPostingFromEssentFeatures } from "./extract";

describe("Essent JSON-LD connector (Vue DataItems synthesis)", () => {
  it("discovers only the two-segment /nl/vacatures/<vakgebied>/<slug> URLs", async () => {
    const urls = await createJsonLdClient({
      config: essentConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(5);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/www\.werkenbijessent\.nl\/nl\/vacatures\/[^/]+\/[^/]+$/u.test(
          url
        )
      )
    ).toBe(true);
  });

  it("synthesises a JobPosting from each detail's DataItems payload", async () => {
    const client = createJsonLdClient({
      config: essentConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://www.werkenbijessent.nl/nl/vacatures/engineering/project-manager-warmtenetten",
        "Project Manager Warmtenetten",
        "Utrecht  / 's-Hertogenbosch",
        "€6523 - €8253",
        "36 - 40 uur",
        "2026-09-01T00:00:00.0000000",
      ],
      [
        "https://www.werkenbijessent.nl/nl/vacatures/customer-services/klantadviseur",
        "Klantadviseur Slim Energiegebruik",
        "'s-Hertogenbosch",
        "€2743 - €2881",
        "32 - 40 uur",
        "2026-06-25T00:00:00.0000000",
      ],
      [
        "https://www.werkenbijessent.nl/nl/vacatures/vacatures/financial-controller",
        "Financial Controller",
        "Amsterdam",
        "€3800 - €4500",
        "40 uur",
        "2026-09-03T00:00:00.0000000",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, location, salaris, uren, published]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          "@type": "JobPosting",
          hiringOrganization: { name: "Essent" },
          jobLocation: {
            address: { addressCountry: "NL", addressLocality: location },
          },
          title,
          url,
        });
        if (published) {
          expect(detail.jobPosting?.datePosted).toBe(published);
        }
        expect(detail.jobPosting?.description).toBeTruthy();
        // The salary item is a monthly range for a vaste functie: it lands in
        // the label block only, never baseSalary/tarief.
        expect(detail.labelBlock.salaris).toBe(salaris);
        expect(detail.labelBlock.urenPerWeek).toBe(uren);
        expect(detail.labelBlock.locatie).toBe(location);
        expect(detail.jobPosting?.baseSalary).toBeUndefined();
      })
    );
  });

  it("keeps DataItems entries whose Value text or nesting contains brackets", () => {
    // A `]` inside a Value string (or a nested array) truncated the old lazy
    // `\[.*?\]` regex at the first bracket, silently dropping the item list.
    const items = JSON.stringify([
      { CssClass: "location", Value: "Rotterdam [regio zuid]" },
      { CssClass: "salary", Value: "€3000 - €4000" },
      { CssClass: "field", Extra: [1, 2], Value: "IT" },
    ]);
    const decoded = `window.__vue = { DataItems: ${items} };`;
    const html =
      `<h1>Spec Vacature</h1>` +
      `<div class="content"><p>Spec body</p></div>` +
      `<script src="data:text/javascript;base64,${Buffer.from(decoded).toString(
        "base64"
      )}"></script>`;
    const detail = synthesizeJobPostingFromEssentFeatures(
      html,
      "https://www.werkenbijessent.nl/nl/vacatures/spec/spec-vacature"
    );
    expect(detail?.labelBlock.locatie).toBe("Rotterdam [regio zuid]");
    expect(detail?.labelBlock.salaris).toBe("€3000 - €4000");
    expect(detail?.labelBlock.vakgebied).toBe("IT");
    expect(detail?.jobPosting?.title).toBe("Spec Vacature");
  });
});
