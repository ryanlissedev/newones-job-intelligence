import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { techniekwerktConfig } from "./configs/techniekwerkt";
import { decodeLiveBodyBytes } from "./live-fetch";

describe("Techniekwerkt JSON-LD connector (Vike synthesis)", () => {
  it("discovers exactly the recorded job-shaped sitemap URLs", async () => {
    const urls = await createJsonLdClient({
      config: techniekwerktConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(3);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/techniekwerkt\.nl\/nl\/vacature\/[^/]+-\d+$/u.test(url)
      )
    ).toBe(true);
  });

  it("synthesises a JobPosting from each detail's vike_pageContext job", async () => {
    const client = createJsonLdClient({
      config: techniekwerktConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://techniekwerkt.nl/nl/vacature/monteur-elektrotechniek-unica-eindhoven-973508",
        "Monteur Elektrotechniek",
        "Unica",
        "Eindhoven",
        "973508",
      ],
      [
        "https://techniekwerkt.nl/nl/vacature/pcs-7-software-engineer-unica-zwolle-973447",
        "PCS 7 Software Engineer",
        "Unica",
        "Zwolle",
        "973447",
      ],
      [
        "https://techniekwerkt.nl/nl/vacature/leerling-monteur-werktuigbouwkunde-unica-rotterdam-973440",
        "Leerling Monteur Werktuigbouwkunde",
        "Unica",
        "Rotterdam",
        "973440",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, company, city, id]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          "@type": "JobPosting",
          hiringOrganization: { name: company },
          identifier: { name: "Techniekwerkt", value: id },
          jobLocation: {
            address: { addressCountry: "NL", addressLocality: city },
          },
          title,
          url,
        });
        expect(detail.labelBlock.referentienummer).toBe(id);
        expect(detail.labelBlock.branche).toBe("Installatiebedrijven");
      })
    );
  });

  it("does not synthesise a JobPosting for a page whose pageContext has no job", async () => {
    const client = createJsonLdClient({
      config: {
        ...techniekwerktConfig,
        detailFixtures: {
          "https://techniekwerkt.nl/nl/vacatures":
            "techniekwerkt/detail-vacatures-listing.json",
        },
      },
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(
      "https://techniekwerkt.nl/nl/vacatures"
    );
    expect(detail.jobPosting).toBeNull();
  });
});

describe("decodeLiveBodyBytes", () => {
  it("inflates a gzip-compressed body sent without Content-Encoding", async () => {
    const text =
      '<?xml version="1.0"?><urlset><url><loc>x</loc></url></urlset>';
    const stream = new Blob([text])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(stream).arrayBuffer();
    expect(await decodeLiveBodyBytes(compressed)).toBe(text);
  });

  it("passes plain text through untouched", async () => {
    const text = "<html><body>plain</body></html>";
    const bytes = await new Response(new Blob([text])).arrayBuffer();
    expect(await decodeLiveBodyBytes(bytes)).toBe(text);
  });
});
