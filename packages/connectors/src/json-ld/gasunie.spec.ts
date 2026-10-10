import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { gasunieConfig } from "./configs/gasunie";

describe("Gasunie JSON-LD connector", () => {
  const client = createJsonLdClient({
    config: gasunieConfig,
    liveEnabled: false,
  });

  it("discovers the four vacancy URLs from the sitemap", async () => {
    const urls = await client.fetchListing();
    expect(urls).toHaveLength(4);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/www\.werkenbijgasunie\.nl\/vacature\/\d+\/[^/?#]+$/u.test(
          url
        )
      )
    ).toBe(true);
  });

  it("parses JobPosting fields from the recorded details", async () => {
    const technician = await client.fetchDetail(
      "https://www.werkenbijgasunie.nl/vacature/318/technicus-e-i-warmte-rotterdam-den-haag"
    );
    expect(technician.jobPosting).toMatchObject({
      baseSalary: {
        currency: "EUR",
        value: { maxValue: 5327, minValue: 3912, unitText: "HOUR" },
      },
      datePosted: "2026-05-19T00:00:17+02:00",
      hiringOrganization: { name: "Gasunie" },
      title: "Technicus E&I Warmte, Rotterdam/Den Haag",
      validThrough: "2026-10-11T23:59:59+02:00",
    });

    const production = await client.fetchDetail(
      "https://www.werkenbijgasunie.nl/vacature/341/production-lead"
    );
    expect(production.jobPosting).toMatchObject({
      hiringOrganization: { name: "Gasunie" },
      title: "Production Lead",
    });
  });

  it("reads the vacancy-location label block the JSON-LD leaves empty", async () => {
    const technician = await client.fetchDetail(
      "https://www.werkenbijgasunie.nl/vacature/318/technicus-e-i-warmte-rotterdam-den-haag"
    );
    expect(technician.labelBlock).toMatchObject({ locatie: "Barendrecht" });
    const production = await client.fetchDetail(
      "https://www.werkenbijgasunie.nl/vacature/341/production-lead"
    );
    expect(production.labelBlock).toMatchObject({ locatie: "Rotterdam" });
  });
});
