import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { enexisConfig } from "./configs/enexis";

describe("Enexis JSON-LD connector", () => {
  it("discovers exactly the 170 job-shaped sitemap URLs", async () => {
    const urls = await createJsonLdClient({
      config: enexisConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(170);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/werkenbij\.enexis\.nl\/vacatures\/[^/]+-\d+$/u.test(url)
      )
    ).toBe(true);
  });

  it("parses each recorded detail fixture's raw JobPosting node", async () => {
    const client = createJsonLdClient({
      config: enexisConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://werkenbij.enexis.nl/vacatures/applicatie-engineer-13841",
        "Applicatie engineer",
        "Zwolle",
        "2026-06-29T19:08:50.000Z",
        4223,
        6033,
      ],
      [
        "https://werkenbij.enexis.nl/vacatures/junior-monteur-hoogspanning-13619",
        "Junior monteur hoogspanning",
        "Groningen",
        "2026-08-18T07:03:26.000Z",
        2864,
        4092,
      ],
      [
        "https://werkenbij.enexis.nl/vacatures/senior-projectmanager-13320",
        "Senior projectmanager",
        "Den Bosch",
        "2026-09-02T13:28:28.000Z",
        4953,
        7076,
      ],
    ] as const;
    await Promise.all(
      cases.map(
        async ([
          url,
          title,
          addressLocality,
          datePosted,
          minValue,
          maxValue,
        ]) => {
          const detail = await client.fetchDetail(url);
          expect(detail.jobPosting).toMatchObject({
            baseSalary: {
              currency: "EUR",
              value: { maxValue, minValue, unitText: "MONTH" },
            },
            datePosted,
            hiringOrganization: { name: "Enexis Netbeheer B.V." },
            jobLocation: { address: { addressCountry: "NL", addressLocality } },
            title,
            url: "",
          });
        }
      )
    );
  });
});
