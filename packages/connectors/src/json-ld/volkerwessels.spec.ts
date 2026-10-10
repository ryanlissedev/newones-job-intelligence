import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  createJsonLdConnector,
  volkerwesselsConfig,
} from "@ji/connectors/json-ld";

const url =
  "https://www.werkenbijvolkerwessels.nl/vacature/3353/projectontwikkelaar-1";
const connector = createJsonLdConnector({
  bronId: "00000000-0000-4000-8000-000000000014",
  client: createJsonLdClient({
    config: volkerwesselsConfig,
    listingFixturePath: "volkerwessels/listing-page-0.json",
    liveEnabled: false,
  }),
  config: volkerwesselsConfig,
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

describe("VolkerWessels JSON-LD connector", () => {
  it("discovers all 533 vacancy URLs and fetches a detail", async () => {
    const discovered = await connector.discover(null);
    expect(discovered.items).toHaveLength(533);
    expect(
      discovered.items.every(
        (item) => item.listingPayload && itemUrl(item).includes("/vacature/")
      )
    ).toBe(true);
    const result = await connector.fetch(findItem(discovered.items, url));
    expect(result?.status).toBe("fetched");
  });
});
