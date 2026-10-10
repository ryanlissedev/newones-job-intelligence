import { describe, expect, it } from "bun:test";

import { resolveInternalServerUrl } from "./internal-server-url";

const PUBLIC_URL = "http://localhost:3000";
const INTERNAL_URL = "http://server:3000";

describe("resolveInternalServerUrl", () => {
  it("prefers INTERNAL_SERVER_URL when it is set", () => {
    expect(
      resolveInternalServerUrl({
        INTERNAL_SERVER_URL: INTERNAL_URL,
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
      })
    ).toBe(INTERNAL_URL);
  });

  it("falls back to NEXT_PUBLIC_SERVER_URL when INTERNAL_SERVER_URL is unset", () => {
    expect(
      resolveInternalServerUrl({ NEXT_PUBLIC_SERVER_URL: PUBLIC_URL })
    ).toBe(PUBLIC_URL);
    expect(
      resolveInternalServerUrl({
        INTERNAL_SERVER_URL: undefined,
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
      })
    ).toBe(PUBLIC_URL);
  });

  it("treats an empty INTERNAL_SERVER_URL as unset", () => {
    // Compose and Coolify pass empty strings for blank variables; an empty
    // base URL would otherwise make every server-side fetch relative.
    expect(
      resolveInternalServerUrl({
        INTERNAL_SERVER_URL: "",
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
      })
    ).toBe(PUBLIC_URL);
  });
});
