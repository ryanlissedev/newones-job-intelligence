import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { jobbirdConfig } from "./configs/jobbird";

const client = createJsonLdClient({
  config: jobbirdConfig,
  liveEnabled: false,
});
const details = [
  [
    "https://www.jobbird.com/nl/vacature/25796307-freelance-inkoper-sociaal-domein-zzp",
    "Freelance Inkoper Sociaal Domein (ZZP)",
    "OIRSCHOT",
    "Oirschot",
    "25796307",
  ],
  [
    "https://www.jobbird.com/nl/vacature/25849909-freelance-business-controller-zzp",
    "Freelance Business Controller (ZZP)",
    "LEEUWARDEN",
    "Gemeente Leeuwarden",
    "25849909",
  ],
  [
    "https://www.jobbird.com/nl/vacature/25852520-freelance-adviseur-kcc-zzp",
    "Freelance Adviseur KCC (ZZP)",
    "LISSE",
    "Lisse",
    "25852520",
  ],
] as const;

describe("Jobbird freelance JSON-LD connector", () => {
  it("discovers exactly the 15 page-one freelance links", async () => {
    const urls = await client.fetchListing();
    expect(urls).toHaveLength(15);
    for (const [url] of details) {
      expect(urls.some((entry) => entry.url === url)).toBe(true);
    }
  });

  it("parses the three published JobPosting records", async () => {
    await Promise.all(
      details.map(async ([url, title, locality, region, identifier]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          employmentType: ["PART_TIME"],
          hiringOrganization: { name: "Randstad Freelance" },
          identifier: { value: identifier },
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
