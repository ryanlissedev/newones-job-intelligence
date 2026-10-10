import { describe, expect, it } from "bun:test";

import { Hono } from "hono";

import { jsonBodyLimit, JSON_BODY_LIMIT_BYTES } from "./request-body-limit";

const createFixture = (path: "/mcp" | "/v1/sourcing/assessment") => {
  const app = new Hono();
  app.use(path, jsonBodyLimit());
  app.post(path, (context) => context.json({ accepted: true }));
  return app;
};

describe("JSON request body boundary", () => {
  it("rejects oversized REST assessment bodies before the handler runs", async () => {
    const app = createFixture("/v1/sourcing/assessment");
    const response = await app.request(
      "http://server.test/v1/sourcing/assessment",
      {
        body: JSON.stringify({ value: "x".repeat(JSON_BODY_LIMIT_BYTES) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "REQUEST_BODY_TOO_LARGE",
        message: "Request body exceeds the maximum size",
      },
      ok: false,
    });
  });

  it("applies the same bounded body contract to MCP requests", async () => {
    const app = createFixture("/mcp");
    const response = await app.request("http://server.test/mcp", {
      body: JSON.stringify({ value: "x".repeat(JSON_BODY_LIMIT_BYTES) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "REQUEST_BODY_TOO_LARGE" },
      ok: false,
    });
  });

  it("allows a bounded JSON body through the boundary", async () => {
    const app = createFixture("/v1/sourcing/assessment");
    const response = await app.request(
      "http://server.test/v1/sourcing/assessment",
      {
        body: JSON.stringify({ value: "bounded" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
  });
});
