import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { nsConfig } from "./configs/ns";

describe("NS JSON-LD connector", () => {
  it("discovers the 10 jobs and excludes listing noise", async () => {
    const urls = await createJsonLdClient({
      config: nsConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(10);
    expect(urls.some(({ url }) => url.endsWith("/vacatures"))).toBe(false);
    expect(urls.some(({ url }) => url.endsWith("/vacatures/favorieten"))).toBe(
      false
    );
  });

  it("parses each recorded detail fixture's raw JobPosting node", async () => {
    const client = createJsonLdClient({ config: nsConfig, liveEnabled: false });
    const cases = [
      [
        "https://www.werkenbijns.nl/vacatures/conducteur-zwolle-zwolle-1331708",
        "Conducteur Zwolle",
        "Zwolle",
      ],
      [
        "https://www.werkenbijns.nl/vacatures/it-lead-ns-stations-utrecht-1316973",
        "IT Lead - NS Stations",
        "Utrecht",
      ],
      [
        "https://www.werkenbijns.nl/vacatures/sap-run-manager-utrecht-utrecht-1320979",
        "SAP RUN manager - Utrecht",
        "Utrecht",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, locality]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          employmentType: ["FULL_TIME"],
          hiringOrganization: { name: "NS" },
          jobLocation: { address: { addressLocality: locality } },
          title,
        });
      })
    );
  });
});
