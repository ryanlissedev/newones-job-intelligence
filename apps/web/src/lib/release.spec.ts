import { describe, expect, it } from "bun:test";

import { releaseResponse } from "./release";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";

describe("web release identity", () => {
  it("returns the exact configured Git SHA without caching", async () => {
    const response = releaseResponse(releaseSha);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ releaseSha });
  });

  it("refuses to claim an identity when no release SHA is configured", async () => {
    const response = releaseResponse();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ releaseSha: null });
  });

  it("refuses a value that is not a full lowercase Git SHA", async () => {
    const response = releaseResponse("main");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ releaseSha: null });
  });
});
