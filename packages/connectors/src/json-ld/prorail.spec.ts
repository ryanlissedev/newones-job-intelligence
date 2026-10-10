import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  createJsonLdConnector,
  prorailConfig,
} from "@ji/connectors/json-ld";

const url = "https://www.werkenbijprorail.nl/vacatures/functie/woordvoerder";
const verkeersleidingUrl =
  "https://www.werkenbijprorail.nl/vacatures/verkeersleiding/treinverkeersleider-maastricht";
const connector = createJsonLdConnector({
  bronId: "00000000-0000-4000-8000-000000000031",
  client: createJsonLdClient({
    config: prorailConfig,
    listingFixturePath: "prorail/listing-page-0.json",
    liveEnabled: false,
  }),
  config: prorailConfig,
});
const itemUrl = (
  item: Awaited<ReturnType<typeof connector.discover>>["items"][number]
): string =>
  // SAFETY: discover() always attaches the sitemap row as listingPayload.
  (item.listingPayload as { url: string }).url;
const findItem = (
  items: Awaited<ReturnType<typeof connector.discover>>["items"],
  wanted: string
) => {
  const item = items.find((entry) => itemUrl(entry) === wanted);
  if (!item) {
    throw new Error(`missing fixture item ${wanted}`);
  }
  return item;
};

describe("ProRail JSON-LD connector", () => {
  it("discovers all 16 API vacancy URLs and fetches both detail paths", async () => {
    const result = await connector.discover(null);
    expect(result.items).toHaveLength(16);
    expect(
      result.items.every((item) =>
        /^https:\/\/www\.werkenbijprorail\.nl\/vacatures\/[^/]+\/[^/]+\/?$/u.test(
          itemUrl(item)
        )
      )
    ).toBe(true);
    const fetched = await Promise.all(
      [url, verkeersleidingUrl].map((wanted) =>
        connector.fetch(findItem(result.items, wanted))
      )
    );
    expect(fetched.map((entry) => entry?.status)).toEqual([
      "fetched",
      "fetched",
    ]);
  });
});
