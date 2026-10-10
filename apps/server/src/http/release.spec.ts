import { describe, expect, it } from "bun:test";

import { Hono } from "hono";

import { createReleaseHandler } from "./release";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";

describe("release identity route", () => {
  it("returns the exact configured Git SHA without caching", async () => {
    const app = new Hono();
    app.get("/version", createReleaseHandler(releaseSha));

    const response = await app.request("http://server.test/version");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ releaseSha });
  });

  it("refuses to claim an identity when APP_RELEASE_SHA is absent", async () => {
    const app = new Hono();
    app.get("/version", createReleaseHandler());

    const response = await app.request("http://server.test/version");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ releaseSha: null });
  });
});
