import { expect, test } from "@playwright/test";
import type { Response as PlaywrightResponse } from "@playwright/test";
import { z } from "zod";

import type {
  CanaryScreenshotAttestation,
  CanaryVisualAttestation,
} from "./canary";
import { assertMutationLiveRun, buildNamespacedQuery } from "./config";
import { LiveJobsEvidence } from "./evidence";
import type { SanitizedCleanupReceipt } from "./evidence";
import { getLiveJobDetailRegion, openLiveJobDetail } from "./job-flow";
import {
  cleanupLiveJobsMutations,
  createMutationAttemptLedger,
} from "./mutation-cleanup";
import type {
  MutationCleanupBaseline,
  MutationResource,
} from "./mutation-cleanup";
import {
  safeMutationFailure,
  throwSanitizedMutationFailures,
} from "./mutation-errors";
import type { MutationFailure, MutationFailurePhase } from "./mutation-errors";
import { preflightLiveJobsRun } from "./run-preflight";

const isApiResponse = (
  response: {
    readonly request: () => { readonly method: () => string };
    readonly url: () => string;
  },
  apiUrl: string,
  method: string,
  pathname: string
): boolean => {
  const url = new URL(response.url());
  return (
    url.origin === new URL(apiUrl).origin &&
    response.request().method() === method &&
    url.pathname === pathname
  );
};

const mutationResponseSchema = z.object({ id: z.string() });

const readId = async (
  response: PlaywrightResponse,
  resource: string
): Promise<string> => {
  const parsed = mutationResponseSchema.safeParse(await response.json());
  if (parsed.success) {
    return parsed.data.id;
  }
  throw new Error(`${resource} response did not contain an id.`);
};

test.describe("isolated live /jobs mutation verification", () => {
  let cleanupBaseline: MutationCleanupBaseline | undefined;

  test.beforeAll(async () => {
    const { cleanupBaseline: capturedBaseline } =
      await preflightLiveJobsRun("writes");
    cleanupBaseline = capturedBaseline;
  });

  test("marks one canary, saves a namespaced search, snapshots it, and cleans up", async ({
    page,
    request,
  }, testInfo) => {
    const config = assertMutationLiveRun();
    if (!cleanupBaseline) {
      throw new Error(
        "Live jobs mutation cleanup baseline was not captured before browser writes."
      );
    }
    const namespacedQuery = buildNamespacedQuery(
      config.testNamespace,
      config.query
    );
    const evidence = new LiveJobsEvidence(page, config.baseUrl, config.apiUrl, {
      canaryId: config.canaryId,
      query: namespacedQuery,
    });
    const attemptedWrites = createMutationAttemptLedger();
    const observedResources: MutationResource[] = [];
    let failurePhase: MutationFailurePhase = "open-canary";
    let cleanupFailure: MutationFailure | undefined;
    let primaryFailure: MutationFailure | undefined;
    let screenshotAttestation: CanaryScreenshotAttestation | undefined;
    let visualAttestation: CanaryVisualAttestation | undefined;
    let cleanupReceipt: SanitizedCleanupReceipt | undefined;

    try {
      const openedJob = await openLiveJobDetail({
        config,
        page,
        query: namespacedQuery,
      });
      const {
        jobId,
        screenshotAttestation: verifiedAttestation,
        visualAttestation: verifiedVisualAttestation,
      } = openedJob;
      screenshotAttestation = verifiedAttestation;
      visualAttestation = verifiedVisualAttestation;
      const detailRegion = getLiveJobDetailRegion(page);
      const mainRegion = page.locator("main#main-content");

      failurePhase = "mark-canary";
      const markResponse = page.waitForResponse((response) =>
        isApiResponse(
          response,
          config.apiUrl,
          "POST",
          `/v1/aanvragen/${jobId}/markering`
        )
      );
      attemptedWrites.markering = true;
      await detailRegion
        .getByRole("button", { name: /markeren als relevant/iu })
        .click();
      const markering = await markResponse;
      expect(markering.status()).toBe(200);
      await expect(detailRegion.getByText(/Markering:/u)).toBeVisible({
        timeout: config.timeoutMs,
      });

      failurePhase = "save-search";
      const savedSearchResponse = page.waitForResponse((response) =>
        isApiResponse(response, config.apiUrl, "POST", "/v1/saved-searches")
      );
      attemptedWrites.savedSearch = true;
      await mainRegion
        .getByRole("button", { exact: true, name: "Zoekopdracht opslaan" })
        .click();
      const savedSearch = await savedSearchResponse;
      expect(savedSearch.status()).toBe(200);
      observedResources.push({
        id: await readId(savedSearch, "Saved search"),
        kind: "saved-search",
      });
      await expect(mainRegion.getByText(/Opgeslagen als/u)).toBeVisible({
        timeout: config.timeoutMs,
      });

      failurePhase = "create-snapshot";
      const snapshotResponse = page.waitForResponse((response) =>
        isApiResponse(response, config.apiUrl, "POST", "/v1/snapshots")
      );
      attemptedWrites.snapshot = true;
      await mainRegion
        .getByRole("button", { exact: true, name: "Snapshot maken" })
        .click();
      const snapshot = await snapshotResponse;
      expect(snapshot.status()).toBe(200);
      observedResources.push({
        id: await readId(snapshot, "Snapshot"),
        kind: "snapshot",
      });
      await expect(mainRegion.getByText(/Snapshot aangemaakt/u)).toBeVisible({
        timeout: config.timeoutMs,
      });

      failurePhase = "route-assertion";
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
          {
            label: "canary markering",
            method: "POST",
            path: "/v1/aanvragen/:id/markering",
            status: 200,
          },
          {
            label: "saved search",
            method: "POST",
            path: "/v1/saved-searches",
            status: 200,
          },
          {
            label: "snapshot",
            method: "POST",
            path: "/v1/snapshots",
            status: 200,
          },
        ],
        screenshotAttestation
      );
      evidence.assertNoBrowserFailures();
    } catch {
      primaryFailure = {
        code: "mutation-assertion-failed",
        phase: failurePhase,
      };
    }

    try {
      cleanupReceipt = await cleanupLiveJobsMutations({
        attemptedWrites,
        baseline: cleanupBaseline,
        config,
        observedResources,
        request,
      });
    } catch (error) {
      cleanupFailure =
        error instanceof Error
          ? safeMutationFailure(error, {
              code: "cleanup-request-failed",
              phase: "cleanup",
            })
          : { code: "cleanup-request-failed", phase: "cleanup" };
    }
    throwSanitizedMutationFailures({ cleanupFailure, primaryFailure });

    if (!screenshotAttestation || !visualAttestation) {
      throw new Error(
        "Live jobs mutation passed without a canary screenshot attestation."
      );
    }

    const passedEvidence = {
      cleanupReceipt,
      releaseSha: config.expectedReleaseSha,
      screenshotAttestation,
      visualAttestation,
    };
    await evidence.attachPassed(testInfo, page, passedEvidence);
  });
});
