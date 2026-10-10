import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { planetInterimConfig } from "./configs/planet-interim";

describe("Planet Interim JSON-LD connector", () => {
  it("discovers exactly the 20 job-shaped listing URLs", async () => {
    const urls = await createJsonLdClient({
      config: planetInterimConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(20);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/planetinterim\.nl\/[a-z0-9-]+\/\d+\/p\d+\/default\.html$/u.test(
          url
        )
      )
    ).toBe(true);
  });

  it("parses each recorded detail fixture's raw JobPosting node", async () => {
    const client = createJsonLdClient({
      config: planetInterimConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://planetinterim.nl/beleidsadviseur-informatisering-ciso-bu/538233/p13/default.html",
        "Beleidsadviseur Informatisering / CISO – Bunschoten & Putten",
        "Bunschoten-Spakenburg",
        "2026-09-14",
      ],
      [
        "https://planetinterim.nl/data-regisseur-bi-specialist/538587/p13/default.html",
        "Data Regisseur / BI Specialist",
        "Hoorn",
        "2026-09-16",
      ],
      [
        "https://planetinterim.nl/informatiemanager-crisisbeheersing/538704/p13/default.html",
        "Informatiemanager Crisisbeheersing",
        "Arnhem",
        "2026-09-17",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, addressLocality, datePosted]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          datePosted,
          employmentType: "CONTRACTOR",
          hiringOrganization: { name: "Planet Interim" },
          jobLocation: { address: { addressLocality } },
          title,
        });
      })
    );
  });
});
