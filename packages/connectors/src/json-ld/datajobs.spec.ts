import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { datajobsConfig } from "./configs/datajobs";

const client = createJsonLdClient({
  config: datajobsConfig,
  liveEnabled: false,
});
const details = [
  [
    "https://www.datajobs.nl/vacatures/aiml-engineer-bij-ilionx",
    "AI/ML Engineer",
    "ilionx",
    "Groningen",
    "datajobs-3606",
    "FULL_TIME",
    4500,
    6500,
  ],
  [
    "https://www.datajobs.nl/vacatures/data-engineer-bij-verpact",
    "Data Engineer",
    "Verpact",
    "Den Haag",
    "datajobs-3609",
    "FULL_TIME",
  ],
  [
    "https://www.datajobs.nl/vacatures/privacy-officer-bij-gemeente-altena",
    "Privacy officer",
    "Gemeente Altena",
    "Altena",
    "datajobs-3612",
    "FULL_TIME",
    3426,
    4908,
  ],
] as const;

describe("DataJobs JSON-LD connector", () => {
  it("keeps only the 244 one-segment vacancy URLs", async () => {
    const urls = await client.fetchListing();
    expect(urls).toHaveLength(244);
    for (const [url] of details) {
      expect(urls.some((entry) => entry.url === url)).toBe(true);
    }
  });

  it("parses published fields", async () => {
    await Promise.all(
      details.map(
        async ([
          url,
          title,
          employer,
          locality,
          identifier,
          employmentType,
          minValue,
          maxValue,
        ]) => {
          const detail = await client.fetchDetail(url);
          expect(detail.jobPosting).toMatchObject({
            employmentType,
            hiringOrganization: { name: employer },
            identifier: { value: identifier },
            jobLocation: { address: { addressLocality: locality } },
            title,
          });
          if (minValue !== undefined) {
            expect(detail.jobPosting).toMatchObject({
              baseSalary: {
                currency: "EUR",
                value: { maxValue, minValue, unitText: "MONTH" },
              },
            });
          }
        }
      )
    );
  });
});
