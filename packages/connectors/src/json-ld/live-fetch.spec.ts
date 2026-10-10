import { afterEach, describe, expect, it } from "bun:test";

import {
  BROWSER_LIKE_HEADERS,
  buildLiveFetchHeaders,
  cloudflareChallengeError,
  cookieEnvVarForLiveGate,
  isCloudflareChallenge,
  readLiveHtmlOrThrow,
  readOpsCookieHeader,
} from "./live-fetch";

const COOKIE_ENV = "WERKZOEKEN_COOKIE";

afterEach(() => {
  delete process.env.WERKZOEKEN_COOKIE;
});

describe("cookieEnvVarForLiveGate", () => {
  it("pairs *_LIVE with *_COOKIE", () => {
    expect(cookieEnvVarForLiveGate("WERKZOEKEN_LIVE")).toBe(
      "WERKZOEKEN_COOKIE"
    );
    expect(cookieEnvVarForLiveGate("BLUETRAIL_LIVE")).toBe("BLUETRAIL_COOKIE");
  });

  it("returns null when the live gate is missing or not *_LIVE", () => {
    expect(cookieEnvVarForLiveGate()).toBeNull();
    expect(cookieEnvVarForLiveGate("WERKZOEKEN")).toBeNull();
  });
});

describe("readOpsCookieHeader", () => {
  it("returns null when unset or blank", () => {
    expect(readOpsCookieHeader(COOKIE_ENV)).toBeNull();
    process.env[COOKIE_ENV] = "   ";
    expect(readOpsCookieHeader(COOKIE_ENV)).toBeNull();
  });

  it("returns the trimmed cookie value", () => {
    process.env[COOKIE_ENV] = " cf_clearance=abc; __cf_bm=def ";
    expect(readOpsCookieHeader(COOKIE_ENV)).toBe(
      "cf_clearance=abc; __cf_bm=def"
    );
  });
});

describe("buildLiveFetchHeaders", () => {
  it("always includes browser-like defaults", () => {
    expect(buildLiveFetchHeaders()).toMatchObject(BROWSER_LIKE_HEADERS);
    expect(buildLiveFetchHeaders().Cookie).toBeUndefined();
  });

  it("prefers an explicit cookieHeader over the env value", () => {
    process.env[COOKIE_ENV] = "from-env=1";
    expect(
      buildLiveFetchHeaders({
        cookieHeader: "from-option=1",
        liveEnvVar: "WERKZOEKEN_LIVE",
      }).Cookie
    ).toBe("from-option=1");
  });

  it("reads the ops cookie env when no option is set", () => {
    process.env[COOKIE_ENV] = "cf_clearance=xyz";
    expect(
      buildLiveFetchHeaders({ liveEnvVar: "WERKZOEKEN_LIVE" }).Cookie
    ).toBe("cf_clearance=xyz");
  });
});

describe("isCloudflareChallenge", () => {
  it("detects the cf-mitigated challenge header", () => {
    const response = new Response("blocked", {
      headers: { "cf-mitigated": "challenge" },
      status: 403,
    });
    expect(isCloudflareChallenge(response)).toBe(true);
  });

  it("detects a managed-challenge body on 403", () => {
    const response = new Response(
      "<html><title>Just a moment...</title></html>",
      { status: 403 }
    );
    expect(
      isCloudflareChallenge(response, "<html><title>Just a moment...</title>")
    ).toBe(true);
  });

  it("does not treat an ordinary 403 as a challenge", () => {
    const response = new Response("Forbidden", { status: 403 });
    expect(isCloudflareChallenge(response, "Forbidden")).toBe(false);
  });
});

describe("readLiveHtmlOrThrow", () => {
  it("returns the body for a successful response", async () => {
    const response = new Response("<html>ok</html>", { status: 200 });
    await expect(
      readLiveHtmlOrThrow({
        cookieEnvVar: COOKIE_ENV,
        response,
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).resolves.toBe("<html>ok</html>");
  });

  it("throws an ops-actionable error on a Cloudflare challenge", async () => {
    const response = new Response("<title>Just a moment...</title>", {
      headers: { "cf-mitigated": "challenge" },
      status: 403,
    });
    await expect(
      readLiveHtmlOrThrow({
        cookieEnvVar: COOKIE_ENV,
        response,
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).rejects.toThrow(/Cloudflare managed challenge/u);
    await expect(
      readLiveHtmlOrThrow({
        cookieEnvVar: COOKIE_ENV,
        response: new Response("<title>Just a moment...</title>", {
          headers: { "cf-mitigated": "challenge" },
          status: 403,
        }),
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).rejects.toThrow(/WERKZOEKEN_COOKIE/u);
  });

  it("still fails closed on non-challenge HTTP errors", async () => {
    const response = new Response("nope", { status: 500 });
    await expect(
      readLiveHtmlOrThrow({
        cookieEnvVar: null,
        response,
        slug: "werkzoeken",
        url: "https://www.werkzoeken.nl/x",
      })
    ).rejects.toThrow(/status 500/u);
  });
});

describe("cloudflareChallengeError", () => {
  it("points at the runbook and forbids CAPTCHA solvers", () => {
    const error = cloudflareChallengeError({
      cookieEnvVar: COOKIE_ENV,
      slug: "werkzoeken",
      url: "https://www.werkzoeken.nl/",
    });
    expect(error.message).toContain("docs/sources/werkzoeken.md");
    expect(error.message).toContain("Do not use CAPTCHA solvers");
  });
});
