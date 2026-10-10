import { describe, expect, it } from "bun:test";

import { DEFAULT_SEARCH_PAGE_SIZE } from "@ji/domain";

import { searchAanvragenInputSchema } from "./capability-io";
import { SEARCH_WINDOW_LIMIT } from "./schemas";

describe("DEFAULT_SEARCH_PAGE_SIZE", () => {
  it("keeps omitted search limits inside the search window", () => {
    expect(DEFAULT_SEARCH_PAGE_SIZE).toBe(20);
    expect(
      searchAanvragenInputSchema.safeParse({
        offset: SEARCH_WINDOW_LIMIT - DEFAULT_SEARCH_PAGE_SIZE + 1,
        query: "x",
      }).success
    ).toBe(false);
    expect(
      searchAanvragenInputSchema.safeParse({
        offset: SEARCH_WINDOW_LIMIT - DEFAULT_SEARCH_PAGE_SIZE,
        query: "x",
      }).success
    ).toBe(true);
  });
});
