import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { randstadConfig } from "./configs/randstad";

const client = createJsonLdClient({
  config: randstadConfig,
  liveEnabled: false,
});

describe("Randstad JSON-LD connector", () => {
  it("discovers the five recorded sitemap URLs", async () => {
    expect(await client.fetchListing()).toEqual([
      {
        lastmod: "2026-09-16",
        url: "https://www.randstad.nl/vacatures/741140/vrachtwagenchauffeur-allround",
      },
      {
        lastmod: "2026-09-16",
        url: "https://www.randstad.nl/vacatures/741146/all-round-truck-driver-vrachtwagenchauffeur",
      },
      {
        lastmod: "2026-09-16",
        url: "https://www.randstad.nl/vacatures/749250/operator",
      },
      {
        lastmod: "2026-09-16",
        url: "https://www.randstad.nl/vacatures/742983/jaarcontract-vrachtwagenchauffeur",
      },
      {
        lastmod: "2026-09-16",
        url: "https://www.randstad.nl/vacatures/752336/catering-medewerker-dagdienst-flexibel-rooster",
      },
    ]);
  });

  it("parses the recorded Teamleider JobPosting fields", async () => {
    const detail = await client.fetchDetail(
      "https://www.randstad.nl/vacatures/752363/teamleider"
    );
    expect(detail.jobPosting).toMatchObject({
      baseSalary: {
        currency: "EUR",
        value: { maxValue: "3100.00", minValue: "2700.00", unitText: "MONTH" },
      },
      datePosted: "2026-09-16",
      hiringOrganization: { name: "Randstad" },
      jobLocation: { address: { addressLocality: "Venlo" } },
      title: "Teamleider",
      validThrough: "2026-10-23",
    });
  });

  it("folds the contactitem__container tel/mailto channels into contactpersonen (CTP-610)", async () => {
    const detail = await client.fetchDetail(
      "https://www.randstad.nl/vacatures/752363/teamleider"
    );
    expect(detail.contactpersonen).toEqual([
      {
        email: "redacted@example.invalid",
        telefoon: "+31000000000",
      },
    ]);
  });
});
