import { describe, expect, it } from "bun:test";

import type { Page, PageScreenshotOptions, TestInfo } from "@playwright/test";
import { z } from "zod";

import { readLiveJobsArtifactPolicy } from "./artifact-policy";
import {
  assertCanaryBatchResponse,
  assertCanaryDetailResponse,
  assertCanarySearchResponse,
  canonicalCanaryDigest,
  issueCanaryVisualAttestation,
  isCanaryScreenshotAttestation,
} from "./canary";
import type { CanaryJsonValue } from "./canary";
import { assertAnonymousLiveRun, assertMutationLiveRun } from "./config";
import type { LiveJobsEnvironment } from "./config";
import {
  assertAllowedCapabilityRequests,
  hasForbiddenBrowserAuthHeader,
  LiveJobsEvidence,
  prepareCanaryDomForCapture,
} from "./evidence";
import {
  cleanupLiveJobsMutations,
  createMutationAttemptLedger,
} from "./mutation-cleanup";
import type { SanitizedMutationError } from "./mutation-errors";
import {
  safeMutationFailure,
  throwSanitizedMutationFailures,
} from "./mutation-errors";
import { preflightReleaseIdentity } from "./release-preflight";
import { preflightLiveJobsRun } from "./run-preflight";

const canaryId = "00000000-0000-4000-8000-000000000001";
const releaseSha = "0123456789abcdef0123456789abcdef01234567";

interface FakeRequest {
  readonly headers: () => Record<string, string>;
  readonly method: () => string;
  readonly postDataJSON: () => CanaryJsonValue;
  readonly url: () => string;
}

interface FakeResponse {
  readonly json: () => Promise<CanaryJsonValue>;
  readonly request: () => FakeRequest & { readonly redirectedFrom: () => null };
  readonly status: () => number;
  readonly url: () => string;
}

type EvidenceListener = (value: FakeRequest | FakeResponse) => void;

const fakeRequest = (
  targetUrl: string,
  method = "GET",
  body: CanaryJsonValue = null
): FakeRequest => ({
  headers: () => ({}),
  method: () => method,
  postDataJSON: () => body,
  url: () => targetUrl,
});

const fakeResponse = (
  targetUrl: string,
  method: string,
  body: CanaryJsonValue
): FakeResponse => ({
  json: () => Promise.resolve(body),
  request: () => ({
    ...fakeRequest(targetUrl, method),
    redirectedFrom: () => null,
  }),
  status: () => 200,
  url: () => targetUrl,
});

const evidenceBundleSchema = z.object({
  attachments: z.array(
    z
      .object({
        body: z.unknown().optional(),
        bodyBase64: z.string().optional(),
        name: z.string(),
      })
      .passthrough()
  ),
});

class FakeEvidencePage {
  attachedRequest: FakeRequest | null = null;
  closed = false;
  content = "verified live canary UI";
  failPrepareLiveDom = false;
  finishRequestDuringScreenshot = false;
  private readonly jobUrl = `https://jobs.example/jobs?job=${canaryId}`;
  private readonly listeners = new Map<string, Set<EvidenceListener>>();
  maskLocatorCount = 2;
  sanitized = false;
  screenshotCalled = false;
  screenshotOptions: PageScreenshotOptions | null = null;

  readonly close = (): Promise<void> => {
    this.closed = true;
    if (this.attachedRequest) {
      this.emit("requestfinished", this.attachedRequest);
    }
    return Promise.resolve();
  };

