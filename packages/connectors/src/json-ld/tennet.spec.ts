import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { tennetConfig } from "./configs/tennet";

describe("TenneT JSON-LD connector (Avature synthesis)", () => {
  it("discovers only the numeric-id JobDetail URLs", async () => {
    const urls = await createJsonLdClient({
      config: tennetConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(3);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/careers\.tennet\.eu\/nl_NL\/careers\/JobDetail\/[^/]+\/\d+$/u.test(
          url
        )
      )
    ).toBe(true);
  });

  it("synthesises a JobPosting from each detail's og metas and article bodies", async () => {
    const client = createJsonLdClient({
      config: tennetConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://careers.tennet.eu/nl_NL/careers/JobDetail/Toezichthouder-Transmission-Lines-Brabant/94548",
        "Toezichthouder Transmission Lines Brabant",
        "94548",
      ],
      [
        "https://careers.tennet.eu/nl_NL/careers/JobDetail/Power-System-EMT-Specialist/99587",
        "Power System EMT Specialist",
        "99587",
      ],
      [
        "https://careers.tennet.eu/nl_NL/careers/JobDetail/Operating-Engineer-Electrical-Auxiliary-Automation-Expat-EU-Resident-Malaysia-Johor-Bahru/91976",
        "Operating Engineer Electrical Auxiliary & Automation [Expat / EU-Resident] - Malaysia Johor Bahru",
        "91976",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, id]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          "@type": "JobPosting",
          hiringOrganization: { name: "TenneT" },
          identifier: { name: "TenneT", value: id },
          // Avature publishes no location on the detail page: country only.
          jobLocation: { address: { addressCountry: "NL" } },
          title,
          url,
        });
        expect(detail.jobPosting?.description).toBeTruthy();
        expect(detail.labelBlock.referentienummer).toBe(id);
      })
    );
  });
});
