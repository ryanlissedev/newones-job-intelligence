import { describe, expect, test } from "bun:test";

import {
  assertConsentJarPath,
  cookiesForUrl,
  detectPrivacyGate,
  fetchBronUrlWithConsent,
  hasJobPostingLd,
  parseNationaleVacaturebankUrl,
} from "./dpg-consent-fetch";
import type { DpgStorageState } from "./dpg-consent-fetch";

const SAMPLE_URL =
  "https://www.nationalevacaturebank.nl/vacature/cebb5f92-419d-4813-8df2-12f1b3646876/adviseur-vergunningverlening-ontgrondingen";

const jarOutside = "/tmp/catapulze-dpg-consent-test-storage-state.json";
const worktreeRoot = "/workspace/wt-ctp530";

const sampleJar = (): DpgStorageState => ({
  cookies: [
    {
      domain: ".nationalevacaturebank.nl",
      name: "OptanonConsent",
      path: "/",
      secure: true,
      value: "isGpcEnabled=0",
    },
  ],
});

describe("assertConsentJarPath", () => {
  test("requires an absolute path outside the worktree", () => {
    expect(() => assertConsentJarPath(undefined, worktreeRoot)).toThrow(
      /DPG_CONSENT_STORAGE_STATE is required/u
    );
    expect(() =>
      assertConsentJarPath("relative/jar.json", worktreeRoot)
    ).toThrow(/absolute path outside/u);
    expect(() =>
      assertConsentJarPath(`${worktreeRoot}/secrets/jar.json`, worktreeRoot)
    ).toThrow(/absolute path outside/u);
    expect(assertConsentJarPath(jarOutside, worktreeRoot)).toBe(jarOutside);
  });
});

describe("parseNationaleVacaturebankUrl", () => {
  test("accepts NVB https URLs only", () => {
    expect(parseNationaleVacaturebankUrl(SAMPLE_URL).hostname).toBe(
      "www.nationalevacaturebank.nl"
    );
    expect(() => parseNationaleVacaturebankUrl("http://example.com")).toThrow(
      /https/u
    );
    expect(() =>
      parseNationaleVacaturebankUrl("https://example.com/vacature/1")
    ).toThrow(/nationalevacaturebank/u);
  });
});

describe("detectPrivacyGate", () => {
  test("treats 403 as gated", () => {
    expect(detectPrivacyGate("", 403)).toEqual({
      gated: true,
      markers: ["http_403"],
    });
  });

  test("treats DPG consent wall without JobPosting as gated", () => {
    const body =
      "<html><title>DPG Media</title><button>Akkoord</button></html>";
    const result = detectPrivacyGate(body, 200);
    expect(result.gated).toBe(true);
    expect(result.markers.length).toBeGreaterThan(0);
  });

  test("allows vacancy HTML with JobPosting even if DPG is mentioned", () => {
    const body = `<html><script type="application/ld+json">{"@type":"JobPosting","title":"x"}</script><p>DPG Media</p></html>`;
    expect(detectPrivacyGate(body, 200).gated).toBe(false);
    expect(hasJobPostingLd(body)).toBe(true);
  });
});

describe("cookiesForUrl", () => {
  test("selects NVB cookies and drops expired ones", () => {
    const now = new Date("2026-09-16T00:00:00Z");
    const selected = cookiesForUrl(
      {
        cookies: [
          {
            domain: ".nationalevacaturebank.nl",
            expires: 1_900_000_000,
            name: "consent",
            path: "/",
            secure: true,
            value: "yes",
          },
          {
            domain: ".nationalevacaturebank.nl",
            expires: 1000,
            name: "stale",
            path: "/",
            secure: true,
            value: "no",
          },
          {
            domain: "other.example",
            name: "x",
            path: "/",
            secure: true,
            value: "y",
          },
        ],
      },
      new URL(SAMPLE_URL),
      now
    );
    expect(selected).toEqual([{ name: "consent", value: "yes" }]);
  });
});

describe("fetchBronUrlWithConsent", () => {
  test("fails closed without a jar", async () => {
    const { result } = await fetchBronUrlWithConsent(SAMPLE_URL, "", {
      worktreeRoot,
    });
    expect(result.disposition).toBe("missing_jar");
  });

  test("sends Cookie header from the consented jar and reports ok", async () => {
    let seenCookie: string | null = null;
    const { result } = await fetchBronUrlWithConsent(SAMPLE_URL, jarOutside, {
      fetcher: (_input, init) => {
        const headers = new Headers(init.headers);
        seenCookie = headers.get("Cookie");
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              `<html><script type="application/ld+json">{"@type":"JobPosting"}</script></html>`
            ),
        });
      },
      readStorageState: () => Promise.resolve(sampleJar()),
      worktreeRoot,
    });
    expect(seenCookie).toBe("OptanonConsent=isGpcEnabled=0");
    expect(result.disposition).toBe("ok");
    expect(result.hasJobPosting).toBe(true);
  });

  test("reports gated when the response is still the privacy wall", async () => {
    const { result } = await fetchBronUrlWithConsent(SAMPLE_URL, jarOutside, {
      fetcher: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              "<html><h1>DPG Media Privacy</h1><button>Akkoord</button></html>"
            ),
        }),
      readStorageState: () =>
        Promise.resolve({
          cookies: [
            {
              domain: ".nationalevacaturebank.nl",
              name: "session",
              path: "/",
              secure: true,
              value: "abc",
            },
          ],
        }),
      worktreeRoot,
    });
    expect(result.disposition).toBe("gated");
  });
});
