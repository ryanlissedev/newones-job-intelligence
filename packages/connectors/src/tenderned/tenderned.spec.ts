import { describe, expect, it } from "bun:test";

import {
  asIdString,
  buildTenderNedPollFilters,
  createTenderNedClient,
  createTenderNedConnector,
  requestedListingSize,
  TENDER_NED_MAX_PAGE_SIZE,
} from "@ji/connectors/tenderned";
import type {
  TenderNedClient,
  TenderNedListingItem,
} from "@ji/connectors/tenderned";

const NUMERIC_KENMERK = 563_214;
const NUMERIC_PUBLICATIE_ID = 608_998;

const buildNumericIdClient = (): TenderNedClient => {
  // SAFETY: parsing raw JSON reproduces live TenderNed responses, where ids
  // arrive as numbers despite the declared string types.
  const item = JSON.parse(
    `{"aanbestedingNaam":"Platform engineer Azure DAS","kenmerk":${NUMERIC_KENMERK},"publicatieId":${NUMERIC_PUBLICATIE_ID}}`
  ) as TenderNedListingItem;
  return {
    fetchDetail: (publicatieId) => Promise.resolve({ ...item, publicatieId }),
    fetchListing: () =>
      Promise.resolve({
        content: [item],
        first: true,
        last: true,
        number: 0,
        size: 1,
        totalElements: 1,
        totalPages: 1,
      }),
  };
};

describe("TenderNed connector", () => {
  it("supports a 14-day test-import window while retaining poll defaults", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");

    expect(buildTenderNedPollFilters(now, "UTC")).toEqual({
      cpvCodes: ["72000000-5", "79620000-6"],
      publicatieDatumVanaf: "2026-08-30",
      typeOpdracht: "D",
    });
    expect(buildTenderNedPollFilters(now, "UTC", 14)).toEqual({
      cpvCodes: ["72000000-5", "79620000-6"],
      publicatieDatumVanaf: "2026-08-17",
      typeOpdracht: "D",
    });
  });

  it("never requests a listing page size above 100", () => {
    expect(requestedListingSize(101)).toBe(TENDER_NED_MAX_PAGE_SIZE);
    expect(requestedListingSize(50)).toBe(50);
  });

  it("binds the connector to the supplied bron id", () => {
    const connector = createTenderNedConnector({ bronId: "bron-test" });
    expect(connector.bronId).toBe("bron-test");
  });

  it("coerces numeric ids to strings and leaves strings untouched", () => {
    expect(asIdString(NUMERIC_KENMERK)).toBe("563214");
    expect(asIdString("TN563214")).toBe("TN563214");
    expect(asIdString(12n)).toBe("12");
    expect(asIdString(Number.NaN)).toBe("");
    const missing: string | undefined = undefined;
    expect(asIdString(missing)).toBe("");
    expect(asIdString(null)).toBe("");
  });

  it("emits a string bronReferentie when the listing kenmerk is numeric", async () => {
    const connector = createTenderNedConnector({
      bronId: "bron-test",
      client: buildNumericIdClient(),
    });
    const result = await connector.discover(null);

    expect(result.items).toHaveLength(1);
    const [item] = result.items;
    expect(item?.bronReferentie).toBe("563214");
    expect(item?.bronReferentie).toBeTypeOf("string");
  });

  it("fetches with a string publicatieId when the listing id is numeric", async () => {
    const connector = createTenderNedConnector({
      bronId: "bron-test",
      client: buildNumericIdClient(),
    });
    const discovered = await connector.discover(null);
    const [item] = discovered.items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);

    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    expect(fetched.bronReferentie).toBe("563214");
    // SAFETY: the connector serialises TenderNedFetchedPayload; only the
    // publicatieId shape is inspected here.
    const payload = JSON.parse(new TextDecoder().decode(fetched.body)) as {
      publicatieId: unknown;
    };
    expect(payload.publicatieId).toBe("608998");
  });

  it("keeps the fixture string ids intact", async () => {
    const connector = createTenderNedConnector({
      bronId: "bron-test",
      client: createTenderNedClient({ liveEnabled: false }),
    });
    const result = await connector.discover(null);
    expect(result.items[0]?.bronReferentie).toBe("TN563214");
  });
});
