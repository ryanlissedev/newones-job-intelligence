import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  assertKpiSnapshotMatchesDom,
  kpiSnapshotFromOverview,
} from "./bron-dashboard-parity";
import type { BronDashboardOverviewLike } from "./bron-dashboard-parity";
import { assertAuthenticatedLiveRun } from "./config";
import { LiveJobsEvidence } from "./evidence";
import { preflightLiveJobsRun } from "./run-preflight";

const kpiValue = async (page: Page, id: string): Promise<string> => {
  const value = await page
    .getByTestId(`bronnen-kpi-${id}`)
    .locator(".font-mono")
    .textContent();
  if (value === null) {
    throw new Error(`Missing KPI text for bronnen-kpi-${id}`);
  }
  return value;
};

test.describe("operator live /bronnen verification (RJC-416)", () => {
  test.beforeAll(async () => {
    await preflightLiveJobsRun("session");
  });

  test("shows KPIs and matches get_dashboard_overview for the same window", async ({
    page,
    request,
  }, testInfo) => {
    const config = assertAuthenticatedLiveRun();
    const evidence = new LiveJobsEvidence(page, config.baseUrl, config.apiUrl);
    const window = "7d";

    const navigation = await page.goto(
      `${config.baseUrl}/bronnen?window=${window}`,
      { waitUntil: "domcontentloaded" }
    );
    if (
      !navigation ||
      navigation.status() !== 200 ||
      new URL(page.url()).pathname !== "/bronnen"
    ) {
      throw new Error(
        "Operator live bron-dashboard E2E did not reach /bronnen with HTTP 200."
      );
    }

    await expect(
      page.getByRole("heading", { exact: true, name: "Bronnen" })
    ).toBeVisible({ timeout: config.timeoutMs });
    await expect(page.getByTestId("bronnen-kpi-runs")).toBeVisible({
      timeout: config.timeoutMs,
    });
    await expect(page.getByText("Bronkaarten", { exact: true })).toBeVisible({
      timeout: config.timeoutMs,
    });

    await page.waitForLoadState("networkidle", { timeout: config.timeoutMs });

    const overviewResponse = await request.get(
      `${config.apiUrl}/v1/dashboard?window=${window}`,
      { timeout: config.timeoutMs }
    );
    if (!overviewResponse.ok()) {
      throw new Error(
        `get_dashboard_overview HTTP ${overviewResponse.status()} for window=${window}`
      );
    }
    const overviewJson: unknown = await overviewResponse.json();
    // SAFETY: live dashboard JSON is shaped by get_dashboard_overview Zod output;
    // kpiSnapshotFromOverview only reads total counts + bron attention fields.
    const overview = overviewJson as BronDashboardOverviewLike;
    const expected = kpiSnapshotFromOverview(overview);

    const dom = {
      aandacht: await kpiValue(page, "aandacht"),
      gewijzigd: await kpiValue(page, "gewijzigd"),
      nieuw: await kpiValue(page, "nieuw"),
      ongewijzigd: await kpiValue(page, "ongewijzigd"),
      rejected: await kpiValue(page, "rejected"),
      runs: await kpiValue(page, "runs"),
      successPercent: await kpiValue(page, "success"),
    };
    assertKpiSnapshotMatchesDom(expected, dom);

    await evidence.assertObservedRoutes([
      {
        label: "bronnen page",
        method: "GET",
        path: "/bronnen",
        status: 200,
      },
    ]);
    evidence.assertNoBrowserFailures();
    await evidence.attachPassed(testInfo, page, {
      releaseSha: config.expectedReleaseSha,
    });
  });
});
