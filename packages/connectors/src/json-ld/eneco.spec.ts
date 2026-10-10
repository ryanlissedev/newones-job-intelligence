import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { enecoConfig } from "./configs/eneco";

describe("Eneco JSON-LD connector", () => {
  it("discovers exactly the 142 job-shaped sitemap URLs", async () => {
    const urls = await createJsonLdClient({
      config: enecoConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(142);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/www\.werkenbijeneco\.nl\/vacatures\/[^/]+-\d+$/u.test(url)
      )
    ).toBe(true);
  });

  it("parses each recorded detail fixture's raw JobPosting node", async () => {
    const client = createJsonLdClient({
      config: enecoConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://www.werkenbijeneco.nl/vacatures/meewerkstage-dei-communicatie-employee-networks-2954",
        "Meewerkstage DEI: Communicatie & Employee Networks",
        450,
        675,
      ],
      [
        "https://www.werkenbijeneco.nl/vacatures/ervaren-accountsupporter-3145",
        "Ervaren Accountsupporter",
        55_000,
        77_000,
      ],
      [
        "https://www.werkenbijeneco.nl/vacatures/senior-trader-gas-2864",
        "Senior Trader Gas",
        110_000,
        170_000,
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, minValue, maxValue]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          baseSalary: {
            value: { maxValue, minValue, unitText: "MONTH" },
          },
          hiringOrganization: { name: "Eneco" },
          jobLocation: { address: { addressLocality: "Rotterdam" } },
          title,
        });
      })
    );
  });
});
