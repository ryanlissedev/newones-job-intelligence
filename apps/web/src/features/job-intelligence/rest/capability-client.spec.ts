import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createCapabilityClient } from "./capability-client";

const originalFetch = globalThis.fetch;
const requests: RequestInit[] = [];

describe("browser capability authentication", () => {
  beforeAll(() => {
    const fetchStub: typeof globalThis.fetch = (_input, init) => {
      requests.push(init ?? {});
      return Promise.resolve(Response.json({ ok: true }));
    };
    globalThis.fetch = fetchStub;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses the Better Auth cookie and never fabricates a role header", async () => {
    requests.length = 0;
    const client = createCapabilityClient({ baseUrl: "http://server.test" });

    await client.get("/v1/bronnen");
    await client.post("/v1/saved-searches", { query: "Azure" });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.credentials).toBe("include");
      expect(new Headers(request.headers).has("Authorization")).toBe(false);
    }
  });

  it("forwards caller headers on GET without dropping Accept", async () => {
    requests.length = 0;
    const client = createCapabilityClient({ baseUrl: "http://server.test" });

    await client.get("/v1/dashboard?window=7d", {
      headers: { Cookie: "session=test" },
    });

    expect(requests).toHaveLength(1);
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe("session=test");
  });
});
