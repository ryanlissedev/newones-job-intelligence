import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { unicaConfig } from "./configs/unica";

describe("Unica JSON-LD connector", () => {
  it("discovers exactly the 558 job-shaped sitemap URLs", async () => {
    const urls = await createJsonLdClient({
      config: unicaConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(558);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/www\.werkenbijunica\.nl\/vacatures\/[^/]+-[a-z0-9-]+$/u.test(
          url
        )
      )
    ).toBe(true);
    expect(urls.some(({ url }) => url.endsWith("/vacatures/favorieten"))).toBe(
      false
    );
  });

  it("parses each recorded detail fixture's raw JobPosting node", async () => {
    const client = createJsonLdClient({
      config: unicaConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://www.werkenbijunica.nl/vacatures/werkvoorbereider-warmtenetten-oosterhout-aqlgyyae65n4goyv",
        "Werkvoorbereider Warmtenetten",
        "Unica Building Services Oosterhout",
        "Oosterhout",
        "North Brabant",
      ],
      [
        "https://www.werkenbijunica.nl/vacatures/technisch-administratief-medewerker-oosterhout-aqk-1g-tfhzmqqg",
        "Technisch Administratief Medewerker",
        "Unica Building Services Oosterhout",
        "Oosterhout",
        "North Brabant",
      ],
      [
        "https://www.werkenbijunica.nl/vacatures/accountmanager-venray-aqkcmj2yd4e-nszi",
        "Accountmanager",
        "Brainpact",
        "Venray",
        "Limburg",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, org, locality, region]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          directApply: true,
          hiringOrganization: { name: org },
          jobLocation: {
            address: {
              addressCountry: "NL",
              addressLocality: locality,
              addressRegion: region,
            },
          },
          title,
        });
      })
    );
  });
});
