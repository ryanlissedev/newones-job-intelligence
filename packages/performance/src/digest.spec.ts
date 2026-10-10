import { describe, expect, test } from "bun:test";

import {
  digestQueryIdentity,
  digestQueryset,
  digestSearchResult,
} from "./digest";
import { isCriticalPathLabel } from "./labels";

describe("@ji/performance digests", () => {
  test("digestQueryset is stable and excludes PII from metadata shape", () => {
    const first = digestQueryset({ query: "azure AND engineer" });
    const second = digestQueryset({ query: "azure AND engineer" });
    const third = digestQueryset({ query: "kubernetes OR platform" });
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first.startsWith("sha256:")).toBe(true);
  });

  test("digestSearchResult uses counts only, not vacancy ids", () => {
    const digest = digestSearchResult({
      facets: {
        bron_id: [{ count: 2 }],
        contracttype: [{ count: 1 }],
        locatie_land: [{ count: 3 }],
        status: [{ count: 4 }],
      },
      indexVersion: 7,
      total: 10,
    });
    expect(digest.startsWith("sha256:")).toBe(true);
    expect(digest.includes("doc-")).toBe(false);
  });

  test("digestQueryIdentity never exposes raw SQL", () => {
    const identity = digestQueryIdentity("1234567890123456789");
    expect(identity.startsWith("pg-queryid:")).toBe(true);
    expect(identity.includes("SELECT")).toBe(false);
  });
});

describe("@ji/performance labels", () => {
  test("rejects unbounded labels", () => {
    expect(isCriticalPathLabel("search-parser")).toBe(true);
    expect(isCriticalPathLabel("vacancy-123")).toBe(false);
    expect(isCriticalPathLabel("query text")).toBe(false);
  });
});
