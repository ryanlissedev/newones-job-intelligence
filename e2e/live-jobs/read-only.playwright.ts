import { test } from "@playwright/test";

import { assertAuthenticatedLiveRun } from "./config";
import { LiveJobsEvidence } from "./evidence";
import { openLiveJobDetail } from "./job-flow";
import { preflightLiveJobsRun } from "./run-preflight";

test.describe("live /jobs read-only verification", () => {
  test.beforeAll(async () => {
    await preflightLiveJobsRun("session");
  });

  test("queries only the exact canary, opens it, and proves read routes", async ({
    page,
  }, testInfo) => {
    const config = assertAuthenticatedLiveRun();
    const evidence = new LiveJobsEvidence(page, config.baseUrl, config.apiUrl, {
      canaryId: config.canaryId,
      query: config.query,
    });

    const { screenshotAttestation, visualAttestation } =
      await openLiveJobDetail({ config, page, query: config.query });

    await evidence.assertObservedRoutes(
      [
        {
          label: "source catalog",
          method: "GET",
          path: "/v1/bronnen",
          status: 200,
        },
        {
          label: "Boolean search",
          method: "POST",
          path: "/v1/aanvragen/search",
          status: 200,
        },
        {
          label: "search result hydration",
          method: "POST",
          path: "/v1/aanvragen/batch",
          status: 200,
        },
        {
          label: "job detail",
          method: "GET",
          path: "/v1/aanvragen/:id",
          status: 200,
        },
        {
          label: "provenance versions",
          method: "GET",
          path: "/v1/aanvragen/:id/versies",
          status: 200,
        },
        {
          label: "raw preview",
          method: "GET",
          path: "/v1/raw/:ref",
          status: 200,
        },
      ],
      screenshotAttestation
    );
    evidence.assertNoBrowserFailures();
    await evidence.attachPassed(testInfo, page, {
      releaseSha: config.expectedReleaseSha,
      screenshotAttestation,
      visualAttestation,
    });
  });
});
