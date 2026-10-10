import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  createJsonLdConnector,
  bamConfig,
} from "@ji/connectors/json-ld";

const url =
  "https://www.bamcareers.com/nl/nl/job/26209/Medewerker-Verkeersmaatregelen";
const connector = createJsonLdConnector({
  bronId: "00000000-0000-4000-8000-000000000015",
  client: createJsonLdClient({
    config: bamConfig,
    listingFixturePath: "bam/listing-page-0.json",
    liveEnabled: false,
  }),
  config: bamConfig,
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

describe("BAM JSON-LD connector", () => {
  it("keeps exactly the 328 NL job URLs", async () => {
    const result = await connector.discover(null);
    expect(result.items).toHaveLength(328);
    expect(
      result.items.every((item) => itemUrl(item).includes("/nl/nl/job/"))
    ).toBe(true);
    const fetched = await connector.fetch(findItem(result.items, url));
    if (fetched?.status !== "fetched") {
      throw new Error("fixture did not fetch");
    }
  });
});
