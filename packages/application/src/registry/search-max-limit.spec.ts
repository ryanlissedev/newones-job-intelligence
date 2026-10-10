import { describe, expect, it } from "bun:test";

import {
  BATCH_GET_AANVRAGEN_MAX_IDS,
  SEARCH_MAX_LIMIT,
  searchAanvragenInputSchema,
} from "./capability-io";

describe("CTP-509 SEARCH_MAX_LIMIT", () => {
  it("caps search pages at 1000 and rejects larger limits without silent truncate", () => {
    expect(SEARCH_MAX_LIMIT).toBe(1000);
    expect(BATCH_GET_AANVRAGEN_MAX_IDS).toBe(1000);

    expect(
      searchAanvragenInputSchema.safeParse({
        limit: 1000,
        offset: 0,
        query: "azure",
      }).success
    ).toBe(true);

    expect(
      searchAanvragenInputSchema.safeParse({
        limit: 1001,
        offset: 0,
        query: "azure",
      }).success
    ).toBe(false);

    expect(
      searchAanvragenInputSchema.safeParse({
        limit: 500,
        offset: 500,
        query: "azure",
      }).success
    ).toBe(true);
  });
});
