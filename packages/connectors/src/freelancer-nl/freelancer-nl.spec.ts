import { describe, expect, it, spyOn } from "bun:test";

import { loadConnectorFixture } from "@ji/connectors";

import {
  createFreelancerNlClient,
  createFreelancerNlConnector,
  extractFreelancerNlReference,
  parseFreelancerNlDetail,
  parseFreelancerNlListing,
} from "./index";

const BRON_ID = "bron-freelancer-nl-fixture";

describe("Freelancer.nl HTML connector", () => {
  it("parses listing cards and excludes category-only URLs", async () => {
    const fixture = await loadConnectorFixture<string>(
      "freelancer-nl/listing-page-0.json"
    );
    const listing = parseFreelancerNlListing(fixture.payload, 1);
    const sample = listing.items.find(
      (item) => item.bronReferentie === "cfc3ced1"
    );

    expect(sample).toMatchObject({
      bronReferentie: "cfc3ced1",
      locatie: "Remote",
      titel: "Designer needed for residential projects",
    });
    expect(listing.hasNextPage).toBe(true);
    expect(
      extractFreelancerNlReference("/opdrachten/archicad")
    ).toBeUndefined();
    expect(extractFreelancerNlReference("/opdrachten/ai")).toBeUndefined();
  });

  it("parses literal detail fields, description HTML, and skills", async () => {
    const fixture = await loadConnectorFixture<string>(
      "freelancer-nl/detail-cfc3ced1.json"
    );
    const detail = parseFreelancerNlDetail(fixture.payload, {
      bronReferentie: "cfc3ced1",
      url: "https://freelancer.nl/opdrachten/archicad-designer-architect/designer-needed-for-residential-projects-cfc3ced1",
    });

    expect(detail).toMatchObject({
      bronReferentie: "cfc3ced1",
      categorie: "Design & Creative",
      locatie: "Remote",
      soortBudget: "In overleg",
      start: "05-10-2026",
      status: "Open",
      titel: "Designer needed for residential projects",
      verwachteDuur: "In Overleg",
    });
    expect(detail.geplaatst).toBe("Geplaatst 15-09-2026");
    expect(detail.skills).toEqual(["archicad", "designer", "architect"]);
    expect(detail.omschrijvingHtml).toContain("Archicad");
  });

  it("deduplicates cumulative pages and stops when a page adds no URL", async () => {
    const listingFixture = await loadConnectorFixture<string>(
      "freelancer-nl/listing-page-0.json"
    );
    const firstPage = parseFreelancerNlListing(listingFixture.payload, 1);
    const client = createFreelancerNlClient({ liveEnabled: false });
    const connector = createFreelancerNlConnector({
      bronId: BRON_ID,
      client: {
        fetchDetailHtml: client.fetchDetailHtml,
        fetchListing: (page) =>
          Promise.resolve(
            page === 1
              ? firstPage
              : { hasNextPage: true, items: firstPage.items }
          ),
      },
    });

    const first = await connector.discover(null);
    const second = await connector.discover(first.checkpoint);

    expect(first.items).toHaveLength(firstPage.items.length);
    expect(second.items).toHaveLength(0);
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(false);
  });

  it("warns and falls back to an empty seen set when the checkpoint cursor is unparseable", async () => {
    const listingFixture = await loadConnectorFixture<string>(
      "freelancer-nl/listing-page-0.json"
    );
    const firstPage = parseFreelancerNlListing(listingFixture.payload, 1);
    const client = createFreelancerNlClient({ liveEnabled: false });
    const connector = createFreelancerNlConnector({
      bronId: BRON_ID,
      client: {
        fetchDetailHtml: client.fetchDetailHtml,
        fetchListing: () => Promise.resolve(firstPage),
      },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await connector.discover({ cursor: "{not json", page: 1 });

      expect(result.items).toHaveLength(firstPage.items.length);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(JSON.parse(logged)).toMatchObject({
        error: "SyntaxError",
        event: "connector.freelancer_nl.checkpoint_cursor_unparseable",
        page: 1,
      });
      expect(logged).not.toContain("not json");
    } finally {
      warn.mockRestore();
    }
  });
});
