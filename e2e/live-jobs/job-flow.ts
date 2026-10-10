/// <reference lib="dom" />

import { expect } from "@playwright/test";
import type { Locator, Page, Response } from "@playwright/test";

import {
  assertCanaryBatchResponse,
  assertCanaryDetailResponse,
  assertCanarySearchResponse,
  canaryJsonValueSchema,
  issueCanaryVisualAttestation,
} from "./canary";
import type {
  CanaryJsonValue,
  CanaryScreenshotAttestation,
  CanaryVisualAttestation,
} from "./canary";
import { buildCanaryJobsUrl } from "./config";
import type { AuthenticatedLiveJobsConfig } from "./config";

interface OpenLiveJobDetailInput {
  readonly config: AuthenticatedLiveJobsConfig;
  readonly page: Page;
  readonly query: string;
}

export const getLiveJobDetailRegion = (page: Page): Locator =>
  page
    .locator("main#main-content aside")
    .filter({ has: page.locator("#desktop-job-detail-title") });

const matchesApiResponse = (
  response: Response,
  apiUrl: string,
  method: string,
  path: string
): boolean => {
  const url = new URL(response.url());
  return (
    url.origin === new URL(apiUrl).origin &&
    response.request().method() === method &&
    url.pathname === path
  );
};

const requireExactNavigation = (
  response: Response | null,
  expectedUrl: string,
  actualUrl: string
): void => {
  const expected = new URL(expectedUrl);
  const actual = new URL(actualUrl);
  const selectedId = actual.searchParams.get("job");
  const query = actual.searchParams.get("q");
  if (
    !response ||
    response.status() !== 200 ||
    response.url() !== expectedUrl ||
    response.request().redirectedFrom() !== null ||
    actual.origin !== expected.origin ||
    actual.pathname !== "/jobs" ||
    selectedId !== expected.searchParams.get("job") ||
    query !== expected.searchParams.get("q")
  ) {
    throw new Error(
      "Live jobs E2E did not reach the exact /jobs canary URL with an unredirected HTTP 200 response."
    );
  }
};

const readJson = async (
  response: Response,
  label: string
): Promise<CanaryJsonValue> => {
  if (
    response.status() !== 200 ||
    response.request().redirectedFrom() !== null
  ) {
    throw new Error(
      `${label} did not return an unredirected exact HTTP 200 response.`
    );
  }
  try {
    const parsed = canaryJsonValueSchema.safeParse(await response.json());
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // The response boundary remains deliberately opaque when parsing fails.
  }
  throw new Error(`${label} did not return JSON.`);
};

/**
 * Deep-link directly to the immutable canary id. We never click the first
 * result: any search/batch payload that lists another record is rejected
 * before the test can create an artifact.
 */
export const openLiveJobDetail = async ({
  config,
  page,
  query,
}: OpenLiveJobDetailInput): Promise<{
  readonly jobId: string;
  readonly screenshotAttestation: CanaryScreenshotAttestation;
  readonly visualAttestation: CanaryVisualAttestation;
}> => {
  const jobsUrl = buildCanaryJobsUrl(config.baseUrl, query, config.canaryId);
  const searchResponse = page.waitForResponse(
    (response) =>
      matchesApiResponse(
        response,
        config.apiUrl,
        "POST",
        "/v1/aanvragen/search"
      ),
    { timeout: config.timeoutMs }
  );
  const batchResponse = page.waitForResponse(
    (response) =>
      matchesApiResponse(
        response,
        config.apiUrl,
        "POST",
        "/v1/aanvragen/batch"
      ),
    { timeout: config.timeoutMs }
  );
  const detailResponse = page.waitForResponse(
    (response) =>
      matchesApiResponse(
        response,
        config.apiUrl,
        "GET",
        `/v1/aanvragen/${encodeURIComponent(config.canaryId)}`
      ),
    { timeout: config.timeoutMs }
  );

  const navigation = await page.goto(jobsUrl, {
    waitUntil: "domcontentloaded",
  });
  requireExactNavigation(navigation, jobsUrl, page.url());

  const [search, batch, detail] = await Promise.all([
    searchResponse,
    batchResponse,
    detailResponse,
  ]);
  assertCanarySearchResponse(
    await readJson(search, "Canary search response"),
    config.canaryId
  );
  assertCanaryBatchResponse(
    await readJson(batch, "Canary batch response"),
    config.canaryId
  );
  const screenshotAttestation = await assertCanaryDetailResponse(
    await readJson(detail, "Canary detail response"),
    config.canaryId,
    config.canaryDigest
  );
  const detailRegion = getLiveJobDetailRegion(page);
  const mainRegion = page.locator("main#main-content");
  const provenanceRegion = detailRegion.getByRole("article");
  const resultRegion = mainRegion.getByLabel("Zoekresultaten");
  const toolbarSummaryRegion = mainRegion
    .getByRole("heading", { exact: true, name: "Opdrachten" })
    .locator("..");

  await expect(
    toolbarSummaryRegion.getByText("Live · U7 REST", { exact: true })
  ).toBeVisible({ timeout: config.timeoutMs });
  await expect(
    toolbarSummaryRegion.getByText("Previewdata · fixtures", { exact: true })
  ).toHaveCount(0);
  await expect(resultRegion).toBeVisible({ timeout: config.timeoutMs });
  await expect(
    detailRegion.getByRole("heading", { exact: true, name: "Herkomst" })
  ).toBeVisible({ timeout: config.timeoutMs });
  await expect(provenanceRegion).toHaveCount(1);
  await expect(
    provenanceRegion.getByText("bron_referentie", { exact: true })
  ).toBeVisible({ timeout: config.timeoutMs });
  await expect(
    detailRegion.getByText("Raw preview", { exact: true })
  ).toBeVisible({ timeout: config.timeoutMs });
  await expect(
    detailRegion.getByText("Immutable bronpayload via read_raw (preview).", {
      exact: true,
    })
  ).toBeVisible({ timeout: config.timeoutMs });

  return {
    jobId: config.canaryId,
    screenshotAttestation,
    visualAttestation: issueCanaryVisualAttestation(screenshotAttestation),
  };
};
