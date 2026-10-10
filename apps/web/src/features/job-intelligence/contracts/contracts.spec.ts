import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AANVRAAG_LIFECYCLE,
  MARKERING_STATUSES,
  SEARCH_SCOPES,
  SEARCH_SORT_OPTIONS,
  restCapabilityFailureSchema,
  searchAanvragenInputSchema,
} from "./index";

const contractsDir = import.meta.dirname;
const featureRoot = path.join(contractsDir, "..");

describe("web contracts from SoT (CTP-475)", () => {
  it("re-exports lifecycle status values for browser search state", () => {
    expect([...AANVRAAG_LIFECYCLE]).toEqual([
      "active",
      "stale",
      "closed",
      "unknown",
    ]);
  });

  it("re-exports search scope/sort SoT used by the UI", () => {
    expect([...SEARCH_SCOPES]).toEqual(["active", "all"]);
    expect([...SEARCH_SORT_OPTIONS]).toEqual([
      "relevance",
      "newest",
      "oldest",
      "rate-high",
      "rate-low",
      "closing-soon",
      "title-asc",
      "company-asc",
    ]);
  });

  it("re-exports markering status SoT", () => {
    expect([...MARKERING_STATUSES]).toEqual([
      "relevant",
      "niet_relevant",
      "gevolgd",
    ]);
  });

  it("parses REST failures via the registry SoT adapter", () => {
    const parsed = restCapabilityFailureSchema.safeParse({
      error: { code: "SYNTAX_ERROR", details: { x: 1 }, message: "bad query" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the search request body the UI posts", () => {
    expect(
      searchAanvragenInputSchema.safeParse({
        filters: { contracttype: ["interim"], tariefMin: 90 },
        limit: 8,
        offset: 0,
        query: "React",
        scope: "all",
        sort: "newest",
      }).success
    ).toBe(true);
  });

  it("does not import Effect Runtime into the contracts surface", () => {
    const source = readFileSync(path.join(contractsDir, "index.ts"), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/u.test(line));
    expect(importLines.join("\n")).not.toMatch(/from\s+["']effect["']/u);
    expect(importLines.join("\n")).not.toMatch(
      /ManagedRuntime|Effect\.|Layer\.|runPromise/u
    );
  });

  it("does not re-export @ji/search or the full registry barrel", () => {
    const source = readFileSync(path.join(contractsDir, "index.ts"), "utf-8");
    expect(source).not.toMatch(/from\s+["']@ji\/search["']/u);
    expect(source).not.toMatch(/from\s+["']@ji\/application\/registry["']/u);
    expect(source).toMatch(
      /from\s+["']@ji\/application\/registry\/web-contracts["']/u
    );
  });

  it("keeps the capability client free of Effect Runtime imports", () => {
    const source = readFileSync(
      path.join(featureRoot, "rest/capability-client.ts"),
      "utf-8"
    );
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/u.test(line));
    expect(importLines.join("\n")).not.toMatch(/from\s+["']effect["']/u);
    expect(importLines.join("\n")).not.toMatch(
      /ManagedRuntime|Effect\.|Layer\.|runPromise/u
    );
  });
});
