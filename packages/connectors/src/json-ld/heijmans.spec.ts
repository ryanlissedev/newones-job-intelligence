import { describe, expect, it } from "bun:test";

import {
  createJsonLdClient,
  createJsonLdConnector,
  heijmansConfig,
} from "@ji/connectors/json-ld";

const url =
  "https://www.werkenbijheijmans.nl/vacatures/maintenance-engineer-drachten-v-014747";
const soft404 =
  "https://www.werkenbijheijmans.nl/vacatures/allround-bouwmedewerker-veldhoven-v-014984";
const connector = createJsonLdConnector({
  bronId: "00000000-0000-4000-8000-000000000016",
  client: createJsonLdClient({
    config: heijmansConfig,
    listingFixturePath: "heijmans/listing-page-0.json",
    liveEnabled: false,
  }),
  config: heijmansConfig,
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

describe("Heijmans JSON-LD connector", () => {
  it("keeps exactly the 563 vacancy URLs and fetches a detail", async () => {
    const result = await connector.discover(null);
    expect(result.items).toHaveLength(563);
    expect(
      result.items.every(
        (item) =>
          itemUrl(item).includes("/vacatures/") &&
          /-v-\d+$/u.test(itemUrl(item))
      )
    ).toBe(true);
    const fetched = await connector.fetch(findItem(result.items, url));
    if (fetched?.status !== "fetched") {
      throw new Error("fixture did not fetch");
    }
  });
  it("rejects the recorded sitemap soft-404", async () => {
    const result = await connector.discover(null);
    const fetched = await connector.fetch(findItem(result.items, soft404));
    expect(fetched).toMatchObject({
      reason: "no JobPosting JSON-LD found on detail page",
      status: "rejected",
    });
  });
});
