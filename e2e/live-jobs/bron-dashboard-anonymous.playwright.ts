import { expect, test } from "@playwright/test";

import { assertAnonymousLiveRun } from "./config";
import { LiveJobsEvidence } from "./evidence";
import { preflightLiveJobsRun } from "./run-preflight";

test.describe("anonymous live /bronnen verification (RJC-416)", () => {
  test.beforeAll(async () => {
    await preflightLiveJobsRun("anonymous");
  });

  test("redirects anonymous visitors away from /bronnen", async ({
    page,
  }, testInfo) => {
    const config = assertAnonymousLiveRun();
    const evidence = new LiveJobsEvidence(page, config.baseUrl, config.apiUrl);

    await page.goto(`${config.baseUrl}/bronnen`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle", { timeout: config.timeoutMs });

    const finalUrl = new URL(page.url());
    expect(finalUrl.origin).toBe(config.baseUrl);
    expect(finalUrl.pathname).not.toBe("/bronnen");
    expect(finalUrl.pathname.startsWith("/bronnen/")).toBe(false);

    // Unauthenticated callers must not receive capability dashboard JSON.
    await evidence.assertNoCapabilityRequests();
    evidence.assertNoBrowserFailures();
    await evidence.attachPassed(testInfo, page, {
      releaseSha: config.expectedReleaseSha,
    });
  });
});