  emit(event: string, value: FakeRequest | FakeResponse): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value);
    }
  }

  readonly getByLabel = () => ({
    count: () => Promise.resolve(this.closed ? 0 : 1),
  });

  readonly isClosed = (): boolean => this.closed;

  readonly locator = (selector: string) => ({
    count: () => Promise.resolve(this.locatorCount(selector)),
    evaluate: () => {
      if (this.failPrepareLiveDom) {
        return Promise.reject(new Error("unsafe live DOM detail"));
      }
      this.sanitized = true;
      return Promise.resolve({
        canaryDetailCount: 1,
        detailCount: 1,
        maskedSurfaceCount: 2,
        resultCount: 2,
      });
    },
  });

  private locatorCount(selector: string): number {
    if (this.closed) {
      return 0;
    }
    if (selector === "pre") {
      return 1;
    }
    if (
      selector === '[data-live-jobs-evidence="sanitized"]' &&
      this.sanitized
    ) {
      return 1;
    }
    if (
      selector === `[data-live-jobs-canary-id="${canaryId}"]` &&
      this.sanitized
    ) {
      return 1;
    }
    if (selector === "[data-live-jobs-evidence-mask]") {
      return this.maskLocatorCount;
    }
    return 0;
  }

  off(event: string, listener: EvidenceListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  on(event: string, listener: EvidenceListener): void {
    const listeners = this.listeners.get(event) ?? new Set<EvidenceListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  readonly screenshot = (options: PageScreenshotOptions): Promise<Buffer> => {
    this.screenshotCalled = true;
    this.screenshotOptions = options;
    if (this.attachedRequest) {
      this.emit("request", this.attachedRequest);
      if (this.finishRequestDuringScreenshot) {
        this.emit("requestfinished", this.attachedRequest);
      }
    }
    return Promise.resolve(Buffer.from(this.content));
  };

  readonly url = (): string => this.jobUrl;

  readonly waitForLoadState = (): Promise<void> =>
    this.closed
      ? Promise.reject(new Error("fake page already closed"))
      : Promise.resolve();
}

// SAFETY: this fake implements every Page member exercised by LiveJobsEvidence.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asPage = (page: FakeEvidencePage): Page => page as unknown as Page;

interface FakeDomElement {
  readonly dataset: Record<string, string>;
  readonly closest: (selector: string) => FakeDomElement | null;
  readonly getClientRects: () => readonly unknown[];
  readonly querySelector: (selector: string) => FakeDomElement | null;
  readonly querySelectorAll: (selector: string) => readonly FakeDomElement[];
  readonly setSelection: (selector: string, elements: FakeDomElement[]) => void;
  readonly textContent: string | null;
}

const fakeDomElement = (
  options: {
    readonly hasPre?: boolean;
    readonly parent?: FakeDomElement;
    readonly textContent?: string;
    readonly visible?: boolean;
  } = {}
): FakeDomElement => {
  const selections = new Map<string, FakeDomElement[]>();
  return {
    closest: (selector) =>
      selector === "aside, dialog" ? (options.parent ?? null) : null,
    dataset: {},
    getClientRects: () => (options.visible ? [{}] : []),
    querySelector: (selector) => {
      if (selector === "pre" && options.hasPre) {
        return fakeDomElement();
      }
      return selections.get(selector)?.[0] ?? null;
    },
    querySelectorAll: (selector) => selections.get(selector) ?? [],
    setSelection: (selector, elements) => {
      selections.set(selector, elements);
    },
    textContent: options.textContent ?? null,
  };
};

// SAFETY: the fake implements the HTMLElement members used by the pure DOM
// preparation helper, allowing the masking algorithm itself to be tested.
const asHtmlElement = (element: FakeDomElement): HTMLElement =>
  element as never;

const issueCanaryAttestation = async () => {
  const aanvraag = {
    id: canaryId,
    rawPayloadRef: "safe-canary-ref",
    titel: "Safe canary",
  };
  return await assertCanaryDetailResponse(
    { aanvraag },
    canaryId,
    await canonicalCanaryDigest(aanvraag)
  );
};

const remoteEnvironment = {
  E2E_API_URL: "https://api.jobs.example",
  E2E_BASE_URL: "https://jobs.example",
  E2E_EXPECTED_RELEASE_SHA: releaseSha,
  E2E_LIVE: "1",
} satisfies LiveJobsEnvironment;

const mutationEnvironment = {
  E2E_ALLOW_WRITES: "1",
  E2E_API_URL: "http://localhost:3000",
  E2E_AUTH_MODE: "session",
  E2E_BASE_URL: "http://localhost:3001",
  E2E_CANARY_DIGEST:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  E2E_CANARY_ID: canaryId,
  E2E_CLEANUP_TOKEN: "test-token-from-environment",
  E2E_CLEANUP_URL: "http://localhost:3000/e2e/cleanup",
  E2E_DATA_MODE: "canary",
  E2E_EXPECTED_RELEASE_SHA: releaseSha,
  E2E_EXPECTED_SUBJECT_ID: "dedicated-test-account",
  E2E_LIVE: "1",
  E2E_LOCAL_MODE: "1",
  E2E_QUERY: "canary record",
  E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
  E2E_TEST_ACCOUNT_ID: "dedicated-test-account",
  E2E_TEST_ENV: "isolated",
  E2E_TEST_NAMESPACE: "e2e-20260902-write",
} satisfies LiveJobsEnvironment;

describe("live jobs E2E canary and artifact boundaries", () => {
  it("masks every result and non-canary detail without trusting DOM order", () => {
    const resultRegion = fakeDomElement();
    const nonCanaryResult = fakeDomElement();
    const renderedCanaryResult = fakeDomElement();
    resultRegion.setSelection("tbody > tr, article", [
      nonCanaryResult,
      renderedCanaryResult,
    ]);

    const nonCanaryDetail = fakeDomElement({ hasPre: true });
    const canaryDetail = fakeDomElement({ hasPre: true });
    const hiddenNonCanaryTitle = fakeDomElement({
      parent: nonCanaryDetail,
      textContent: "Wrong detail",
    });
    const visibleCanaryTitle = fakeDomElement({
      parent: canaryDetail,
      textContent: "Verified canary",
      visible: true,
    });
    const main = fakeDomElement();
    main.setSelection('[aria-label="Zoekresultaten"]', [resultRegion]);
    main.setSelection("#desktop-job-detail-title, #overlay-job-detail-title", [
      hiddenNonCanaryTitle,
      visibleCanaryTitle,
    ]);
    main.setSelection("aside, dialog", [nonCanaryDetail, canaryDetail]);

    const prepared = prepareCanaryDomForCapture(asHtmlElement(main), canaryId);

    expect(prepared).toEqual({
      canaryDetailCount: 1,
      detailCount: 2,
      maskedSurfaceCount: 3,
      resultCount: 2,
    });
    expect(nonCanaryResult.dataset.liveJobsEvidenceMask).toBe(
      "unverified-result"
    );
    expect(renderedCanaryResult.dataset.liveJobsEvidenceMask).toBe(
      "unverified-result"
    );
    expect(nonCanaryDetail.dataset.liveJobsEvidenceMask).toBe(
      "non-canary-detail"
    );
    expect(canaryDetail.dataset.liveJobsEvidenceMask).toBeUndefined();
    expect(canaryDetail.dataset.liveJobsCanaryId).toBe(canaryId);
    expect(main.dataset.liveJobsEvidence).toBe("sanitized");
  });

  it("fails closed when more than one canary detail is visible", () => {
    const resultRegion = fakeDomElement();
    resultRegion.setSelection("tbody > tr, article", [fakeDomElement()]);
    const firstDetail = fakeDomElement({ hasPre: true });
    const secondDetail = fakeDomElement({ hasPre: true });
    const main = fakeDomElement();
    main.setSelection('[aria-label="Zoekresultaten"]', [resultRegion]);
    main.setSelection("#desktop-job-detail-title, #overlay-job-detail-title", [
      fakeDomElement({
        parent: firstDetail,
        textContent: "First",
        visible: true,
      }),
      fakeDomElement({
        parent: secondDetail,
        textContent: "Second",
        visible: true,
      }),
    ]);
    main.setSelection("aside, dialog", [firstDetail, secondDetail]);

    expect(() =>
      prepareCanaryDomForCapture(asHtmlElement(main), canaryId)
    ).toThrow(/missing or ambiguous/u);
    expect(main.dataset.liveJobsEvidence).toBeUndefined();
  });

  it("rejects a response where a production record is listed first", () => {
    expect(() =>
      assertCanarySearchResponse(
        { ids: ["11111111-1111-4111-8111-111111111111", canaryId] },
        canaryId
      )
    ).toThrow(/exactly the configured canary/u);
  });

  it("accepts only a one-item search and batch response for the exact canary", () => {
    expect(() =>
      assertCanarySearchResponse({ ids: [canaryId] }, canaryId)
    ).not.toThrow();
    expect(() =>
      assertCanaryBatchResponse(
        { items: [{ aanvraag: { id: canaryId }, id: canaryId }] },
        canaryId
      )
    ).not.toThrow();
    expect(() =>
      assertCanaryBatchResponse(
        {
          items: [
            {
              aanvraag: { id: "11111111-1111-4111-8111-111111111111" },
              id: "11111111-1111-4111-8111-111111111111",
            },
          ],
        },
        canaryId
      )
    ).toThrow(/exactly the configured record/u);
  });

  it("issues screenshot attestation only after the pinned detail digest matches", async () => {
    const aanvraag = {
      id: canaryId,
      rawPayloadRef: "safe-canary-ref",
      titel: "Safe canary",
    };
    const digest = await canonicalCanaryDigest(aanvraag);
    const reorderedDigest = await canonicalCanaryDigest({
      id: aanvraag.id,
      rawPayloadRef: aanvraag.rawPayloadRef,
      titel: aanvraag.titel,
    });

    expect(reorderedDigest).toBe(digest);
    const attestation = await assertCanaryDetailResponse(
      { aanvraag },
      canaryId,
      digest
    );
    expect(isCanaryScreenshotAttestation(attestation)).toBe(true);
    expect(
      isCanaryScreenshotAttestation({
        canaryId,
        digest,
        rawPayloadRef: aanvraag.rawPayloadRef,
      })
    ).toBe(false);
    await expect(
      assertCanaryDetailResponse(
        { aanvraag },
        canaryId,
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      )
    ).rejects.toThrow(/E2E_CANARY_DIGEST/u);
  });

  it("keeps traces off for remote and local isolated runs", () => {
    expect(readLiveJobsArtifactPolicy(remoteEnvironment)).toEqual({
      screenshot: "off",
      trace: "off",
      video: "off",
    });
    expect(
      readLiveJobsArtifactPolicy({
        E2E_LOCAL_MODE: "1",
        E2E_TEST_ENV: "isolated",
      })
    ).toEqual({
      screenshot: "off",
      trace: "off",
      video: "off",
    });
    expect(readLiveJobsArtifactPolicy({ E2E_LOCAL_MODE: "1" })).toEqual({
      screenshot: "off",
      trace: "off",
      video: "off",
    });
  });

  it("fails closed on every unexpected capability method and path", () => {
    const allowlist = [
      {
        label: "search",
        method: "POST",
        path: "/v1/aanvragen/search",
        status: 200,
      },
    ];

    expect(() =>
      assertAllowedCapabilityRequests(
        [{ method: "POST", path: "/v1/aanvragen/search" }],
        allowlist
      )
    ).not.toThrow();
    expect(() =>
      assertAllowedCapabilityRequests(
        [{ method: "DELETE", path: "/v1/aanvragen/search" }],
        allowlist
      )
    ).toThrow(/outside its exact allowlist/u);
    expect(() =>
      assertAllowedCapabilityRequests(
        [{ method: "POST", path: "/v1/:unexpected" }],
        allowlist
      )
    ).toThrow(/outside its exact allowlist/u);
    expect(() =>
      assertAllowedCapabilityRequests(
        [{ method: "POST", path: "/v1/snapshots" }],
        allowlist
      )
    ).toThrow(/outside its exact allowlist/u);
  });

  it("rejects off-origin capability traffic before route sanitization", async () => {
    const attestation = await issueCanaryAttestation();
    const fakePage = new FakeEvidencePage();
    const page = asPage(fakePage);
    const evidence = new LiveJobsEvidence(
      page,
      "https://jobs.example",
      "https://api.jobs.example"
    );
    const request = fakeRequest("https://attacker.example/v1/aanvragen/search");
    fakePage.emit("request", request);
    fakePage.emit("requestfinished", request);

    await expect(
      evidence.assertObservedRoutes([], attestation)
    ).rejects.toThrow(/outside the configured API origin/u);
  });

  it("rejects wrong dynamic canary ids and raw references", async () => {
    const attestation = await issueCanaryAttestation();
    await Promise.all(
      [
        "https://api.jobs.example/v1/aanvragen/11111111-1111-4111-8111-111111111111",
        "https://api.jobs.example/v1/raw/wrong-ref",
      ].map(async (targetUrl) => {
        const fakePage = new FakeEvidencePage();
        const page = asPage(fakePage);
        const evidence = new LiveJobsEvidence(
          page,
          "https://jobs.example",
          "https://api.jobs.example"
        );
        const request = fakeRequest(targetUrl);
        fakePage.emit("request", request);
        fakePage.emit("requestfinished", request);

        await expect(
          evidence.assertObservedRoutes([], attestation)
        ).rejects.toThrow(/different canary identity/u);
      })
    );
  });

  it("rejects duplicate allowed requests and every out-of-scope request payload", async () => {
    const attestation = await issueCanaryAttestation();
    const scope = { canaryId, query: "exact canary query" };
    const searchUrl = "https://api.jobs.example/v1/aanvragen/search";
    const duplicatePage = new FakeEvidencePage();
    const duplicateEvidence = new LiveJobsEvidence(
      asPage(duplicatePage),
      "https://jobs.example",
      "https://api.jobs.example",
      scope
    );
    for (const request of [
      fakeRequest(searchUrl, "POST", { query: scope.query }),
      fakeRequest(searchUrl, "POST", { query: scope.query }),
    ]) {
      duplicatePage.emit("request", request);
      duplicatePage.emit("requestfinished", request);
    }
    await expect(
      duplicateEvidence.assertObservedRoutes(
        [
          {
            label: "search",
            method: "POST",
            path: "/v1/aanvragen/search",
            status: 200,
          },
        ],
        attestation
      )
    ).rejects.toThrow(/exactly one request/u);

    const invalidRequests: readonly {
      readonly body: CanaryJsonValue;
      readonly targetUrl: string;
    }[] = [
      { body: { query: "different query" }, targetUrl: searchUrl },
      {
        body: { ids: ["11111111-1111-4111-8111-111111111111"] },
        targetUrl: "https://api.jobs.example/v1/aanvragen/batch",
      },
    ];
    await Promise.all(
      invalidRequests.map(async ({ body, targetUrl }) => {
        const fakePage = new FakeEvidencePage();
        const evidence = new LiveJobsEvidence(
          asPage(fakePage),
          "https://jobs.example",
          "https://api.jobs.example",
          scope
        );
        const request = fakeRequest(targetUrl, "POST", body);
        fakePage.emit("request", request);
        fakePage.emit("requestfinished", request);
        await expect(
          evidence.assertObservedRoutes([], attestation)
        ).rejects.toThrow(/outside the configured canary scope/u);
      })
    );
  });

  it("validates every search and batch response rather than only the first match", async () => {
    const attestation = await issueCanaryAttestation();
    const scope = { canaryId, query: "exact canary query" };
    const wrongId = "11111111-1111-4111-8111-111111111111";
    const cases: readonly {
      readonly path: string;
      readonly requestBody: CanaryJsonValue;
      readonly validResponse: CanaryJsonValue;
      readonly wrongResponse: CanaryJsonValue;
    }[] = [
      {
        path: "/v1/aanvragen/search",
        requestBody: { query: scope.query },
        validResponse: { ids: [canaryId] },
        wrongResponse: { ids: [wrongId] },
      },
      {
        path: "/v1/aanvragen/batch",
        requestBody: { ids: [canaryId] },
        validResponse: {
          items: [{ aanvraag: { id: canaryId }, id: canaryId }],
        },
        wrongResponse: {
          items: [{ aanvraag: { id: wrongId }, id: wrongId }],
        },
      },
    ];

    await Promise.all(
      cases.map(async (testCase) => {
        const targetUrl = `https://api.jobs.example${testCase.path}`;
        const fakePage = new FakeEvidencePage();
        const evidence = new LiveJobsEvidence(
          asPage(fakePage),
          "https://jobs.example",
          "https://api.jobs.example",
          scope
        );
        const request = fakeRequest(targetUrl, "POST", testCase.requestBody);
        fakePage.emit("request", request);
        fakePage.emit(
          "response",
          fakeResponse(targetUrl, "POST", testCase.validResponse)
        );
        fakePage.emit(
          "response",
          fakeResponse(targetUrl, "POST", testCase.wrongResponse)
        );
        fakePage.emit("requestfinished", request);

        await expect(
          evidence.assertObservedRoutes(
            [
              {
                label: "canary route",
                method: "POST",
                path: testCase.path,
                status: 200,
              },
            ],
            attestation
          )
        ).rejects.toThrow(/outside the configured canary scope/u);
      })
    );
  });

  it("retains only boolean payload proof for validated canary requests", async () => {
    const scope = { canaryId, query: "private exact query" };
    const searchUrl = "https://api.jobs.example/v1/aanvragen/search";
    const fakePage = new FakeEvidencePage();
    const page = asPage(fakePage);
    const evidence = new LiveJobsEvidence(
      page,
      "https://jobs.example",
      "https://api.jobs.example",
      scope
    );
    const request = fakeRequest(searchUrl, "POST", { query: scope.query });
    fakePage.emit("request", request);
    fakePage.emit(
      "response",
      fakeResponse(searchUrl, "POST", { ids: [canaryId] })
    );
    fakePage.emit("requestfinished", request);
    await evidence.assertObservedRoutes([
      {
        label: "search",
        method: "POST",
        path: "/v1/aanvragen/search",
        status: 200,
      },
    ]);
    const attachments: string[] = [];
    const recordingTestInfo = {
      attach: (_name: string, options: { readonly body?: Buffer | string }) => {
        attachments.push(String(options.body));
        return Promise.resolve();
      },
    };
    // SAFETY: LiveJobsEvidence uses only TestInfo.attach in this regression.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const testInfo = recordingTestInfo as unknown as TestInfo;

    await evidence.attachPassed(testInfo, page, { releaseSha });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toContain('"payloadValidated": true');
    expect(attachments[0]).not.toContain(scope.query);
    expect(attachments[0]).not.toContain(canaryId);
  });

  it("publishes nothing when an otherwise allowed request starts during screenshot capture", async () => {
    const attestation = await issueCanaryAttestation();
    const fakePage = new FakeEvidencePage();
    fakePage.attachedRequest = fakeRequest("https://jobs.example/favicon.ico");
    fakePage.finishRequestDuringScreenshot = true;
    const page = asPage(fakePage);
    const evidence = new LiveJobsEvidence(
      page,
      "https://jobs.example",
      "https://api.jobs.example"
    );
    await evidence.assertObservedRoutes([], attestation);
    let attachmentCount = 0;
    const recordingTestInfo = {
      attach: () => {
        attachmentCount += 1;
        return Promise.resolve();
      },
    };
    // SAFETY: LiveJobsEvidence uses only TestInfo.attach in this regression.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const testInfo = recordingTestInfo as unknown as TestInfo;

    await expect(
      evidence.attachPassed(testInfo, page, {
        releaseSha,
        screenshotAttestation: attestation,
        visualAttestation: issueCanaryVisualAttestation(attestation),
      })
    ).rejects.toThrow(/request start during screenshot capture/u);
    expect(fakePage.screenshotCalled).toBe(true);
    expect(fakePage.closed).toBe(true);
    expect(attachmentCount).toBe(0);
  });

  it("refuses screenshot capture until the network has zero pending requests", async () => {
    const attestation = await issueCanaryAttestation();
    const fakePage = new FakeEvidencePage();
    const page = asPage(fakePage);
    const evidence = new LiveJobsEvidence(
      page,
      "https://jobs.example",
      "https://api.jobs.example"
    );
    fakePage.emit(
      "request",
      fakeRequest("https://jobs.example/still-loading.css")
    );
    await evidence.assertObservedRoutes([], attestation);
    let attachmentCount = 0;
    const recordingTestInfo = {
      attach: () => {
        attachmentCount += 1;
        return Promise.resolve();
      },
    };
    // SAFETY: LiveJobsEvidence uses only TestInfo.attach in this regression.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const testInfo = recordingTestInfo as unknown as TestInfo;

    await expect(
      evidence.attachPassed(testInfo, page, {
        releaseSha,
        screenshotAttestation: attestation,
        visualAttestation: issueCanaryVisualAttestation(attestation),
      })
    ).rejects.toThrow(/network requests were pending/u);
    expect(fakePage.screenshotCalled).toBe(false);
    expect(fakePage.closed).toBe(true);
    expect(attachmentCount).toBe(0);
  });

  it("publishes one final sanitized bundle after closing the page", async () => {
    const attestation = await issueCanaryAttestation();
    const fakePage = new FakeEvidencePage();
    const page = asPage(fakePage);
    const evidence = new LiveJobsEvidence(
      page,
      "https://jobs.example",
      "https://api.jobs.example"
    );
    await evidence.assertObservedRoutes([], attestation);
    const attachments: string[] = [];
    const recordingTestInfo = {
      attach: (_name: string, options: { readonly body?: Buffer | string }) => {
        attachments.push(String(options.body));
        return Promise.resolve();
      },
    };
    // SAFETY: LiveJobsEvidence uses only TestInfo.attach in this regression.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const testInfo = recordingTestInfo as unknown as TestInfo;

    await evidence.attachPassed(testInfo, page, {
      releaseSha,
      screenshotAttestation: attestation,
      visualAttestation: issueCanaryVisualAttestation(attestation),
    });

    expect(fakePage.closed).toBe(true);
    expect(fakePage.sanitized).toBe(true);
    expect(fakePage.screenshotOptions).toMatchObject({
      animations: "disabled",
      fullPage: true,
      mask: expect.any(Array),
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toContain("pass-manifest.json");
    expect(attachments[0]).toContain(canaryId);
    expect(attachments[0]).toContain(releaseSha);
    expect(attachments[0]).toContain("captureStartedAt");
    expect(attachments[0]).toContain("capturedAt");
    expect(attachments[0]).not.toContain(attestation.rawPayloadRef);
    expect(attachments[0]).not.toContain("api.jobs.example");
    expect(attachments[0]).not.toContain("account-name");
    expect(attachments[0]).not.toContain("response-title");
    expect(attachments[0]).not.toContain("secret-query");
    const bundle = evidenceBundleSchema.parse(
      JSON.parse(attachments[0] ?? "{}")
    );
    const screenshotBody = bundle.attachments?.find(
      (attachment) => attachment.bodyBase64
    )?.bodyBase64;
    expect(screenshotBody).toBeTruthy();
    const decodedScreenshot = Buffer.from(
      screenshotBody ?? "",
      "base64"
    ).toString();
    expect(decodedScreenshot).toContain("verified live canary UI");
    const manifest = bundle.attachments.find(
      (attachment) => attachment.name === "pass-manifest.json"
    );
    expect(manifest?.body).toMatchObject({
      releaseSha,
      status: "passed",
      visualEvidence: {
        canaryId,
        evidenceAttribute: "sanitized",
      },
    });
  });

  it("publishes nothing when the live canary DOM cannot be prepared", async () => {
    const attestation = await issueCanaryAttestation();
    const fakePage = new FakeEvidencePage();
    fakePage.failPrepareLiveDom = true;
    const page = asPage(fakePage);
    const evidence = new LiveJobsEvidence(
      page,
      "https://jobs.example",
      "https://api.jobs.example"
    );
    await evidence.assertObservedRoutes([], attestation);
    let attachmentCount = 0;
    const recordingTestInfo = {
      attach: () => {
        attachmentCount += 1;
        return Promise.resolve();
      },
    };
    // SAFETY: LiveJobsEvidence uses only TestInfo.attach in this regression.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const testInfo = recordingTestInfo as unknown as TestInfo;

    await expect(
      evidence.attachPassed(testInfo, page, {
        releaseSha,
        screenshotAttestation: attestation,
        visualAttestation: issueCanaryVisualAttestation(attestation),
      })
    ).rejects.toThrow(/could not prepare and capture/u);
    expect(fakePage.closed).toBe(true);
    expect(attachmentCount).toBe(0);
  });

  it("publishes nothing when the mask locator misses a prepared surface", async () => {
    const attestation = await issueCanaryAttestation();
    const fakePage = new FakeEvidencePage();
    fakePage.maskLocatorCount = 1;
    const page = asPage(fakePage);
    const evidence = new LiveJobsEvidence(
      page,
      "https://jobs.example",
      "https://api.jobs.example"
    );
    await evidence.assertObservedRoutes([], attestation);
    let attachmentCount = 0;
    const recordingTestInfo = {
      attach: () => {
        attachmentCount += 1;
        return Promise.resolve();
      },
    };
    // SAFETY: LiveJobsEvidence uses only TestInfo.attach in this regression.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const testInfo = recordingTestInfo as unknown as TestInfo;

    await expect(
      evidence.attachPassed(testInfo, page, {
        releaseSha,
        screenshotAttestation: attestation,
        visualAttestation: issueCanaryVisualAttestation(attestation),
      })
    ).rejects.toThrow(/could not prepare and capture/u);
    expect(fakePage.screenshotCalled).toBe(false);
    expect(fakePage.closed).toBe(true);
    expect(attachmentCount).toBe(0);
  });

  it("restores the full attempted-write scope despite a lost resource response", async () => {
    const config = assertMutationLiveRun(mutationEnvironment);
    const attemptedWrites = createMutationAttemptLedger();
    attemptedWrites.markering = true;
    attemptedWrites.savedSearch = true;
    attemptedWrites.snapshot = true;
    let cleanupCalls = 0;

    const receipt = await cleanupLiveJobsMutations({
      attemptedWrites,
      baseline: { token: "safe-baseline-token" },
      config,
      observedResources: [{ id: "observed-search-id", kind: "saved-search" }],
      request: {
        post: (url, options) => {
          cleanupCalls += 1;
          expect(url).toBe(config.cleanupUrl);
          expect(options.maxRedirects).toBe(0);
          expect(options.data).toEqual({
            action: "restore-baseline-and-verify",
            attemptedWrites: {
              markering: true,
              savedSearch: true,
              snapshot: true,
            },
            baselineToken: "safe-baseline-token",
            observedResources: [
              { id: "observed-search-id", kind: "saved-search" },
            ],
            scope: {
              accountId: config.testAccountId,
              canaryId: config.canaryId,
              namespace: config.testNamespace,
            },
          });
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                baselineRestored: true,
                residualRunWrites: {
                  markering: 0,
                  savedSearch: 0,
                  snapshot: 0,
                },
                status: "clean",
              }),
            status: () => 200,
            url: () => config.cleanupUrl,
          });
        },
      },
    });

    expect(cleanupCalls).toBe(1);
    expect(receipt).toEqual({
      attemptedKinds: ["markering", "saved-search", "snapshot"],
      baselineRestored: true,
      residueCount: 0,
      status: 200,
    });
  });

  it("fails cleanup on residue or a malformed receipt with safe typed metadata", async () => {
    const config = assertMutationLiveRun(mutationEnvironment);
    const attemptedWrites = createMutationAttemptLedger();
    attemptedWrites.snapshot = true;
    const cleanup = (payload: CanaryJsonValue) =>
      cleanupLiveJobsMutations({
        attemptedWrites,
        baseline: { token: "safe-baseline-token" },
        config,
        observedResources: [],
        request: {
          post: () =>
            Promise.resolve({
              json: () => Promise.resolve(payload),
              status: () => 200,
              url: () => config.cleanupUrl,
            }),
        },
      });

    await expect(
      cleanup({
        baselineRestored: true,
        residualRunWrites: {
          markering: 0,
          savedSearch: 0,
          snapshot: 1,
        },
        status: "residue",
      })
    ).rejects.toMatchObject({ code: "cleanup-residue", phase: "cleanup" });
    await expect(
      cleanup({ unexpected: "unsafe response omitted" })
    ).rejects.toMatchObject({
      code: "cleanup-invalid-response",
      phase: "cleanup",
    });
  });

  it("preserves primary and cleanup failure classes without unsafe details", () => {
    const sanitizedFallback = safeMutationFailure(
      new Error(
        "POST https://api.secret.example/v1/snapshots body=private selector=#identity token=credential"
      ),
      { code: "mutation-assertion-failed", phase: "create-snapshot" }
    );
    expect(sanitizedFallback).toEqual({
      code: "mutation-assertion-failed",
      phase: "create-snapshot",
    });

    let caught: unknown;
    try {
      throwSanitizedMutationFailures({
        cleanupFailure: {
          code: "cleanup-residue",
          phase: "cleanup",
        },
        primaryFailure: {
          code: "mutation-assertion-failed",
          phase: "save-search",
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) {
      throw new Error("Expected sanitized AggregateError.");
    }
    const aggregate = caught;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.message).toBe(
      "Live jobs mutation and cleanup both failed with sanitized typed metadata."
    );
    expect(
      aggregate.errors.map((error: SanitizedMutationError) => ({
        code: error.code,
        phase: error.phase,
      }))
    ).toEqual([
      { code: "mutation-assertion-failed", phase: "save-search" },
      { code: "cleanup-residue", phase: "cleanup" },
    ]);
    expect(JSON.stringify(aggregate)).not.toContain("https://");
  });

  it("flags legacy role-bearing browser headers without retaining values", () => {
    expect(
      hasForbiddenBrowserAuthHeader({
        Authorization: "Bearer recruiter:dedicated-test-account",
      })
    ).toBe(true);
    expect(
      hasForbiddenBrowserAuthHeader({ "X-Caller-Role": "recruiter" })
    ).toBe(true);
    expect(hasForbiddenBrowserAuthHeader({ Accept: "application/json" })).toBe(
      false
    );
  });

  it("requires exact server release identity with redirects disabled", async () => {
    const config = assertAnonymousLiveRun({
      ...remoteEnvironment,
      E2E_AUTH_MODE: "anonymous",
    });
    let requestInit: RequestInit | undefined;

    await preflightReleaseIdentity(config, {
      fetcher: (_input, init) => {
        requestInit = init;
        return Promise.resolve({
          json: () => Promise.resolve({ releaseSha }),
          status: 200,
          url: "https://api.jobs.example/version",
        });
      },
    });

    expect(requestInit?.redirect).toBe("error");
    await expect(
      preflightReleaseIdentity(config, {
        fetcher: () =>
          Promise.resolve({
            json: () => Promise.resolve({ releaseSha }),
            status: 200,
            url: "https://api.jobs.example/version/redirected",
          }),
      })
    ).rejects.toThrow(/exact 200/u);
    await expect(
      preflightReleaseIdentity(config, {
        fetcher: () =>
          Promise.resolve({
            json: () =>
              Promise.resolve({ releaseSha: releaseSha.replace("0", "f") }),
            status: 200,
            url: "https://api.jobs.example/version",
          }),
      })
    ).rejects.toThrow(/does not exactly match/u);
  });

  it("returns the captured cleanup baseline from write preflight", async () => {
    const result = await preflightLiveJobsRun("writes", mutationEnvironment, {
      cleanupPreflight: () => Promise.resolve({ token: "safe-baseline-token" }),
      releasePreflight: () => Promise.resolve(),
      sessionVerifier: () =>
        Promise.resolve({ subjectId: "dedicated-test-account" }),
    });

    expect(result.cleanupBaseline).toEqual({ token: "safe-baseline-token" });
  });

  it("never reaches cleanup when the derived session subject mismatches", async () => {
    let cleanupCalls = 0;

    await expect(
      preflightLiveJobsRun("writes", mutationEnvironment, {
        cleanupPreflight: () => {
          cleanupCalls += 1;
          return Promise.resolve({ token: "safe-baseline-token" });
        },
        releasePreflight: () => Promise.resolve(),
        sessionVerifier: () =>
          Promise.resolve({ subjectId: "different-account" }),
      })
    ).rejects.toThrow(/E2E_EXPECTED_SUBJECT_ID/u);

    expect(cleanupCalls).toBe(0);
  });

  it("propagates a sanitized session-verifier failure before browser start", async () => {
    await expect(
      preflightLiveJobsRun("session", mutationEnvironment, {
        releasePreflight: () => Promise.resolve(),
        sessionVerifier: () =>
          Promise.reject(
            new Error(
              "Better Auth session verification failed; no browser evidence or writes were attempted."
            )
          ),
      })
    ).rejects.toThrow(/session verification failed/u);
  });
});
