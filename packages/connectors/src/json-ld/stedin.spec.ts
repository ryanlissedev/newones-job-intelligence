import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { stedinConfig } from "./configs/stedin";

describe("Stedin JSON-LD connector", () => {
  const client = createJsonLdClient({
    config: stedinConfig,
    liveEnabled: false,
  });

  it("discovers only the 93 vacancy URLs", async () => {
    const urls = await client.fetchListing();
    expect(urls).toHaveLength(93);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/werkenbij\.stedin\.net\/banen\/[^/?#]+\/[^/?#]+\/\d+\/\d+$/u.test(
          url
        )
      )
    ).toBe(true);
  });

  it("parses JobPosting fields from the recorded details", async () => {
    const amstelveen = await client.fetchDetail(
      "https://werkenbij.stedin.net/banen/amstelveen/monteur-gas/3297/35532249792"
    );
    expect(amstelveen.jobPosting).toMatchObject({
      datePosted: "2026-7-28",
      hiringOrganization: { name: "Stedin" },
      jobLocation: [{ address: { addressLocality: "Amstelveen" } }],
      title: "Monteur Gas",
    });

    const delft = await client.fetchDetail(
      "https://werkenbij.stedin.net/banen/delft/devops-engineer/3297/43419274752"
    );
    expect(delft.jobPosting).toMatchObject({
      datePosted: "2026-8-24",
      hiringOrganization: { name: "Stedin" },
      jobLocation: [{ address: { addressLocality: "Delft" } }],
      title: "DevOps Engineer",
    });
  });
});
