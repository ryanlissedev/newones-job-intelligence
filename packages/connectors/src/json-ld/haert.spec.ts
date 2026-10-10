import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { haertConfig } from "./configs/haert";

describe("Haert JSON-LD connector", () => {
  it("discovers exactly the 44 job-shaped sitemap URLs", async () => {
    const urls = await createJsonLdClient({
      config: haertConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(44);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/www\.haert\.nl\/opdrachten\/[a-z0-9-]+-\d+$/u.test(url)
      )
    ).toBe(true);
  });

  it("parses each recorded detail fixture's raw JobPosting node", async () => {
    const client = createJsonLdClient({
      config: haertConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://www.haert.nl/opdrachten/zwemonderwijzer-13184",
        "Zwemonderwijzer",
        "Voorne aan Zee",
        "2026-09-17",
        "13184",
        "55",
      ],
      [
        "https://www.haert.nl/opdrachten/hr-adviseur-39565",
        "HR adviseur",
        "Hoofddorp",
        "2026-08-27",
        "39565",
        "88",
      ],
      [
        "https://www.haert.nl/opdrachten/projectleider-energietransitie-98858",
        "Projectleider Energietransitie",
        "Maasdam",
        "2026-09-14",
        "98858",
        "120",
      ],
    ] as const;
    await Promise.all(
      cases.map(
        async ([
          url,
          title,
          addressLocality,
          datePosted,
          identifier,
          uurtarief,
        ]) => {
          const detail = await client.fetchDetail(url);
          expect(detail.jobPosting).toMatchObject({
            baseSalary: {
              currency: "EUR",
              value: { unitText: "HOUR", value: uurtarief },
            },
            datePosted,
            employmentType: "CONTRACTOR",
            hiringOrganization: { name: "Haert" },
            identifier,
            jobLocation: { address: { addressLocality } },
            title,
          });
        }
      )
    );
  });
});
