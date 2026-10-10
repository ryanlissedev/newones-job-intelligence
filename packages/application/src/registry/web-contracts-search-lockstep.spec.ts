import { describe, expect, it } from "bun:test";

import {
  DEFAULT_SEARCH_SCOPE as SEARCH_DEFAULT,
  SEARCH_SCOPES as SEARCH_PKG_SCOPES,
  SEARCH_SORT_OPTIONS as SEARCH_PKG_SORTS,
  SEARCH_WINDOW_LIMIT as SEARCH_PKG_WINDOW,
} from "@ji/search";

import {
  DEFAULT_SEARCH_SCOPE,
  SEARCH_SCOPES,
  SEARCH_SORT_OPTIONS,
  SEARCH_WINDOW_LIMIT,
} from "./schemas";

describe("search literals lockstep (CTP-475)", () => {
  it("keeps registry SEARCH_SCOPES identical to @ji/search", () => {
    expect([...SEARCH_SCOPES]).toEqual([...SEARCH_PKG_SCOPES]);
    expect(DEFAULT_SEARCH_SCOPE).toBe(SEARCH_DEFAULT);
  });

  it("keeps registry SEARCH_SORT_OPTIONS identical to @ji/search", () => {
    expect([...SEARCH_SORT_OPTIONS]).toEqual([...SEARCH_PKG_SORTS]);
  });

  it("keeps SEARCH_WINDOW_LIMIT identical to @ji/search", () => {
    expect(SEARCH_WINDOW_LIMIT).toBe(SEARCH_PKG_WINDOW);
  });
});
