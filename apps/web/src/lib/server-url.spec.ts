import { describe, expect, it } from "bun:test";

import { stripTrailingSlash } from "./server-url";

describe("stripTrailingSlash", () => {
  it("removes a single trailing slash from an absolute URL", () => {
    expect(stripTrailingSlash("http://localhost:3000/")).toBe(
      "http://localhost:3000"
    );
  });

  it("leaves a URL without a trailing slash unchanged", () => {
    expect(stripTrailingSlash("http://localhost:3000")).toBe(
      "http://localhost:3000"
    );
  });
});
