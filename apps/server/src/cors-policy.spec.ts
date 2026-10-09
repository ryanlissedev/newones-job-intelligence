import { describe, expect, it } from "bun:test";

import { Hono } from "hono";

import { apiCors, CORS_PREFLIGHT_MAX_AGE_SECONDS } from "./cors-policy";

const WEB_ORIGIN = "https://web.example.test";

const createFixture = () => {
  const app = new Hono();
  app.use("/*", apiCors(WEB_ORIGIN));
  app.post("/v1/aanvragen/search", (context) => context.json({ ok: true }));
  return app;
};

const preflight = (origin: string) =>
  createFixture().request("http://api.example.test/v1/aanvragen/search", {
    headers: {
      "Access-Control-Request-Headers": "content-type",
      "Access-Control-Request-Method": "POST",
      Origin: origin,
    },
    method: "OPTIONS",
  });

describe("API CORS policy", () => {
  it("lets the browser cache the preflight for the web origin", async () => {
    const response = await preflight(WEB_ORIGIN);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Max-Age")).toBe(
      String(CORS_PREFLIGHT_MAX_AGE_SECONDS)
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      WEB_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
  });

  it("does not grant another origin", async () => {
    const response = await preflight("https://evil.example.test");

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps simple requests credentialed for the web origin", async () => {
    const response = await createFixture().request(
      "http://api.example.test/v1/aanvragen/search",
      { headers: { Origin: WEB_ORIGIN }, method: "POST" }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      WEB_ORIGIN
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
  });
});
