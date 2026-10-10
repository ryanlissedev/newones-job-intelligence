import { describe, expect, it } from "bun:test";

import {
  buildMercellSearchParameters,
  createMercellClient,
  createMercellConnector,
  isMercellListingOpen,
  MERCELL_PAGE_SIZE,
} from "@ji/connectors/mercell";
import type { MercellClient, MercellListingItem } from "@ji/connectors/mercell";

const listingRow = (
  overrides: Partial<MercellListingItem> = {}
): MercellListingItem => ({
  CreatedDate: "2026-09-18T14:44:47.947Z",
  Deadline: "2026-10-09T22:00:00Z",
  OrganizationName: "Gemeente Amsterdam",
  ProcedureType: 13,
  PublicationDate: "2026-09-18T14:44:46.553Z",
  Status: 1,
  TenderId: 228_236,
  TenderName: "Aanschaf zero emissie motorfietsen",
  ...overrides,
});

const buildClient = (
  rows: MercellListingItem[],
  resultsCount = rows.length
): MercellClient => ({
  fetchDetail: (tenderId) =>
    Promise.resolve({
      TenderId: Number(tenderId),
      TenderName: `detail ${tenderId}`,
      publicationAuthorities: [],
    }),
  fetchListing: () =>
    Promise.resolve({
      endIndex: rows.length,
      results: rows,
      resultsCount,
      startIndex: 1,
    }),
});

describe("Mercell connector", () => {
  it("builds 1-based inclusive row bounds for the search POST", () => {
    expect(buildMercellSearchParameters(0)).toMatchObject({
      EndIndex: MERCELL_PAGE_SIZE,
      OrderColumn: "CreatedDate",
      SearchProperty: null,
      StartIndex: 1,
    });
    expect(buildMercellSearchParameters(2).StartIndex).toBe(201);
    expect(buildMercellSearchParameters(2).EndIndex).toBe(300);
    expect(
      buildMercellSearchParameters(0, { todayOnly: true }).SearchProperty
    ).toMatchObject({ PropertyName: "str_Today_status", PropertyValue: "1" });
  });

  it("binds the connector to the supplied bron id", () => {
    const connector = createMercellConnector({ bronId: "bron-test" });
    expect(connector.bronId).toBe("bron-test");
  });

  it("reads the real fixture listing and emits TenderId bronReferenties", async () => {
    const connector = createMercellConnector({
      bronId: "bron-test",
      client: createMercellClient({ liveEnabled: false }),
    });
    const result = await connector.discover(null);

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]?.bronReferentie).toBe("228236");
    // The fixture is a real page of a 20 105-row result set, so the walk
    // continues; a second fixture page is empty and ends it.
    expect(result.hasMore).toBe(true);
    const next = await connector.discover(result.checkpoint);
    expect(next.items).toHaveLength(0);
    expect(next.hasMore).toBe(false);
  });

  it("fetches and projects the fixture detail for a discovered item", async () => {
    const connector = createMercellConnector({
      bronId: "bron-test",
      client: createMercellClient({ liveEnabled: false }),
    });
    const discovery = await connector.discover(null);
    const [item] = discovery.items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);

    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    // SAFETY: the connector serialises MercellFetchedPayload; the projection
    // must drop every field not named on the whitelist (DEC-008), so the
    // shape below names the keys under test explicitly.
    const payload = JSON.parse(new TextDecoder().decode(fetched.body)) as {
      detail: {
        ContactPersonDisplayName?: string | null;
        publicationAuthorities?: string[];
        PublicationAuthorities?: unknown;
        RequirementBoxes?: unknown;
        TenderName?: string;
      };
      listing: { CreatedById?: unknown; EntityMnemonic?: unknown };
      tenderId: string;
    };
    expect(payload.tenderId).toBe("228236");
    expect(payload.detail.TenderName).toContain("zero emissie motorfietsen");
    // The wire carries PublicationAuthorities[] records; only the Mnemonic
    // list survives projection, as `publicationAuthorities`.
    expect(payload.detail.publicationAuthorities).toEqual(["MeFormsAuthority"]);
    expect(payload.detail.PublicationAuthorities).toBeUndefined();
    // Contact fields are whitelisted but were PII-stripped at capture time.
    expect(payload.detail.ContactPersonDisplayName).toBeNull();
    expect(payload.detail.RequirementBoxes).toBeUndefined();
    expect(payload.listing.CreatedById).toBeUndefined();
    expect(payload.listing.EntityMnemonic).toBeUndefined();
  });

  it("rejects a fetch item whose listing payload lacks TenderId", async () => {
    const connector = createMercellConnector({
      bronId: "bron-test",
      client: buildClient([]),
    });
    const result = await connector.fetch({
      bronReferentie: "x",
      contentHash: "h",
      listingPayload: { TenderName: "no id" },
    });
    expect(result?.status).toBe("rejected");
  });

  it("cuts the walk at the publishedSince window edge and marks it truncated", async () => {
    const rows = [
      listingRow({ CreatedDate: "2026-09-18T10:00:00Z", TenderId: 1 }),
      listingRow({ CreatedDate: "2026-09-17T10:00:00Z", TenderId: 2 }),
      listingRow({ CreatedDate: "2026-09-10T10:00:00Z", TenderId: 3 }),
    ];
    const connector = createMercellConnector({
      bronId: "bron-test",
      client: buildClient(rows, 20_105),
      publishedSince: new Date("2026-09-16T00:00:00Z"),
    });
    const result = await connector.discover(null);

    expect(result.items.map((item) => item.bronReferentie)).toEqual(["1", "2"]);
    expect(result.hasMore).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("reads Status 1 as open and Status 2 as closed", () => {
    expect(isMercellListingOpen({ Status: 1 })).toBe(true);
    expect(isMercellListingOpen({ Status: 2 })).toBe(false);
    expect(isMercellListingOpen({ Status: null })).toBe(false);
  });
});
