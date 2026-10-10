import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { intermediairConfig } from "./configs/intermediair";
import { createJsonLdConnector } from "./connector";

describe("Intermediair JSON-LD connector", () => {
  it("keeps single-pass whole-corpus discovery while no batchSize is configured (CTP-624)", async () => {
    const connector = createJsonLdConnector({
      bronId: "bron-intermediair-unbatched",
      client: createJsonLdClient({
        config: intermediairConfig,
        liveEnabled: false,
      }),
      config: intermediairConfig,
    });
    const discovered = await connector.discover(null);
    expect(discovered.hasMore).toBe(false);
    expect(discovered.checkpoint).toEqual({});
    expect(discovered.items).toHaveLength(2480);
  });

  it("discovers exactly the 2480 job-shaped sitemap URLs", async () => {
    const urls = await createJsonLdClient({
      config: intermediairConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(2480);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/www\.intermediair\.nl\/vacature\/[0-9a-f-]{36}\/[a-z0-9-]+$/u.test(
          url
        )
      )
    ).toBe(true);
  });

  it("parses each recorded detail fixture's raw JobPosting node", async () => {
    const client = createJsonLdClient({
      config: intermediairConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://www.intermediair.nl/vacature/0cad6431-f0e1-4d5a-9872-d4cba5ef0225/asfaltuitvoerder",
        "Asfaltuitvoerder",
        "Nieuwleusen",
        "2026-08-10T22:00:00Z",
        "BAM",
      ],
      [
        "https://www.intermediair.nl/vacature/7fd25dd1-894d-4844-acf7-b5b672a10afc/klantmanager-werk-en-inkomen",
        "Klantmanager Werk en Inkomen",
        "Bergen op Zoom",
        "2026-09-02T22:00:00Z",
        "Matchpartner",
      ],
      [
        "https://www.intermediair.nl/vacature/f7184d95-36c8-4b0c-8a6d-c4054a749c39/validatie-technicus",
        "Validatie technicus",
        "Eindhoven",
        "2026-09-11T22:00:00Z",
        "BAM",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, addressLocality, datePosted, orgName]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          datePosted,
          hiringOrganization: { name: orgName },
          jobLocation: { address: { addressCountry: "NL", addressLocality } },
          title,
        });
      })
    );
  });
});
